use std::{collections::HashMap, sync::Mutex};

use tauri::AppHandle;
use tauri::Manager;
use tokio_util::sync::CancellationToken;

mod modtranslate;

const COMMON_MC_LANGS: &[&str] = &[
    "en_us", "en_gb", "ja_jp", "ko_kr", "zh_cn", "zh_tw", "fr_fr", "de_de", "es_es", "pt_br", "it_it",
    "ru_ru",
];

pub struct RunManager {
    tokens: Mutex<HashMap<String, CancellationToken>>,
}

impl RunManager {
    pub fn new() -> Self {
        Self {
            tokens: Mutex::new(HashMap::new()),
        }
    }

    pub fn insert(&self, run_id: String, token: CancellationToken) {
        let mut g = self.tokens.lock().unwrap();
        g.insert(run_id, token);
    }

    pub fn cancel(&self, run_id: &str) -> bool {
        let g = self.tokens.lock().unwrap();
        if let Some(t) = g.get(run_id) {
            t.cancel();
            true
        } else {
            false
        }
    }

    pub fn remove(&self, run_id: &str) {
        let mut g = self.tokens.lock().unwrap();
        g.remove(run_id);
    }
}

#[tauri::command]
fn get_common_langs() -> Vec<String> {
    COMMON_MC_LANGS.iter().map(|s| s.to_string()).collect()
}

#[tauri::command]
fn list_jars(dir: String) -> Result<Vec<modtranslate::JarFile>, String> {
    modtranslate::core::list_jar_files(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
fn scan_plan(req: modtranslate::RunRequest) -> Result<modtranslate::PlanResult, String> {
    modtranslate::core::build_plan(&req).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_run(app: AppHandle, state: tauri::State<RunManager>, req: modtranslate::RunRequest) -> Result<String, String> {
    let run_id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.insert(run_id.clone(), token.clone());

    let app2 = app.clone();
    let run_id2 = run_id.clone();
    tauri::async_runtime::spawn(async move {
        let app_for_run = app2.clone();
        modtranslate::core::run_translate(app_for_run, run_id2.clone(), req, token.clone()).await;
        let rm = app2.state::<RunManager>();
        rm.remove(&run_id2);
    });

    Ok(run_id)
}

#[tauri::command]
fn cancel_run(state: tauri::State<RunManager>, run_id: String) -> bool {
    state.cancel(&run_id)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RunManager::new())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![get_common_langs, list_jars, scan_plan, start_run, cancel_run])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
