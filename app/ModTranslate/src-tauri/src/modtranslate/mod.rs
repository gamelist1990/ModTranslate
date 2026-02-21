pub mod core;
pub mod jsonc;
pub mod translate;
pub mod ziputil;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JarFile {
    pub name: String,
    pub abs_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanTask {
    pub jar_path: String,
    pub jar_name: String,
    pub namespace: String,
    pub src_path: String,
    pub dst_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanSummary {
    pub total: usize,
    pub skipped_in_jar: usize,
    pub plan_errors: usize,
    pub broken_target_found: usize,
    pub repaired_target: usize,
    pub backup_created: usize,
    pub repair_errors: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanResult {
    pub summary: PlanSummary,
    pub tasks: Vec<PlanTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateConfig {
    pub provider: Option<String>,
    pub google_api_key: Option<String>,
    pub deepl_api_key: Option<String>,
    pub concurrency: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub dir: String,
    pub out_dir: String,
    pub source: String,
    pub target: String,
    pub jars: Vec<String>,
    pub repair_broken_target_in_jar: bool,
    pub backup_jars: bool,
    pub translate: TranslateConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub run_id: String,
    pub done_mods: usize,
    pub total_mods: usize,
    pub translated: usize,
    pub skipped: usize,
    pub errors: usize,
    pub current: String,
    pub key_total: usize,
    pub key_done: usize,
    pub key_note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub run_id: String,
    pub line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DoneEvent {
    pub run_id: String,
    pub aborted: bool,
    pub summary: PlanSummary,
    pub translated: usize,
    pub skipped: usize,
    pub errors: usize,
    pub out_dir: String,
    pub elapsed_ms: u128,
}
