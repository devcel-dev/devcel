//! Resolve only the CLI shipped with Studio, never PATH or a project file.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, io::Read, path::Path};
use tauri::Manager;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CliManifest {
    schema_version: u32,
    version: String,
    platform: String,
    executable: String,
    sha256: String,
    source_commit: String,
}

#[derive(Serialize)]
pub struct BundledCliInfo {
    path: String,
    manifest: CliManifest,
}

fn regular(path: &Path, max_bytes: u64) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Bundled CLI file is unavailable")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > max_bytes {
        return Err("Invalid bundled CLI file".into());
    }
    Ok(())
}

fn resolve(root: &Path) -> Result<BundledCliInfo, String> {
    let bin = root.join("bin");
    let metadata = fs::symlink_metadata(&bin).map_err(|_| "Bundled CLI is not installed")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Invalid bundled CLI directory".into());
    }
    let canonical_root = fs::canonicalize(root).map_err(|_| "App resources unavailable")?;
    let canonical_bin = fs::canonicalize(&bin).map_err(|_| "Bundled CLI directory unavailable")?;
    if canonical_bin.parent() != Some(canonical_root.as_path()) {
        return Err("Bundled CLI directory escapes app resources".into());
    }
    let manifest_path = bin.join("manifest.json");
    regular(&manifest_path, 4096)?;
    let manifest: CliManifest = serde_json::from_slice(
        &fs::read(manifest_path).map_err(|_| "Cannot read bundled CLI manifest")?,
    )
    .map_err(|_| "Invalid bundled CLI manifest")?;
    let executable = if cfg!(windows) {
        "devcel.exe"
    } else {
        "devcel"
    };
    let platform = if cfg!(windows) {
        "win-x64"
    } else {
        "linux-x64"
    };
    let hex = |s: &str, len| {
        s.len() == len
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    };
    if manifest.schema_version != 1
        || manifest.platform != platform
        || manifest.executable != executable
        || !hex(&manifest.sha256, 64)
        || !hex(&manifest.source_commit, 40)
    {
        return Err("Bundled CLI identity does not match Studio".into());
    }
    let path = bin.join(executable);
    regular(&path, 256 * 1024 * 1024)?;
    let mut file = fs::File::open(&path).map_err(|_| "Cannot read bundled CLI")?;
    let mut digest = Sha256::new();
    let mut buffer = [0; 65536];
    let mut total = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot hash bundled CLI")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > 256 * 1024 * 1024 {
            return Err("Bundled CLI exceeds size limit".into());
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != manifest.sha256 {
        return Err("Bundled CLI hash mismatch".into());
    }
    Ok(BundledCliInfo {
        path: path.to_string_lossy().into_owned(),
        manifest,
    })
}

#[tauri::command]
pub fn get_bundled_cli_info(app: tauri::AppHandle) -> Result<BundledCliInfo, String> {
    let root = app
        .path()
        .resource_dir()
        .map_err(|_| "App resources unavailable")?;
    resolve(&root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_matching_bundled_identity_and_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let executable = if cfg!(windows) {
            "devcel.exe"
        } else {
            "devcel"
        };
        let platform = if cfg!(windows) {
            "win-x64"
        } else {
            "linux-x64"
        };
        fs::write(bin.join(executable), b"fixture").unwrap();
        let mut value = serde_json::json!({"schema_version":1,"version":"hoge",
            "platform":platform,"executable":executable,"sha256":format!("{:x}",Sha256::digest(b"fixture")),"source_commit":"a".repeat(40)});
        let write =
            |v: &serde_json::Value| fs::write(bin.join("manifest.json"), v.to_string()).unwrap();
        write(&value);
        assert!(resolve(temp.path()).is_ok());
        for key in ["platform", "executable", "source_commit"] {
            let original = value[key].clone();
            value[key] = "../other".into();
            write(&value);
            assert!(resolve(temp.path()).is_err(), "{key}");
            value[key] = original;
        }
        write(&value);
        fs::write(bin.join(executable), b"changed").unwrap();
        assert!(resolve(temp.path()).is_err());
        fs::remove_file(bin.join(executable)).unwrap();
        assert!(resolve(temp.path()).is_err());
    }
}
