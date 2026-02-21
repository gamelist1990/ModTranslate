use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiConfig {
    pub provider: Option<String>,
    pub google_api_key: Option<String>,
    pub deepl_api_key: Option<String>,
    pub concurrency: Option<u32>,
}

fn config_path() -> Option<PathBuf> {
    if let Some(mut d) = dirs_next::document_dir() {
        d.push("PEXData");
        if !d.exists() {
            // do not create PEXData here; we'll create ModTranslate inside
        }
        d.push("ModTranslate");
        if !d.exists() {
            if let Err(_) = fs::create_dir_all(&d) {
                return None;
            }
        }
        d.push("config.json");
        Some(d)
    } else {
        None
    }
}

pub fn load_config() -> Result<Option<UiConfig>, String> {
    let path = match config_path() {
        Some(p) => p,
        None => return Ok(None),
    };

    if !path.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let cfg: UiConfig = serde_json::from_str(&data).map_err(|e| e.to_string())?;
    Ok(Some(cfg))
}

pub fn save_config(cfg: UiConfig) -> Result<(), String> {
    let path = match config_path() {
        Some(p) => p,
        None => return Err("could not determine config path".to_string()),
    };

    let parent = path.parent().ok_or("invalid config path".to_string())?;
    if !parent.exists() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let s = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    let mut f = fs::File::create(&path).map_err(|e| e.to_string())?;
    f.write_all(s.as_bytes()).map_err(|e| e.to_string())?;
    Ok(())
}
