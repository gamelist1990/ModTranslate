use std::{
    collections::HashMap,
    sync::Arc,
    time::Duration,
};

use futures::{future::BoxFuture, FutureExt};
use regex::Regex;
use serde::Deserialize;
use tokio::sync::{Mutex, Semaphore};

use super::TranslateConfig;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Free,
    GoogleCloud,
    Gas,
    DeepL,
    ClaudeAi,
}

#[derive(Debug, Clone, thiserror::Error)]
pub enum TranslateError {
    #[error("HTTP {status}: {message}")]
    Http { status: u16, message: String },
    #[error("Request failed: {0}")]
    Request(String),
    #[error("Retry failed: {label} failed: {cause}")]
    RetryFailed { label: String, cause: String },
    #[error("GOOGLE_TRANSLATE_API_KEY is not set")]
    MissingApiKey,
    #[error("DEEPL_API_KEY is not set")]
    MissingDeepLKey,
    #[error("Aborted")]
    Aborted,
}

const CLAUDE_OPENAI_COMPAT_BASE_URL: &str = "https://capi.voids.top/v2/";
const CLAUDE_OPENAI_COMPAT_API_KEY: &str = "yajuu_no_kokoro_no_naka_ni_aru_sa_www";
const CLAUDE_OPENAI_COMPAT_MODELS: [&str; 4] = [
    "claude-opus-4-5",
    "claude-haiku-4-5-20251001",
    "claude-haiku-4.5",
    "claude-sonnet-4.5",
];

fn extract_json_array_str(s: &str) -> Option<&str> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end <= start {
        return None;
    }
    Some(&s[start..=end])
}

fn clamp_u32(v: Option<u32>, min: u32, max: u32, fallback: u32) -> u32 {
    let v = v.unwrap_or(fallback);
    v.clamp(min, max)
}

fn to_google_lang(mc_lang: &str) -> String {
    let stem = mc_lang.trim().trim_end_matches(".json").to_lowercase();
    let parts: Vec<&str> = stem.split('_').collect();
    parts.first().copied().unwrap_or(stem.as_str()).to_string()
}

fn to_deepl_lang(mc_lang: &str) -> String {
    let stem = mc_lang.trim().trim_end_matches(".json").to_lowercase();
    let parts: Vec<&str> = stem.split('_').collect();
    let primary = parts.first().copied().unwrap_or(stem.as_str());
    let secondary = parts.get(1).copied();

    match (primary, secondary) {
        ("zh", _) => "ZH".to_string(),
        ("en", Some("us")) => "EN-US".to_string(),
        ("en", Some("gb")) => "EN-GB".to_string(),
        ("pt", Some("br")) => "PT-BR".to_string(),
        (p, Some(s)) if matches!(p, "en" | "pt") => format!("{}-{}", p.to_uppercase(), s.to_uppercase()),
        (p, _) => p.to_uppercase(),
    }
}

const DEFAULT_GAS_URL: &str = "https://script.google.com/macros/s/AKfycbxPh_IjkSYpkfxHoGXVzK4oNQ2Vy0uRByGeNGA6ti3M7flAMCYkeJKuoBrALNCMImEi_g/exec";

fn is_retryable_status(status: u16) -> bool {
    matches!(status, 408 | 425 | 429 | 500 | 502 | 503 | 504)
}

fn is_retryable_message(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "fetch failed",
        "econnreset",
        "etimedout",
        "timeout",
        "tempor",
        "network",
        "aborted",
        "socket",
        "dns",
        "503",
        "502",
        "500",
        "504",
        "429",
        "rate",
        "too many",
        "quota",
    ]
    .iter()
    .any(|k| m.contains(k))
}

fn is_likely_google_api_error(e: &TranslateError) -> bool {
    match e {
        TranslateError::Http { .. } => true,
        TranslateError::Request(msg) => {
            let m = msg.to_lowercase();
            m.contains("http")
                || m.contains("fetch failed")
                || m.contains("translate")
                || m.contains("google_translate_api_key")
                || m.contains("network")
                || m.contains("timeout")
                || m.contains("aborted")
        }
        _ => false,
    }
}

async fn with_retry<T, Fut>(mut f: impl FnMut() -> Fut, label: &str) -> Result<T, TranslateError>
where
    Fut: std::future::Future<Output = Result<T, TranslateError>>,
{
    let mut last: Option<TranslateError> = None;
    let max_attempts = 6;

    for attempt in 0..max_attempts {
        match f().await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let retryable = match &e {
                    TranslateError::Http { status, .. } => is_retryable_status(*status),
                    TranslateError::Request(msg) => is_retryable_message(msg),
                    _ => false,
                };

                if !retryable {
                    last = Some(e);
                    break;
                }

                last = Some(e);

                let backoff = (400u64.saturating_mul(2u64.saturating_pow(attempt as u32))).min(30_000);
                let jitter = (fastrand::u64(..250)) as u64;
                tokio::time::sleep(Duration::from_millis(backoff + jitter)).await;
            }
        }
    }

    let cause = last
        .map(|e| e.to_string())
        .unwrap_or_else(|| "unknown".to_string());
    Err(TranslateError::RetryFailed {
        label: label.to_string(),
        cause,
    })
}

async fn translate_free(text: &str, source: &str, target: &str) -> Result<String, TranslateError> {
    let mut url = reqwest::Url::parse("https://translate.googleapis.com/translate_a/single")
        .map_err(|e| TranslateError::Request(e.to_string()))?;
    {
        let mut qp = url.query_pairs_mut();
        qp.append_pair("client", "gtx");
        qp.append_pair("sl", source);
        qp.append_pair("tl", target);
        qp.append_pair("dt", "t");
        qp.append_pair("q", text);
    }

    let client = reqwest::Client::new();
    let res = client
        .get(url)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    if !res.status().is_success() {
        return Err(TranslateError::Http {
            status: res.status().as_u16(),
            message: res.status().to_string(),
        });
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let mut out = String::new();
    if let Some(chunks) = data.get(0).and_then(|v| v.as_array()) {
        for c in chunks {
            if let Some(s) = c.get(0).and_then(|v| v.as_str()) {
                out.push_str(s);
            }
        }
        return Ok(out);
    }

    Ok(text.to_string())
}

async fn translate_google_cloud(text: &str, source: &str, target: &str, api_key: &str) -> Result<String, TranslateError> {
    let mut url = reqwest::Url::parse("https://translation.googleapis.com/language/translate/v2")
        .map_err(|e| TranslateError::Request(e.to_string()))?;
    url.query_pairs_mut().append_pair("key", api_key);

    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .json(&serde_json::json!({"q": text, "source": source, "target": target, "format": "text"}))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    if !res.status().is_success() {
        return Err(TranslateError::Http {
            status: res.status().as_u16(),
            message: res.status().to_string(),
        });
    }

    let data: serde_json::Value = res
        .json()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let translated = data
        .get("data")
        .and_then(|v| v.get("translations"))
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("translatedText"))
        .and_then(|v| v.as_str())
        .unwrap_or(text);

    Ok(translated
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&"))
}

#[derive(Debug, Deserialize)]
struct GasResp {
    translation: Option<String>,
}

async fn translate_via_gas(text: &str, source: &str, target: &str, gas_url: &str) -> Result<String, TranslateError> {
    let url = reqwest::Url::parse(gas_url).map_err(|e| TranslateError::Request(e.to_string()))?;

    let client = reqwest::Client::new();
    let res = client
        .post(url)
        .json(&serde_json::json!({"text": text, "from": source, "to": target}))
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    if !res.status().is_success() {
        return Err(TranslateError::Http {
            status: res.status().as_u16(),
            message: res.status().to_string(),
        });
    }

    let data: GasResp = res
        .json()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let translated = data.translation.unwrap_or_default();
    if translated.trim().is_empty() {
        return Err(TranslateError::Request("翻訳結果が取得できませんでした。".to_string()));
    }

    Ok(translated)
}

#[derive(Debug, Deserialize)]
struct DeepLTranslation {
    text: String,
}

#[derive(Debug, Deserialize)]
struct DeepLResp {
    translations: Vec<DeepLTranslation>,
}

async fn translate_deepl(text: &str, source: &str, target: &str, api_key: &str) -> Result<String, TranslateError> {
    let key = api_key.trim();
    if key.is_empty() {
        return Err(TranslateError::MissingDeepLKey);
    }

    let endpoint = if key.ends_with(":fx") {
        "https://api-free.deepl.com/v2/translate"
    } else {
        "https://api.deepl.com/v2/translate"
    };

    let body = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("auth_key", key)
        .append_pair("text", text)
        .append_pair("source_lang", source)
        .append_pair("target_lang", target)
        .finish();

    let client = reqwest::Client::new();
    let res = client
        .post(endpoint)
        .header(reqwest::header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(body)
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    if !res.status().is_success() {
        let status_code = res.status().as_u16();
        let status_text = res.status().to_string();
        let msg = res.text().await.unwrap_or(status_text);
        return Err(TranslateError::Http {
            status: status_code,
            message: msg,
        });
    }

    let data: DeepLResp = res
        .json()
        .await
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let translated = data
        .translations
        .get(0)
        .map(|t| t.text.clone())
        .unwrap_or_else(|| text.to_string());
    Ok(translated)
}

async fn translate_claude_ai_openai_compat(text: &str, source: &str, target: &str) -> Result<String, TranslateError> {
    let base = reqwest::Url::parse(CLAUDE_OPENAI_COMPAT_BASE_URL).map_err(|e| TranslateError::Request(e.to_string()))?;
    let url = base
        .join("chat/completions")
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let client = reqwest::Client::new();

    let system = format!(
        "You are a translation engine. Translate from {source} to {target}. \
Return ONLY the translated text (no quotes, no markdown). \
Do NOT alter tokens like __MT0__ or __MT12__. Preserve them exactly.",
        source = source,
        target = target
    );

    let mut last_err: Option<TranslateError> = None;

    for model in CLAUDE_OPENAI_COMPAT_MODELS {
        let res = match client
            .post(url.clone())
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", CLAUDE_OPENAI_COMPAT_API_KEY))
            .json(&serde_json::json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": system.clone()},
                    {"role": "user", "content": text},
                ],
                "temperature": 0,
                "stream": false,
            }))
            .timeout(Duration::from_secs(40))
            .send()
            .await
        {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(TranslateError::Request(e.to_string()));
                continue;
            }
        };

        if !res.status().is_success() {
            let status_code = res.status().as_u16();
            let status_text = res.status().to_string();
            let msg = res.text().await.unwrap_or(status_text);
            last_err = Some(TranslateError::Http {
                status: status_code,
                message: msg,
            });
            continue;
        }

        let data: serde_json::Value = match res.json().await {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(TranslateError::Request(e.to_string()));
                continue;
            }
        };

        let content_val = data
            .get("choices")
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("message"))
            .and_then(|v| v.get("content"));

        let content = match content_val {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => {
                // Some OpenAI-compatible servers return: content: [{type:"text", text:"..."}, ...]
                let mut out = String::new();
                for p in parts {
                    if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                        out.push_str(t);
                    }
                }
                out
            }
            _ => "".to_string(),
        };

        let content = content.trim().to_string();
        if content.is_empty() {
            last_err = Some(TranslateError::Request(format!("Claude(AI) returned empty content for model: {}", model)));
            continue;
        }

        return Ok(content);
    }

    Err(last_err.unwrap_or_else(|| TranslateError::Request("Claude(AI) request failed".to_string())))
}

async fn translate_claude_ai_openai_compat_batch(texts: &[String], source: &str, target: &str) -> Result<Vec<String>, TranslateError> {
    let base = reqwest::Url::parse(CLAUDE_OPENAI_COMPAT_BASE_URL).map_err(|e| TranslateError::Request(e.to_string()))?;
    let url = base
        .join("chat/completions")
        .map_err(|e| TranslateError::Request(e.to_string()))?;

    let client = reqwest::Client::new();

    let system = format!(
        "You are a translation engine. Translate each item from {source} to {target}.\n\n\
STRICT OUTPUT FORMAT (MUST FOLLOW):\n\
- Output MUST be ONLY a valid JSON array of strings.\n\
- The array length MUST equal the input length, and order MUST match input order.\n\
- Do NOT wrap in markdown/code fences. Do NOT add explanations.\n\
- Output MUST start with '[' and end with ']'.\n\
- Do NOT alter tokens like __MT0__ or __MT12__. Preserve them exactly.\n\n\
EXAMPLE:\n\
Input: [\"Hello __MT0__\", \"Bye\"]\n\
Output: [\"こんにちは __MT0__\", \"さようなら\"]\n",
        source = source,
        target = target
    );

    let user_payload = serde_json::to_string(texts).map_err(|e| TranslateError::Request(e.to_string()))?;

    let mut last_err: Option<TranslateError> = None;
    for model in CLAUDE_OPENAI_COMPAT_MODELS {
        let res = match client
            .post(url.clone())
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {}", CLAUDE_OPENAI_COMPAT_API_KEY))
            .json(&serde_json::json!({
                "model": model,
                "messages": [
                    {"role": "system", "content": system.clone()},
                    {"role": "user", "content": user_payload.clone()},
                ],
                "temperature": 0,
                "stream": false,
            }))
            .timeout(Duration::from_secs(80))
            .send()
            .await
        {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(TranslateError::Request(e.to_string()));
                continue;
            }
        };

        if !res.status().is_success() {
            let status_code = res.status().as_u16();
            let status_text = res.status().to_string();
            let msg = res.text().await.unwrap_or(status_text);
            last_err = Some(TranslateError::Http {
                status: status_code,
                message: msg,
            });
            continue;
        }

        let data: serde_json::Value = match res.json().await {
            Ok(v) => v,
            Err(e) => {
                last_err = Some(TranslateError::Request(e.to_string()));
                continue;
            }
        };

        let content_val = data
            .get("choices")
            .and_then(|v| v.get(0))
            .and_then(|v| v.get("message"))
            .and_then(|v| v.get("content"));

        let content = match content_val {
            Some(serde_json::Value::String(s)) => s.clone(),
            Some(serde_json::Value::Array(parts)) => {
                let mut out = String::new();
                for p in parts {
                    if let Some(t) = p.get("text").and_then(|v| v.as_str()) {
                        out.push_str(t);
                    }
                }
                out
            }
            _ => "".to_string(),
        };

        let content_trim = content.trim();
        if content_trim.is_empty() {
            last_err = Some(TranslateError::Request(format!("Claude(AI) returned empty content for model: {}", model)));
            continue;
        }

        let json_str = match serde_json::from_str::<serde_json::Value>(content_trim) {
            Ok(v) => {
                // already valid JSON; re-serialize for uniform parsing below
                serde_json::to_string(&v).unwrap_or_else(|_| content_trim.to_string())
            }
            Err(_) => extract_json_array_str(content_trim).unwrap_or(content_trim).to_string(),
        };

        let arr: Vec<String> = match serde_json::from_str::<serde_json::Value>(&json_str)
            .ok()
            .and_then(|v| v.as_array().cloned())
        {
            Some(a) => {
                let mut out: Vec<String> = Vec::with_capacity(a.len());
                let mut ok = true;
                for it in a {
                    if let Some(s) = it.as_str() {
                        out.push(s.to_string());
                    } else {
                        ok = false;
                        break;
                    }
                }
                if ok { out } else { Vec::new() }
            }
            None => Vec::new(),
        };

        if arr.len() != texts.len() {
            last_err = Some(TranslateError::Request(format!(
                "Claude(AI) JSON length mismatch for model {}: expected {}, got {}",
                model,
                texts.len(),
                arr.len()
            )));
            continue;
        }

        if arr.iter().any(|s| s.trim().is_empty()) {
            last_err = Some(TranslateError::Request(format!("Claude(AI) returned empty string item for model: {}", model)));
            continue;
        }

        return Ok(arr);
    }

    Err(last_err.unwrap_or_else(|| TranslateError::Request("Claude(AI) batch request failed".to_string())))
}

fn protect_placeholders(input: &str) -> (String, Vec<(String, String)>) {
    static PATTERNS: std::sync::OnceLock<Vec<Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        vec![
            Regex::new(r"%(\d+\$)?[-+#0 ]*\d*(?:\.\d+)?[a-zA-Z]").unwrap(),
            Regex::new(r"\{\d+\}").unwrap(),
            Regex::new(r"§[0-9a-fk-or]").unwrap(),
            Regex::new(r"\n").unwrap(),
            Regex::new(r"\t").unwrap(),
            Regex::new(r"\r").unwrap(),
        ]
    });

    let mut current = input.to_string();
    let mut repls: Vec<(String, String)> = Vec::new();
    let mut index: usize = 0;

    for re in patterns {
        let mut local: Vec<(String, String)> = Vec::new();
        let replaced = re.replace_all(&current, |caps: &regex::Captures| {
            let m = caps.get(0).map(|m| m.as_str()).unwrap_or("");
            let token = format!("__MT{}__", index);
            index += 1;
            local.push((token.clone(), m.to_string()));
            token
        });
        current = replaced.to_string();
        repls.extend(local);
    }

    (current, repls)
}

fn restore_placeholders(translated: &str, repls: &[(String, String)]) -> String {
    let mut out = translated.to_string();
    for (token, original) in repls {
        out = out.replace(token, original);
    }
    out
}

fn is_formatting_only(s: &str) -> bool {
    let core = s.trim();
    if core.is_empty() {
        return true;
    }

    // If it's very short and contains no letters/digits, it's likely just formatting (arrows, bullets, etc.)
    if core.len() <= 6 && core.chars().all(|c| !c.is_alphabetic() && !c.is_numeric()) {
        return true;
    }

    false
}

fn edge_whitespace(s: &str) -> (&str, &str, &str) {
    let bytes = s.as_bytes();

    let mut start = 0usize;
    while start < bytes.len() {
        let ch = s[start..].chars().next().unwrap();
        if !(ch == ' ' || ch == '\t') {
            break;
        }
        start += ch.len_utf8();
    }

    let mut end = s.len();
    while end > start {
        let ch = s[..end].chars().next_back().unwrap();
        if !(ch == ' ' || ch == '\t') {
            break;
        }
        end -= ch.len_utf8();
    }

    (&s[..start], &s[start..end], &s[end..])
}

fn preserve_edge_whitespace(original: &str, translated: &str) -> String {
    let (opre, _, osuf) = edge_whitespace(original);
    if opre.is_empty() && osuf.is_empty() {
        return translated.to_string();
    }

    let (_, core, _) = edge_whitespace(translated);
    format!("{}{}{}", opre, core, osuf)
}

#[derive(Clone)]
pub struct Translator {
    source_google: String,
    target_google: String,
    source_deepl: String,
    target_deepl: String,
    provider_primary: Provider,
    has_cloud: bool,
    api_key: Option<String>,
    deepl_api_key: Option<String>,
    gas_url: String,
    semaphore: Arc<Semaphore>,
    concurrency: usize,
    cache: Arc<Mutex<HashMap<String, String>>>,
    inflight: Arc<Mutex<HashMap<String, futures::future::Shared<BoxFuture<'static, Result<String, TranslateError>>>>>>,
}

impl Translator {
    pub fn provider_label(&self) -> &'static str {
        match self.provider_primary {
            Provider::GoogleCloud => "google-cloud",
            Provider::Gas => "gas",
            Provider::DeepL => "deepl",
            Provider::Free => "free",
            Provider::ClaudeAi => "claude-ai",
        }
    }

    pub fn new(source_mc: &str, target_mc: &str, cfg: &TranslateConfig) -> Self {
        let source_google = to_google_lang(source_mc);
        let target_google = to_google_lang(target_mc);
        let source_deepl = to_deepl_lang(source_mc);
        let target_deepl = to_deepl_lang(target_mc);

        let api_key = cfg
            .google_api_key
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let has_cloud = api_key.is_some();

        let deepl_api_key = cfg
            .deepl_api_key
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        let provider_str = cfg.provider.as_ref().map(|s| s.to_lowercase());
        let provider_primary = match provider_str.as_deref() {
            Some("google-cloud") => Provider::GoogleCloud,
            Some("gas") => Provider::Gas,
            Some("deepl") => Provider::DeepL,
            Some("free") => Provider::Free,
            Some("claude-ai") | Some("claude") | Some("claude(ai)") => Provider::ClaudeAi,
            // auto
            _ => {
                if has_cloud {
                    Provider::GoogleCloud
                } else {
                    Provider::Free
                }
            }
        };

        let conc_default = if provider_primary == Provider::GoogleCloud { 4 } else { 3 };
        let concurrency = clamp_u32(cfg.concurrency, 1, 32, conc_default);

        let gas_url = DEFAULT_GAS_URL.to_string();

        Self {
            source_google,
            target_google,
            source_deepl,
            target_deepl,
            provider_primary,
            has_cloud,
            api_key,
            deepl_api_key,
            gas_url,
            semaphore: Arc::new(Semaphore::new(concurrency as usize)),
            concurrency: concurrency as usize,
            cache: Arc::new(Mutex::new(HashMap::new())),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn max_concurrency(&self) -> usize {
        self.concurrency
    }

    async fn translate_raw(&self, text: String, abort: &tokio_util::sync::CancellationToken) -> Result<String, TranslateError> {
        if abort.is_cancelled() {
            return Err(TranslateError::Aborted);
        }
        if text.trim().is_empty() {
            return Ok(text);
        }

        if let Some(cached) = { self.cache.lock().await.get(&text).cloned() } {
            return Ok(cached);
        }

        let shared = {
            let mut inflight = self.inflight.lock().await;
            if let Some(existing) = inflight.get(&text) {
                existing.clone()
            } else {
                let t = text.clone();
                let this = self.clone();
                let abort2 = abort.clone();
                let fut = async move {
                    let _permit = this
                        .semaphore
                        .acquire()
                        .await
                        .map_err(|_| TranslateError::Request("semaphore closed".to_string()))?;
                    if abort2.is_cancelled() {
                        return Err(TranslateError::Aborted);
                    }
                    tokio::time::sleep(Duration::from_millis(60)).await;

                    let try_free = || with_retry(|| translate_free(&t, &this.source_google, &this.target_google), "free");
                    let try_cloud = || async {
                        let key = this.api_key.as_deref().ok_or(TranslateError::MissingApiKey)?;
                        with_retry(|| translate_google_cloud(&t, &this.source_google, &this.target_google, key), "google-cloud").await
                    };
                    let try_gas = || with_retry(|| translate_via_gas(&t, &this.source_google, &this.target_google, &this.gas_url), "gas");
                    let try_deepl = || async {
                        let key = this.deepl_api_key.as_deref().ok_or(TranslateError::MissingDeepLKey)?;
                        with_retry(|| translate_deepl(&t, &this.source_deepl, &this.target_deepl, key), "deepl").await
                    };
                    let try_claude = || with_retry(|| translate_claude_ai_openai_compat(&t, &this.source_google, &this.target_google), "claude-ai");
                                    // Decide sequence based on selected primary provider
                                    let translated = match this.provider_primary {
                                        Provider::GoogleCloud => {
                                            match try_cloud().await {
                                                Ok(v) => v,
                                                Err(e1) => {
                                                    if !is_likely_google_api_error(&e1) {
                                                        return Err(e1);
                                                    }
                                                    match try_gas().await {
                                                        Ok(v) => v,
                                                        Err(e2) => {
                                                            if !this.has_cloud {
                                                                return Err(e2);
                                                            }
                                                            try_free().await?
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Provider::Free => {
                                            match try_free().await {
                                                Ok(v) => v,
                                                Err(e1) => {
                                                    if !is_likely_google_api_error(&e1) {
                                                        return Err(e1);
                                                    }
                                                    match try_gas().await {
                                                        Ok(v) => v,
                                                        Err(e2) => {
                                                            if this.has_cloud {
                                                                try_cloud().await?
                                                            } else {
                                                                return Err(e2);
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Provider::Gas => {
                                            match try_gas().await {
                                                Ok(v) => v,
                                                Err(_e1) => {
                                                    if this.has_cloud {
                                                        match try_cloud().await {
                                                            Ok(v) => v,
                                                            Err(_e2) => { try_free().await? }
                                                        }
                                                    } else {
                                                        try_free().await?
                                                    }
                                                }
                                            }
                                        }
                                        Provider::DeepL => {
                                            match try_deepl().await {
                                                Ok(v) => v,
                                                Err(_e1) => {
                                                    match try_gas().await {
                                                        Ok(v) => v,
                                                        Err(_e2) => {
                                                            if this.has_cloud {
                                                                match try_cloud().await {
                                                                    Ok(v) => v,
                                                                    Err(_e3) => { try_free().await? }
                                                                }
                                                            } else {
                                                                try_free().await?
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                        Provider::ClaudeAi => {
                                            match try_claude().await {
                                                Ok(v) => v,
                                                Err(_e1) => {
                                                    match try_gas().await {
                                                        Ok(v) => v,
                                                        Err(_e2) => {
                                                            if this.has_cloud {
                                                                match try_cloud().await {
                                                                    Ok(v) => v,
                                                                    Err(_e3) => {
                                                                        match try_deepl().await {
                                                                            Ok(v) => v,
                                                                            Err(_e4) => try_free().await?,
                                                                        }
                                                                    }
                                                                }
                                                            } else {
                                                                match try_deepl().await {
                                                                    Ok(v) => v,
                                                                    Err(_e3) => try_free().await?,
                                                                }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    };

                    Ok::<_, TranslateError>(translated)
                };

                let shared = fut.boxed().shared();
                inflight.insert(text.clone(), shared.clone());
                shared
            }
        };

        let res = shared.await;
        if let Ok(ref translated) = res {
            self.cache.lock().await.insert(text.clone(), translated.clone());
        }
        self.inflight.lock().await.remove(&text);
        res
    }

    pub async fn translate_one(&self, text: &str, abort: &tokio_util::sync::CancellationToken) -> Result<String, TranslateError> {
        if abort.is_cancelled() {
            return Err(TranslateError::Aborted);
        }
        if text.is_empty() {
            return Ok(text.to_string());
        }

        // Keep formatting-only entries (padding, arrows, symbols) untouched.
        if is_formatting_only(text) {
            return Ok(text.to_string());
        }

        let (protected, repls) = protect_placeholders(text);
        let t = self.translate_raw(protected, abort).await?;
        let restored = restore_placeholders(&t, &repls);
        Ok(preserve_edge_whitespace(text, &restored))
    }

    pub async fn translate_many(&self, texts: &[String], abort: &tokio_util::sync::CancellationToken) -> Result<Vec<String>, TranslateError> {
        if abort.is_cancelled() {
            return Err(TranslateError::Aborted);
        }
        if texts.is_empty() {
            return Ok(Vec::new());
        }

        if self.provider_primary != Provider::ClaudeAi {
            let mut out: Vec<String> = Vec::with_capacity(texts.len());
            for t in texts {
                out.push(self.translate_one(t, abort).await?);
            }
            return Ok(out);
        }

        // Placeholder protection per item
        let mut protected: Vec<String> = Vec::with_capacity(texts.len());
        let mut repls: Vec<Vec<(String, String)>> = Vec::with_capacity(texts.len());
        let mut formatting_only: Vec<bool> = Vec::with_capacity(texts.len());
        for t in texts {
            let fmt = is_formatting_only(t);
            formatting_only.push(fmt);
            let (p, r) = protect_placeholders(t);
            protected.push(p);
            repls.push(r);
        }

        // Fast-path from cache
        let mut out: Vec<Option<String>> = vec![None; protected.len()];

        // formatting-only items are returned as-is (do not hit network)
        for (i, is_fmt) in formatting_only.iter().copied().enumerate() {
            if is_fmt {
                out[i] = Some(texts[i].clone());
            }
        }

        {
            let cache = self.cache.lock().await;
            for (i, p) in protected.iter().enumerate() {
                if out[i].is_some() {
                    continue;
                }
                if let Some(v) = cache.get(p) {
                    out[i] = Some(v.clone());
                }
            }
        }

        let mut missing_texts: Vec<String> = Vec::new();
        let mut missing_indices: Vec<usize> = Vec::new();
        for (i, p) in protected.iter().enumerate() {
            if out[i].is_none() {
                missing_indices.push(i);
                missing_texts.push(p.clone());
            }
        }

        if !missing_texts.is_empty() {
            let _permit = self
                .semaphore
                .acquire()
                .await
                .map_err(|_| TranslateError::Request("semaphore closed".to_string()))?;
            if abort.is_cancelled() {
                return Err(TranslateError::Aborted);
            }
            tokio::time::sleep(Duration::from_millis(60)).await;

            let translated_missing = with_retry(
                || translate_claude_ai_openai_compat_batch(&missing_texts, &self.source_google, &self.target_google),
                "claude-ai-batch",
            )
            .await?;

            if translated_missing.len() != missing_indices.len() {
                return Err(TranslateError::Request("Claude(AI) batch size mismatch (internal)".to_string()));
            }

            for (pos, idx) in missing_indices.iter().cloned().enumerate() {
                out[idx] = Some(translated_missing[pos].clone());
            }

            // write-through cache for protected strings
            let mut cache = self.cache.lock().await;
            for (i, v) in out.iter().enumerate() {
                if let Some(s) = v {
                    cache.insert(protected[i].clone(), s.clone());
                }
            }
        }

        // Restore placeholders and preserve edge whitespace
        let mut final_out: Vec<String> = Vec::with_capacity(texts.len());
        for i in 0..texts.len() {
            let translated = out[i].clone().unwrap_or_else(|| protected[i].clone());
            let restored = restore_placeholders(&translated, &repls[i]);
            final_out.push(preserve_edge_whitespace(&texts[i], &restored));
        }
        Ok(final_out)
    }
}
