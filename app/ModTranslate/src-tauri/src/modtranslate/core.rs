use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use serde_json::{Map, Value};
use tauri::{AppHandle, Emitter};
use tokio_util::sync::CancellationToken;

use futures::{future::BoxFuture, stream::{FuturesUnordered, StreamExt}, FutureExt};

use super::{
    jsonc::{parse_jsonc_object, try_parse_jsonc_object},
    translate::{TranslateError, Translator},
    ziputil::{ensure_backup, list_asset_namespaces, read_zip_text, remove_entries_from_zip, zip_has_file},
    DoneEvent, JarFile, LogEvent, PlanResult, PlanSummary, PlanTask, ProgressEvent, RunRequest,
};

#[derive(Debug, thiserror::Error)]
pub enum CoreError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] super::ziputil::ZipUtilError),
    #[error("Json error: {0}")]
    Json(#[from] super::jsonc::JsoncError),
    #[error("Translate error: {0}")]
    Translate(#[from] TranslateError),
    #[error("Aborted")]
    Aborted,
}

pub fn normalize_mc_lang_file_stem(input: &str) -> String {
    let s = input.trim().trim_end_matches(".json");
    let re = regex::Regex::new(r"^([a-zA-Z]{2,3})[\-_]([a-zA-Z]{2,3})$").unwrap();
    if let Some(c) = re.captures(s) {
        let a = c.get(1).map(|m| m.as_str()).unwrap_or("");
        let b = c.get(2).map(|m| m.as_str()).unwrap_or("");
        if !a.is_empty() && !b.is_empty() {
            return format!("{}_{}", a.to_lowercase(), b.to_lowercase());
        }
    }
    s.to_lowercase()
}

fn looks_like_human_text(s: &str) -> bool {
    let core = s.trim();
    if core.is_empty() {
        return false;
    }

    if !core.chars().any(|c| c.is_alphabetic()) {
        return false;
    }

    // Very short ALL-CAPS tokens are often fine to keep as-is (OK, UI, CPU, etc.)
    if core.len() <= 3 && core.chars().all(|c| c.is_ascii_alphabetic() && c.is_ascii_uppercase()) {
        return false;
    }

    true
}

pub fn list_jar_files(dir: &str) -> Result<Vec<JarFile>, CoreError> {
    let mut out: Vec<JarFile> = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if !file_type.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.to_lowercase().ends_with(".jar") {
            continue;
        }
        let abs = entry.path().canonicalize().unwrap_or(entry.path());
        out.push(JarFile {
            name,
            abs_path: abs.to_string_lossy().to_string(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn ensure_resource_pack_base(out_dir: &Path) -> Result<(), CoreError> {
    fs::create_dir_all(out_dir)?;
    let pack_mcmeta_path = out_dir.join("pack.mcmeta");
    if !pack_mcmeta_path.exists() {
        let mcmeta = serde_json::json!({
            "pack": {
                "pack_format": 15,
                "description": "Auto Generated Resource Pack for ModTranslate"
            }
        });
        fs::write(pack_mcmeta_path, serde_json::to_string_pretty(&mcmeta).unwrap())?;
    }
    Ok(())
}

fn write_lang_file(out_dir: &Path, namespace: &str, lang_file_stem: &str, json: &Map<String, Value>) -> Result<(), CoreError> {
    let file_path = out_dir
        .join("assets")
        .join(namespace)
        .join("lang")
        .join(format!("{}.json", lang_file_stem));
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(file_path, serde_json::to_string_pretty(json).unwrap())?;
    Ok(())
}

pub fn build_plan(req: &RunRequest) -> Result<PlanResult, CoreError> {
    let mut tasks: Vec<PlanTask> = Vec::new();

    let mut total = 0usize;
    let mut skipped_in_jar = 0usize;
    let mut plan_errors = 0usize;
    let mut broken_target_found = 0usize;
    let mut repaired_target = 0usize;
    let mut backup_created = 0usize;
    let mut repair_errors = 0usize;

    for jar_path in &req.jars {
        let jar_path_buf = PathBuf::from(jar_path);
        let jar_name = jar_path_buf
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| jar_path.clone());

        let src = match fs::File::open(&jar_path_buf) {
            Ok(f) => f,
            Err(_) => {
                plan_errors += 1;
                continue;
            }
        };

        let mut zip = match zip::read::ZipArchive::new(src) {
            Ok(z) => z,
            Err(_) => {
                plan_errors += 1;
                continue;
            }
        };

        let namespaces = list_asset_namespaces(&mut zip);
        let mut remove_list: Vec<String> = Vec::new();

        for ns in namespaces {
            let src_path = format!("assets/{}/lang/{}.json", ns, req.source);
            let dst_path = format!("assets/{}/lang/{}.json", ns, req.target);

            if !zip_has_file(&mut zip, &src_path) {
                continue;
            }

            if zip_has_file(&mut zip, &dst_path) {
                let dst_text = read_zip_text(&mut zip, &dst_path).ok();
                let is_broken = dst_text
                    .as_deref()
                    .map(|t| try_parse_jsonc_object(t).is_none())
                    .unwrap_or(true);

                if !is_broken {
                    skipped_in_jar += 1;
                    continue;
                }

                broken_target_found += 1;

                if req.repair_broken_target_in_jar {
                    remove_list.push(dst_path.clone());
                }
            }

            tasks.push(PlanTask {
                jar_path: jar_path.clone(),
                jar_name: jar_name.clone(),
                namespace: ns,
                src_path: src_path.clone(),
                dst_path: dst_path.clone(),
            });
            total += 1;
        }

        if req.repair_broken_target_in_jar && !remove_list.is_empty() {
            // backup once per jar
            if req.backup_jars {
                match ensure_backup(&jar_path_buf) {
                    Ok(created) => {
                        if created {
                            backup_created += 1;
                        }
                    }
                    Err(_) => {
                        repair_errors += 1;
                    }
                }
            }

            match remove_entries_from_zip(&jar_path_buf, &remove_list) {
                Ok(()) => {
                    repaired_target += remove_list.len();
                }
                Err(_) => {
                    repair_errors += 1;
                }
            }
        }
    }

    // stable sort like CLI (jar then namespace)
    tasks.sort_by(|a, b| {
        let c = a.jar_path.cmp(&b.jar_path);
        if c != std::cmp::Ordering::Equal {
            return c;
        }
        a.namespace.cmp(&b.namespace)
    });

    Ok(PlanResult {
        summary: PlanSummary {
            total,
            skipped_in_jar,
            plan_errors,
            broken_target_found,
            repaired_target,
            backup_created,
            repair_errors,
        },
        tasks,
    })
}

pub async fn run_translate(app: AppHandle, run_id: String, req: RunRequest, abort: CancellationToken) {
    let started = Instant::now();

    let plan = match build_plan(&req) {
        Ok(p) => p,
        Err(e) => {
            let _ = app.emit(
                "modtranslate:log",
                LogEvent {
                    run_id: run_id.clone(),
                    line: format!("ERR  plan: {}", e),
                },
            );
            let _ = app.emit(
                "modtranslate:done",
                DoneEvent {
                    run_id,
                    aborted: abort.is_cancelled(),
                    summary: PlanSummary {
                        total: 0,
                        skipped_in_jar: 0,
                        plan_errors: 1,
                        broken_target_found: 0,
                        repaired_target: 0,
                        backup_created: 0,
                        repair_errors: 0,
                    },
                    translated: 0,
                    skipped: 0,
                    errors: 1,
                    out_dir: req.out_dir,
                    elapsed_ms: started.elapsed().as_millis(),
                },
            );
            return;
        }
    };

    if plan.summary.total == 0 {
        let _ = app.emit(
            "modtranslate:log",
            LogEvent {
                run_id: run_id.clone(),
                line: "翻訳対象が見つかりませんでした（enファイルが無い/既にjar内に翻訳がある可能性）".to_string(),
            },
        );
        let _ = app.emit(
            "modtranslate:done",
            DoneEvent {
                run_id,
                aborted: abort.is_cancelled(),
                summary: plan.summary,
                translated: 0,
                skipped: 0,
                errors: 0,
                out_dir: req.out_dir,
                elapsed_ms: started.elapsed().as_millis(),
            },
        );
        return;
    }

    let out_dir = PathBuf::from(&req.out_dir);
    if let Err(e) = ensure_resource_pack_base(&out_dir) {
        let _ = app.emit(
            "modtranslate:log",
            LogEvent {
                run_id: run_id.clone(),
                line: format!("ERR  resourcepack: {}", e),
            },
        );
    }

    let translator = Translator::new(&req.source, &req.target, &req.translate);

    let note = format!(
        "対象Mod:{} / jar内翻訳有り除外:{} / 破損{}:{} 修復:{} / 事前スキャンエラー:{} 修復エラー:{} (provider:{})",
        plan.summary.total,
        plan.summary.skipped_in_jar,
        req.target,
        plan.summary.broken_target_found,
        plan.summary.repaired_target,
        plan.summary.plan_errors,
        plan.summary.repair_errors,
        translator.provider_label()
    );

    let _ = app.emit(
        "modtranslate:log",
        LogEvent {
            run_id: run_id.clone(),
            line: note.clone(),
        },
    );

    let mut translated_mods = 0usize;
    let mut skipped_mods = 0usize;
    let mut errors = 0usize;
    let mut done_mods = 0usize;

    // group tasks by jar
    let mut by_jar: BTreeMap<String, Vec<PlanTask>> = BTreeMap::new();
    for t in &plan.tasks {
        by_jar.entry(t.jar_path.clone()).or_default().push(t.clone());
    }

    for (jar_path, tasks) in by_jar {
        if abort.is_cancelled() {
            break;
        }

        let jar_path_buf = PathBuf::from(&jar_path);
        let src_file = match fs::File::open(&jar_path_buf) {
            Ok(f) => f,
            Err(e) => {
                errors += tasks.len();
                done_mods += tasks.len();
                let _ = app.emit(
                    "modtranslate:progress",
                    ProgressEvent {
                        run_id: run_id.clone(),
                        done_mods,
                        total_mods: plan.summary.total,
                        translated: translated_mods,
                        skipped: skipped_mods,
                        errors,
                        current: format!("{} (jar読込失敗)", jar_path_buf.file_name().unwrap_or_default().to_string_lossy()),
                        key_total: 1,
                        key_done: 0,
                        key_note: "jar読込失敗".to_string(),
                    },
                );
                let _ = app.emit(
                    "modtranslate:log",
                    LogEvent {
                        run_id: run_id.clone(),
                        line: format!("ERR jar読込失敗: {} ({})", jar_path, e),
                    },
                );
                continue;
            }
        };

        let mut zip = match zip::read::ZipArchive::new(src_file) {
            Ok(z) => z,
            Err(e) => {
                errors += tasks.len();
                done_mods += tasks.len();
                let _ = app.emit(
                    "modtranslate:log",
                    LogEvent {
                        run_id: run_id.clone(),
                        line: format!("ERR jar読込失敗: {} ({})", jar_path, e),
                    },
                );
                continue;
            }
        };

        for task in tasks {
            if abort.is_cancelled() {
                break;
            }

            let task_start = Instant::now();
            let current_label = format!("{} :: {}", task.jar_name, task.namespace);

            let _ = app.emit(
                "modtranslate:progress",
                ProgressEvent {
                    run_id: run_id.clone(),
                    done_mods,
                    total_mods: plan.summary.total,
                    translated: translated_mods,
                    skipped: skipped_mods,
                    errors,
                    current: current_label.clone(),
                    key_total: 1,
                    key_done: 0,
                    key_note: "準備中".to_string(),
                },
            );

            // src exists check
            if !zip_has_file(&mut zip, &task.src_path) {
                skipped_mods += 1;
                done_mods += 1;
                let _ = app.emit(
                    "modtranslate:progress",
                    ProgressEvent {
                        run_id: run_id.clone(),
                        done_mods,
                        total_mods: plan.summary.total,
                        translated: translated_mods,
                        skipped: skipped_mods,
                        errors,
                        current: current_label.clone(),
                        key_total: 1,
                        key_done: 1,
                        key_note: "ソース無し(スキップ)".to_string(),
                    },
                );
                continue;
            }

            // read source text from jar
            let src_text = match read_zip_text(&mut zip, &task.src_path) {
                Ok(s) => s,
                Err(e) => {
                    errors += 1;
                    done_mods += 1;
                    let _ = app.emit(
                        "modtranslate:log",
                        LogEvent {
                            run_id: run_id.clone(),
                            line: format!("ERR  {}: {}", current_label, e),
                        },
                    );
                    continue;
                }
            };

            // parse JSONC source
            let data = match parse_jsonc_object(&src_text, &format!("{}:{}", task.jar_path, task.src_path)) {
                Ok(d) => d,
                Err(e) => {
                    errors += 1;
                    done_mods += 1;
                    let _ = app.emit(
                        "modtranslate:log",
                        LogEvent {
                            run_id: run_id.clone(),
                            line: format!("ERR  {}: {}", current_label, e),
                        },
                    );
                    continue;
                }
            };

            let out_lang_path = out_dir
                .join("assets")
                .join(&task.namespace)
                .join("lang")
                .join(format!("{}.json", req.target));

            let mut existing_target: Option<Map<String, Value>> = None;
            if out_lang_path.exists() {
                match fs::read_to_string(&out_lang_path) {
                    Ok(existing_text) => {
                        existing_target = try_parse_jsonc_object(&existing_text);
                    }
                    Err(_) => {}
                }
            }

            let mut translated: Map<String, Value> = existing_target.clone().unwrap_or_default();
            let mut string_keys: Vec<String> = Vec::new();
            let mut string_values: Vec<String> = Vec::new();
            let mut missing_key = false;
            let mut total_source_strings: usize = 0;
            let mut reused_strings: usize = 0;

            for (k, v) in data.iter() {
                match v {
                    Value::String(s) => {
                        total_source_strings += 1;
                        if let Some(ref existing) = existing_target {
                            if !existing.contains_key(k) {
                                missing_key = true;
                            }
                            if let Some(Value::String(es)) = existing.get(k) {
                                if !es.trim().is_empty() {
                                    // If existing == source, it may be either "not translated" or "translation legitimately equals source".
                                    // Retranslate only when it looks like human text AND source/target language differ.
                                    if es == s {
                                        if req.source != req.target && looks_like_human_text(s) {
                                            // retranslate
                                        } else {
                                            translated.insert(k.clone(), Value::String(es.clone()));
                                            reused_strings += 1;
                                            continue;
                                        }
                                    } else {
                                        translated.insert(k.clone(), Value::String(es.clone()));
                                        reused_strings += 1;
                                        continue;
                                    }
                                }
                            }
                        }
                        string_keys.push(k.clone());
                        string_values.push(s.clone());
                    }
                    _ => {
                        translated.insert(k.clone(), v.clone());
                    }
                }
            }

            if existing_target.is_some() && !missing_key && string_values.is_empty() {
                skipped_mods += 1;
                done_mods += 1;
                let _ = app.emit(
                    "modtranslate:progress",
                    ProgressEvent {
                        run_id: run_id.clone(),
                        done_mods,
                        total_mods: plan.summary.total,
                        translated: translated_mods,
                        skipped: skipped_mods,
                        errors,
                        current: current_label.clone(),
                        key_total: 1,
                        key_done: 1,
                        key_note: "差分なし（既存再利用）".to_string(),
                    },
                );
                let elapsed_ms = task_start.elapsed().as_millis();
                let mins = elapsed_ms / 1000 / 60;
                let secs = (elapsed_ms / 1000) % 60;
                let _ = app.emit(
                    "modtranslate:log",
                    LogEvent {
                        run_id: run_id.clone(),
                        line: format!("SKIP {} ({}m{}s | {}ms)", current_label, mins, secs, elapsed_ms),
                    },
                );
                continue;
            }

            if !string_values.is_empty() {
                let note = if existing_target.is_some() {
                    if reused_strings > 0 {
                        format!(
                            "差分翻訳 {}件（既存 {}件 再利用 / 合計 {}件）",
                            string_values.len(),
                            reused_strings,
                            total_source_strings
                        )
                    } else {
                        // 既存ファイルはあるが、今回再利用できる翻訳が無い（=実質フル翻訳）
                        format!("翻訳 {}件（既存再利用なし / 合計 {}件）", string_values.len(), total_source_strings)
                    }
                } else {
                    format!("翻訳 {}件", string_values.len())
                };

                let _ = app.emit(
                    "modtranslate:progress",
                    ProgressEvent {
                        run_id: run_id.clone(),
                        done_mods,
                        total_mods: plan.summary.total,
                        translated: translated_mods,
                        skipped: skipped_mods,
                        errors,
                        current: current_label.clone(),
                        key_total: string_values.len().max(1),
                        key_done: 0,
                        key_note: note.clone(),
                    },
                );

                let total = string_values.len();
                let mut results: Vec<Option<String>> = vec![None; total];

                let is_claude = translator.provider_label() == "claude-ai";
                let mut futs: FuturesUnordered<BoxFuture<'static, (Vec<usize>, Vec<String>, Result<Vec<String>, TranslateError>)>> = FuturesUnordered::new();
                if is_claude {
                    let max_items = translator.max_concurrency().max(1);
                    let max_chars: usize = 12_000;

                    let mut start: usize = 0;
                    while start < string_values.len() {
                        let mut end = start;
                        let mut chars = 0usize;
                        while end < string_values.len() {
                            let s = &string_values[end];
                            let next_chars = chars + s.len();
                            if (end - start) >= max_items || next_chars > max_chars {
                                break;
                            }
                            chars = next_chars;
                            end += 1;
                        }
                        if end == start {
                            end = (start + 1).min(string_values.len());
                        }

                        let batch_indices: Vec<usize> = (start..end).collect();
                        let batch_texts: Vec<String> = string_values[start..end].to_vec();

                        let translator2 = translator.clone();
                        let abort2 = abort.clone();
                        futs.push(
                            async move {
                                let res = translator2.translate_many(&batch_texts, &abort2).await;
                                (batch_indices, batch_texts, res)
                            }
                            .boxed(),
                        );

                        start = end;
                    }
                } else {
                    for (idx, v) in string_values.iter().cloned().enumerate() {
                        let translator2 = translator.clone();
                        let abort2 = abort.clone();
                        futs.push(
                            async move {
                                let res = translator2.translate_one(&v, &abort2).await;
                                (vec![idx], vec![v], res.map(|v| vec![v]))
                            }
                            .boxed(),
                        );
                    }
                }

                let mut done = 0usize;
                while let Some((indices, originals, res)) = futs.next().await {
                    let batch_len = indices.len().max(1);
                    done += batch_len;

                    let translated_vec: Vec<String> = match res {
                        Ok(vs) => vs,
                        Err(TranslateError::Aborted) => {
                            abort.cancel();
                            originals.clone()
                        }
                        Err(e) => {
                            let _ = app.emit(
                                "modtranslate:log",
                                LogEvent {
                                    run_id: run_id.clone(),
                                    line: format!("WARN batch translate error: {}", e),
                                },
                            );

                            // Fallback: per-item translation (more tolerant) when batch JSON fails.
                            let mut out: Vec<String> = Vec::with_capacity(originals.len());
                            for s in originals.iter() {
                                if abort.is_cancelled() {
                                    out.push(s.clone());
                                    continue;
                                }
                                match translator.translate_one(s, &abort).await {
                                    Ok(t) => out.push(t),
                                    Err(TranslateError::Aborted) => {
                                        abort.cancel();
                                        out.push(s.clone());
                                    }
                                    Err(e2) => {
                                        let _ = app.emit(
                                            "modtranslate:log",
                                            LogEvent {
                                                run_id: run_id.clone(),
                                                line: format!("WARN translate error: {}", e2),
                                            },
                                        );
                                        out.push(s.clone());
                                    }
                                }
                            }
                            out
                        }
                    };

                    for (pos, idx) in indices.iter().cloned().enumerate() {
                        let original = originals.get(pos).cloned().unwrap_or_default();
                        let translated_text = translated_vec.get(pos).cloned().unwrap_or(original);
                        if idx < results.len() {
                            results[idx] = Some(translated_text);
                        }
                    }

                    let _ = app.emit(
                        "modtranslate:progress",
                        ProgressEvent {
                            run_id: run_id.clone(),
                            done_mods,
                            total_mods: plan.summary.total,
                            translated: translated_mods,
                            skipped: skipped_mods,
                            errors,
                            current: current_label.clone(),
                            key_total: total.max(1),
                            key_done: done,
                            key_note: note.clone(),
                        },
                    );

                    if abort.is_cancelled() {
                        break;
                    }
                }

                for (i, k) in string_keys.iter().enumerate() {
                    let v = results
                        .get(i)
                        .and_then(|o| o.clone())
                        .unwrap_or_else(|| string_values.get(i).cloned().unwrap_or_default());
                    translated.insert(k.clone(), Value::String(v));
                }
            } else {
                let _ = app.emit(
                    "modtranslate:progress",
                    ProgressEvent {
                        run_id: run_id.clone(),
                        done_mods,
                        total_mods: plan.summary.total,
                        translated: translated_mods,
                        skipped: skipped_mods,
                        errors,
                        current: current_label.clone(),
                        key_total: 1,
                        key_done: 1,
                        key_note: "更新（翻訳不要）".to_string(),
                    },
                );
            }

            if abort.is_cancelled() {
                break;
            }

            match write_lang_file(&out_dir, &task.namespace, &req.target, &translated) {
                Ok(()) => {
                    translated_mods += 1;
                    done_mods += 1;
                    let _ = app.emit(
                        "modtranslate:progress",
                        ProgressEvent {
                            run_id: run_id.clone(),
                            done_mods,
                            total_mods: plan.summary.total,
                            translated: translated_mods,
                            skipped: skipped_mods,
                            errors,
                            current: current_label.clone(),
                            key_total: 1,
                            key_done: 1,
                            key_note: "書き込み完了".to_string(),
                        },
                    );
                    let elapsed_ms = task_start.elapsed().as_millis();
                    let mins = elapsed_ms / 1000 / 60;
                    let secs = (elapsed_ms / 1000) % 60;
                    let _ = app.emit(
                        "modtranslate:log",
                        LogEvent {
                            run_id: run_id.clone(),
                            line: format!("OK   {} ({}m{}s | {}ms)", current_label, mins, secs, elapsed_ms),
                        },
                    );
                }
                Err(e) => {
                    errors += 1;
                    done_mods += 1;
                    let _ = app.emit(
                        "modtranslate:log",
                        LogEvent {
                            run_id: run_id.clone(),
                            line: format!("ERR  {}: {}", current_label, e),
                        },
                    );
                }
            }
        }
    }

    let aborted = abort.is_cancelled();
    let _ = app.emit(
        "modtranslate:done",
        DoneEvent {
            run_id: run_id.clone(),
            aborted,
            summary: plan.summary,
            translated: translated_mods,
            skipped: skipped_mods,
            errors,
            out_dir: req.out_dir,
            elapsed_ms: started.elapsed().as_millis(),
        },
    );
}
