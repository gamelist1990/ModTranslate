use std::{
    fs,
    io::{self, Read, Seek},
    path::{Path, PathBuf},
};

use zip::{read::ZipArchive, write::FileOptions, ZipWriter};

#[derive(Debug, thiserror::Error)]
pub enum ZipUtilError {
    #[error("IO error: {0}")]
    Io(#[from] io::Error),
    #[error("Zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
}

pub fn zip_has_file<R: Read + Seek>(zip: &mut ZipArchive<R>, zip_path: &str) -> bool {
    zip.by_name(zip_path).is_ok()
}

pub fn read_zip_text<R: Read + Seek>(zip: &mut ZipArchive<R>, zip_path: &str) -> Result<String, ZipUtilError> {
    let mut f = zip.by_name(zip_path)?;
    let mut s = String::new();
    f.read_to_string(&mut s)?;
    Ok(s)
}

pub fn list_asset_namespaces<R: Read + Seek>(zip: &mut ZipArchive<R>) -> Vec<String> {
    let mut set = std::collections::BTreeSet::new();
    for i in 0..zip.len() {
        if let Ok(f) = zip.by_index(i) {
            let name = f.name();
            if !name.starts_with("assets/") {
                continue;
            }
            let mut parts = name.split('/');
            let _assets = parts.next();
            if let Some(ns) = parts.next() {
                if !ns.is_empty() {
                    set.insert(ns.to_string());
                }
            }
        }
    }
    set.into_iter().collect()
}

/// Rewrites the zip file, removing entries whose name matches any in `remove`.
pub fn remove_entries_from_zip(jar_path: &Path, remove: &[String]) -> Result<(), ZipUtilError> {
    if remove.is_empty() {
        return Ok(());
    }

    let remove_set: std::collections::HashSet<&str> = remove.iter().map(|s| s.as_str()).collect();

    let tmp_path: PathBuf = jar_path.with_extension("jar.modtranslate.tmp");

    let src = fs::File::open(jar_path)?;
    let mut zip = ZipArchive::new(src)?;

    let dst = fs::File::create(&tmp_path)?;
    let mut writer = ZipWriter::new(dst);

    for i in 0..zip.len() {
        let mut file = zip.by_index(i)?;
        let name = file.name().to_string();
        if remove_set.contains(name.as_str()) {
            continue;
        }

        let options: FileOptions<'_, zip::write::ExtendedFileOptions> = FileOptions::default()
            .compression_method(file.compression());

        if file.is_dir() {
            writer.add_directory(name, options)?;
            continue;
        }

        writer.start_file(name, options)?;
        io::copy(&mut file, &mut writer)?;
    }

    writer.finish()?;

    // Replace original
    fs::rename(&tmp_path, jar_path)?;
    Ok(())
}

pub fn ensure_backup(jar_path: &Path) -> Result<bool, ZipUtilError> {
    let backup_path = PathBuf::from(format!("{}.modtranslate.bak", jar_path.display()));
    if backup_path.exists() {
        return Ok(false);
    }
    fs::copy(jar_path, backup_path)?;
    Ok(true)
}
