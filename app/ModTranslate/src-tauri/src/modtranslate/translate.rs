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
    #[error("Aborted")]
    Aborted,
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

#[derive(Clone)]
pub struct Translator {
    source: String,
    target: String,
    provider_primary: Provider,
    has_cloud: bool,
    api_key: Option<String>,
    gas_url: String,
    semaphore: Arc<Semaphore>,
    cache: Arc<Mutex<HashMap<String, String>>>,
    inflight: Arc<Mutex<HashMap<String, futures::future::Shared<BoxFuture<'static, Result<String, TranslateError>>>>>>,
}

impl Translator {
    pub fn provider_label(&self) -> &'static str {
        match self.provider_primary {
            Provider::GoogleCloud => "google-cloud",
            Provider::Free => "free",
        }
    }

    pub fn new(source_mc: &str, target_mc: &str, cfg: &TranslateConfig) -> Self {
        let source = to_google_lang(source_mc);
        let target = to_google_lang(target_mc);

        let api_key = cfg
            .google_api_key
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let has_cloud = api_key.is_some();

        let provider_str = cfg.provider.as_ref().map(|s| s.to_lowercase());
        let provider_primary = match provider_str.as_deref() {
            Some("google-cloud") => Provider::GoogleCloud,
            Some("free") => Provider::Free,
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

        let gas_url = cfg
            .gas_url
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_GAS_URL.to_string());

        Self {
            source,
            target,
            provider_primary,
            has_cloud,
            api_key,
            gas_url,
            semaphore: Arc::new(Semaphore::new(concurrency as usize)),
            cache: Arc::new(Mutex::new(HashMap::new())),
            inflight: Arc::new(Mutex::new(HashMap::new())),
        }
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

                    let try_free = || with_retry(|| translate_free(&t, &this.source, &this.target), "free");
                    let try_cloud = || async {
                        let key = this.api_key.as_deref().ok_or(TranslateError::MissingApiKey)?;
                        with_retry(|| translate_google_cloud(&t, &this.source, &this.target, key), "google-cloud").await
                    };
                    let try_gas = || with_retry(|| translate_via_gas(&t, &this.source, &this.target, &this.gas_url), "gas");

                    let primary_google = if this.provider_primary == Provider::GoogleCloud {
                        Provider::GoogleCloud
                    } else {
                        Provider::Free
                    };
                    let secondary_google = if primary_google == Provider::GoogleCloud {
                        Provider::Free
                    } else {
                        Provider::GoogleCloud
                    };

                    let call_google = |which: Provider| async move {
                        match which {
                            Provider::Free => try_free().await,
                            Provider::GoogleCloud => try_cloud().await,
                        }
                    };

                    // Primary google → GAS → Secondary google (if available)
                    let translated = match call_google(primary_google).await {
                        Ok(v) => v,
                        Err(e1) => {
                            if !is_likely_google_api_error(&e1) {
                                return Err(e1);
                            }
                            match try_gas().await {
                                Ok(v) => v,
                                Err(e2) => {
                                    if secondary_google == Provider::GoogleCloud && !this.has_cloud {
                                        return Err(e2);
                                    }
                                    call_google(secondary_google).await?
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

        let (protected, repls) = protect_placeholders(text);
        let t = self.translate_raw(protected, abort).await?;
        Ok(restore_placeholders(&t, &repls))
    }
}
