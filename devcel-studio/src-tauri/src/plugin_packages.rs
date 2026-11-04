//! Plugin packages for offline distribution. Never executes JavaScript here.
//! Callers must validate external paths against Tauri's user-selected filesystem scope.
//! Inspect ZIPs without extracting; return entry source only after SHA-256-bound approval and execution permission.
//! index.enabled is the installation safety latch; the settings project owns the user's selection.
use devcel_core::AppError;
use semver::{Version, VersionReq};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Cursor, Read, Write},
    path::{Path, PathBuf},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MAX_ARCHIVE: u64 = 16 * 1024 * 1024;
const MAX_EXPANDED: u64 = 64 * 1024 * 1024;
const MAX_FILE: u64 = 16 * 1024 * 1024;
const MAX_CODE: usize = 8 * 1024 * 1024;
const MAX_MANIFEST: usize = 64 * 1024;
const MAX_ENTRIES: usize = 256;
const MAX_RATIO: u64 = 100;
const MAX_HISTORY: usize = 5;
const MAX_INDEX: u64 = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginMetadata {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub author: String,
    pub devcel_version: String,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub dependencies: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keywords: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginManifest {
    pub format_version: u32,
    pub metadata: PluginMetadata,
    pub main: String,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub resources: devcel_core::plugin_resources::ResourceManifest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPluginPackage {
    pub metadata: PluginMetadata,
    pub permissions: Vec<String>,
    pub digest: String,
    pub approved: bool,
    pub enabled: bool,
    pub can_rollback: bool,
    pub rollback_digest: Option<String>,
    pub migrated_from_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_warning: Option<AppError>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagePreview {
    pub metadata: PluginMetadata,
    pub permissions: Vec<String>,
    pub digest: String,
    pub compatible: bool,
    pub compatibility_errors: Vec<AppError>,
    pub dependency_issues: Vec<AppError>,
    pub installed_version: Option<String>,
    /// new / same / update / downgrade / same-version-different-content
    pub conflict: String,
    pub entry_count: usize,
    pub expanded_bytes: u64,
}

#[derive(Debug, Serialize)]
pub struct InstalledPluginSource {
    pub metadata: PluginMetadata,
    pub code: String,
    pub trusted: bool,
    pub digest: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Record {
    digest: String,
    approved_digest: Option<String>,
    enabled: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Index {
    #[serde(default)]
    installed: BTreeMap<String, Record>,
    #[serde(default)]
    history: BTreeMap<String, Vec<Record>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct InheritedPackages {
    version: String,
    installed: BTreeMap<String, String>,
}

struct ValidatedPackage {
    manifest: PluginManifest,
    code: String,
    bytes: Vec<u8>,
    digest: String,
    entry_count: usize,
    expanded_bytes: u64,
    resources: devcel_core::plugin_resources::ResourceTables,
}

pub struct PackageStore {
    root: PathBuf,
    app_version: Version,
    settings_config: Option<PathBuf>,
}

fn coded(code: &str, params: serde_json::Value) -> AppError {
    AppError::code(code, params)
}
fn err(code: &str, error: impl std::fmt::Display) -> AppError {
    coded(code, json!({ "details": error.to_string() }))
}
fn failures(errors: Vec<AppError>) -> AppError {
    AppError::Diagnostics {
        diagnostics: errors.into_iter().map(AppError::into_diagnostic).collect(),
    }
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c))
        && !id.contains("..")
        && !id.ends_with('.')
}

fn check_id(id: &str) -> Result<(), AppError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(coded("plugin.package.error.id", json!({"id": id})))
    }
}

pub(crate) fn valid_digest(digest: &str) -> bool {
    digest.len() == 64
        && digest
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}

/// Allow only relative paths with consistent names across operating systems. Never extract ZIPs to disk.
fn check_path(name: &str, directory: bool) -> Result<String, AppError> {
    if name.is_empty() || name.len() > 512 || name.starts_with('/') || name.contains('\\') {
        return Err(coded("plugin.package.error.zipPath", json!({"path": name})));
    }
    let normalized = if directory {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if normalized.is_empty() {
        return Err(coded("plugin.package.error.zipPathEmpty", json!({})));
    }
    for part in normalized.split('/') {
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
        {
            return Err(coded("plugin.package.error.zipPath", json!({"path": name})));
        }
        let stem = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (stem.len() == 4
                && (stem.starts_with("COM") || stem.starts_with("LPT"))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(coded(
                "plugin.package.error.reservedPath",
                json!({"path": name}),
            ));
        }
    }
    Ok(normalized.to_owned())
}

// Support npm-style whitespace AND, ||, exact, ^, ~, and *. Convert bare Rust caret versions to exact versions.
fn parse_ranges(range: &str) -> Result<Vec<VersionReq>, AppError> {
    if range.is_empty() || range.len() > 200 {
        return Err(coded(
            "plugin.package.error.versionConstraint",
            json!({"range": range}),
        ));
    }
    range
        .split("||")
        .map(|alternative| {
            let alt = alternative.trim();
            if alt.is_empty() {
                return Err(coded(
                    "plugin.package.error.versionConstraint",
                    json!({"range": range}),
                ));
            }
            let separated = alt.replace(',', " ");
            let tokens: Vec<&str> = separated.split_whitespace().collect();
            let normalized = if tokens.len() == 3 && tokens[1] == "-" {
                // Reject ambiguous hyphen ranges containing partial versions.
                Version::parse(tokens[0])
                    .map_err(|e| err("plugin.package.error.versionParse", e))?;
                Version::parse(tokens[2])
                    .map_err(|e| err("plugin.package.error.versionParse", e))?;
                format!(">={}, <={}", tokens[0], tokens[2])
            } else {
                let mut comparators = Vec::<String>::new();
                let mut pending = String::new();
                for token in tokens {
                    if matches!(token, ">=" | "<=" | ">" | "<" | "=" | "^" | "~") {
                        if !pending.is_empty() {
                            return Err(coded(
                                "plugin.package.error.versionConstraint",
                                json!({"range": range}),
                            ));
                        }
                        pending = token.to_owned();
                    } else {
                        let token = format!("{pending}{token}");
                        pending.clear();
                        comparators.push(
                            if token.as_bytes().first().is_some_and(u8::is_ascii_digit) {
                                format!("={token}")
                            } else {
                                token
                            },
                        );
                    }
                }
                if !pending.is_empty() {
                    return Err(coded(
                        "plugin.package.error.versionConstraint",
                        json!({"range": range}),
                    ));
                }
                comparators.join(", ")
            };
            VersionReq::parse(&normalized).map_err(|e| err("plugin.package.error.versionParse", e))
        })
        .collect()
}

fn satisfies(version: &str, range: &str) -> Result<bool, AppError> {
    let version =
        Version::parse(version).map_err(|e| err("plugin.package.error.versionParse", e))?;
    Ok(parse_ranges(range)?.iter().any(|req| req.matches(&version)))
}

pub(crate) fn validate_manifest(manifest: &PluginManifest) -> Result<(), AppError> {
    if manifest.format_version != 1 {
        return Err(coded(
            "plugin.package.error.formatVersion",
            json!({"actual": manifest.format_version, "supported": 1}),
        ));
    }
    let m = &manifest.metadata;
    check_id(&m.id)?;
    // Reject collisions with built-in definitions even when replacement is allowed.
    if m.id == "csv-exporter" {
        return Err(coded("plugin.package.error.builtinId", json!({"id": m.id})));
    }
    if m.name.trim().is_empty()
        || m.author.trim().is_empty()
        || m.name.len() > 200
        || m.author.len() > 200
        || m.description.len() > 4000
    {
        return Err(coded("plugin.package.error.metadata", json!({})));
    }
    Version::parse(&m.version).map_err(|e| err("plugin.package.error.versionParse", e))?;
    parse_ranges(&m.devcel_version)?;
    if let Some(api) = &m.api_version {
        Version::parse(api).map_err(|e| err("plugin.package.error.versionParse", e))?;
    }
    if m.dependencies.len() > 64 {
        return Err(coded(
            "plugin.package.error.dependencyLimit",
            json!({"max": 64}),
        ));
    }
    for (id, range) in &m.dependencies {
        check_id(id)?;
        if id == &m.id {
            return Err(coded(
                "plugin.package.error.selfDependency",
                json!({"id": m.id}),
            ));
        }
        parse_ranges(range)?;
    }
    check_path(&manifest.main, false)?;
    if !manifest.main.ends_with(".js") {
        return Err(coded(
            "plugin.package.error.mainExtension",
            json!({"path": manifest.main}),
        ));
    }
    if manifest.permissions != ["full-app-access"] {
        return Err(coded("plugin.package.error.permissions", json!({})));
    }
    let required: BTreeSet<&str> = [
        (!manifest.resources.settings_tables.is_empty()).then_some("settings-tables"),
        (!manifest.resources.translation_tables.is_empty()).then_some("translation-tables"),
    ]
    .into_iter()
    .flatten()
    .collect();
    let declared: BTreeSet<&str> = manifest.capabilities.iter().map(String::as_str).collect();
    if declared != required || declared.len() != manifest.capabilities.len() {
        return Err(coded("plugin.resources.error.capabilities", json!({})));
    }
    Ok(())
}

fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, AppError> {
    let metadata = fs::symlink_metadata(path).map_err(|e| coded("plugin.package.error.pathCause", json!({ "path": path.to_string_lossy(), "error": err("plugin.package.error.readFailed", e) })))?;
    if !metadata.file_type().is_file() || metadata.len() > limit {
        return Err(coded(
            "plugin.package.error.regularFileLimit",
            json!({"path": path.to_string_lossy(), "max": limit}),
        ));
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|e| err("plugin.package.error.readFailed", e))?
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| err("plugin.package.error.readFailed", e))?;
    if bytes.len() as u64 > limit {
        return Err(coded(
            "plugin.package.error.fileLimit",
            json!({"path": path.to_string_lossy(), "max": limit}),
        ));
    }
    Ok(bytes)
}

/// Check entry counts before constructing ZipArchive. Small packages do not need ZIP64 or split ZIP support.
fn preflight_zip(bytes: &[u8]) -> Result<usize, AppError> {
    if bytes.len() < 22 || bytes.len() as u64 > MAX_ARCHIVE {
        return Err(coded(
            "plugin.package.error.zipSize",
            json!({"max": MAX_ARCHIVE}),
        ));
    }
    let start = bytes.len().saturating_sub(65557);
    let end = (start..=bytes.len() - 22)
        .rev()
        .find(|&i| {
            bytes[i..i + 4] == *b"PK\x05\x06"
                && i + 22 + u16::from_le_bytes([bytes[i + 20], bytes[i + 21]]) as usize
                    == bytes.len()
        })
        .ok_or_else(|| coded("plugin.package.error.zipEnd", json!({})))?;
    let u16_at = |offset| u16::from_le_bytes([bytes[end + offset], bytes[end + offset + 1]]);
    let u32_at =
        |offset| u32::from_le_bytes(bytes[end + offset..end + offset + 4].try_into().unwrap());
    let count = u16_at(10) as usize;
    if u16_at(4) != 0
        || u16_at(6) != 0
        || u16_at(8) as usize != count
        || count == 0
        || count > MAX_ENTRIES
    {
        return Err(coded(
            "plugin.package.error.zipFormat",
            json!({"max": MAX_ENTRIES}),
        ));
    }
    let central_end = u32_at(16) as u64 + u32_at(12) as u64;
    if central_end != end as u64 {
        return Err(coded("plugin.package.error.zipStructure", json!({})));
    }
    // Also verify that the EOCD count covers the actual central directory.
    // The library reads only the declared count and ignores hidden trailing entries.
    let mut cursor = u32_at(16) as usize;
    for _ in 0..count {
        if cursor.checked_add(46).is_none_or(|next| next > end)
            || bytes[cursor..cursor + 4] != *b"PK\x01\x02"
        {
            return Err(coded("plugin.package.error.zipCentral", json!({})));
        }
        let length = |offset| {
            u16::from_le_bytes([bytes[cursor + offset], bytes[cursor + offset + 1]]) as usize
        };
        cursor += 46 + length(28) + length(30) + length(32);
        if cursor > end {
            return Err(coded("plugin.package.error.zipCentral", json!({})));
        }
    }
    if cursor != end {
        return Err(coded("plugin.package.error.zipCount", json!({})));
    }
    Ok(count)
}

fn validate_package(bytes: Vec<u8>) -> Result<ValidatedPackage, AppError> {
    let declared_entries = preflight_zip(&bytes)?;
    let mut archive = ZipArchive::new(Cursor::new(&bytes))
        .map_err(|e| err("plugin.package.error.archiveRead", e))?;
    // zip::ZipArchive combines same-named entries in an IndexMap, requiring comparison with the EOCD.
    if archive.len() != declared_entries {
        return Err(coded("plugin.package.error.zipCount", json!({})));
    }
    if archive.len() > MAX_ENTRIES {
        return Err(coded(
            "plugin.package.error.zipEntryLimit",
            json!({"max": MAX_ENTRIES}),
        ));
    }
    let mut names = BTreeMap::<String, (String, bool)>::new();
    let mut explicit_names = BTreeSet::new();
    let mut files = BTreeMap::<String, Vec<u8>>::new();
    let mut total = 0u64;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| err("plugin.package.error.archiveRead", e))?;
        let raw_name = std::str::from_utf8(file.name_raw())
            .map_err(|_| coded("plugin.package.error.zipNameEncoding", json!({})))?
            .to_owned();
        if file.name() != raw_name {
            return Err(coded("plugin.package.error.zipNameMismatch", json!({})));
        }
        if file.encrypted() {
            return Err(coded("plugin.package.error.zipEncrypted", json!({})));
        }
        let directory = file.is_dir();
        let name = check_path(&raw_name, directory)?;
        if let Some(mode) = file.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != if directory { 0o040000 } else { 0o100000 } {
                return Err(coded(
                    "plugin.package.error.zipSpecial",
                    json!({"path": name}),
                ));
            }
        }
        if !explicit_names.insert(name.to_lowercase()) {
            return Err(coded(
                "plugin.package.error.zipCollision",
                json!({"path": name}),
            ));
        }
        let parts: Vec<_> = name.split('/').collect();
        for n in 1..=parts.len() {
            let part = parts[..n].join("/");
            let is_dir = n < parts.len() || directory;
            if let Some((original, was_dir)) = names.get(&part.to_lowercase()) {
                if original != &part || *was_dir != is_dir {
                    return Err(coded(
                        "plugin.package.error.zipCollision",
                        json!({"path": name}),
                    ));
                }
            } else {
                names.insert(part.to_lowercase(), (part, is_dir));
            }
        }
        if directory {
            if file.size() != 0 {
                return Err(coded(
                    "plugin.package.error.zipDirectoryData",
                    json!({"path": name}),
                ));
            }
            continue;
        }
        if !matches!(
            file.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(coded("plugin.package.error.zipCompression", json!({})));
        }
        let size = file.size();
        total = total
            .checked_add(size)
            .ok_or_else(|| coded("plugin.package.error.zipExpandedSize", json!({})))?;
        if size > MAX_FILE
            || total > MAX_EXPANDED
            || size > file.compressed_size().max(1).saturating_mul(MAX_RATIO)
        {
            return Err(coded("plugin.package.error.zipBomb", json!({})));
        }
        let mut content = Vec::new();
        file.by_ref()
            .take(size + 1)
            .read_to_end(&mut content)
            .map_err(|e| err("plugin.package.error.archiveRead", e))?;
        if content.len() as u64 != size {
            return Err(coded(
                "plugin.package.error.zipDeclaredSize",
                json!({"path": name}),
            ));
        }
        files.insert(name, content);
    }
    let manifest_bytes = files
        .get("plugin.json")
        .ok_or_else(|| coded("plugin.package.error.manifestMissing", json!({})))?;
    if manifest_bytes.len() > MAX_MANIFEST {
        return Err(coded(
            "plugin.package.error.manifestSize",
            json!({"max": MAX_MANIFEST}),
        ));
    }
    let manifest_text = std::str::from_utf8(manifest_bytes)
        .map_err(|_| coded("plugin.package.error.manifestEncoding", json!({})))?;
    let manifest: PluginManifest = serde_json::from_str(manifest_text)
        .map_err(|e| err("plugin.package.error.manifestParse", e))?;
    validate_manifest(&manifest)?;
    let code_bytes = files.get(&manifest.main).ok_or_else(|| {
        coded(
            "plugin.package.error.mainMissing",
            json!({"path": manifest.main}),
        )
    })?;
    if code_bytes.is_empty() || code_bytes.len() > MAX_CODE {
        return Err(coded(
            "plugin.package.error.mainSize",
            json!({"max": MAX_CODE}),
        ));
    }
    let code = std::str::from_utf8(code_bytes)
        .map_err(|_| coded("plugin.package.error.mainEncoding", json!({})))?
        .to_owned();
    let resources = devcel_core::plugin_resources::validate_resources(
        &manifest.metadata.id,
        &manifest.resources,
        &files,
    )
    .map_err(AppError::from)?;
    let entry_count = archive.len();
    drop(archive);
    Ok(ValidatedPackage {
        manifest,
        code,
        digest: format!("{:x}", Sha256::digest(&bytes)),
        bytes,
        entry_count,
        expanded_bytes: total,
        resources,
    })
}

/// Each application release owns its package index, approvals, and archive copies.
/// Never reads the pre-versioning package store. A completed older stable profile
/// is a one-time seed; later changes in either release cannot affect the other.
pub fn versioned_store(data_root: &Path, app_version: &str) -> Result<PackageStore, AppError> {
    let current =
        Version::parse(app_version).map_err(|e| err("plugin.package.error.versionParse", e))?;
    if current.to_string() != app_version || app_version.len() > 128 {
        return Err(coded(
            "plugin.package.error.appVersion",
            json!({"version": app_version}),
        ));
    }
    profile_directory(data_root)?;
    let profiles = data_root.join("plugin-versions");
    profile_directory(&profiles)?;
    // This lock is outside the directory being published, so separate processes
    // cannot race initialization and no partially copied store becomes visible.
    let lock_path = profiles.join("initialize.lock");
    match fs::symlink_metadata(&lock_path) {
        Ok(meta) if !meta.is_file() => {
            return Err(coded("plugin.package.error.profileLock", json!({})))
        }
        Ok(_) => (),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(err("plugin.package.error.lockFailed", e)),
    }
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(&lock_path)
        .map_err(|e| err("plugin.package.error.lockFailed", e))?;
    lock.lock()
        .map_err(|e| err("plugin.package.error.lockFailed", e))?;
    let destination = profiles.join(app_version);
    match fs::symlink_metadata(&destination) {
        Ok(meta) => {
            if !meta.is_dir() || !profile_complete(&destination, app_version) {
                return Err(coded(
                    "plugin.package.error.profileUnsafe",
                    json!({"path": destination.to_string_lossy()}),
                ));
            }
            let store = PackageStore::new(destination, app_version)?;
            let _store_lock = store.lock()?;
            store.read_index()?;
            return Ok(store);
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(e) => return Err(err("plugin.package.error.readFailed", e)),
    }
    let mut candidates = Vec::new();
    for (count, entry) in fs::read_dir(&profiles)
        .map_err(|e| err("plugin.package.error.readFailed", e))?
        .enumerate()
    {
        if count >= 4096 {
            return Err(coded(
                "plugin.package.error.profileLimit",
                json!({"max": 4096}),
            ));
        }
        let entry = entry.map_err(|e| err("plugin.package.error.readFailed", e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(version) = Version::parse(&name) else {
            continue;
        };
        if version.to_string() != name
            || !version.pre.is_empty()
            || !version.cmp_precedence(&current).is_lt()
        {
            continue;
        }
        if !entry
            .file_type()
            .map_err(|e| err("plugin.package.error.readFailed", e))?
            .is_dir()
        {
            return Err(coded(
                "plugin.package.error.profileDirectory",
                json!({"path": entry.path().to_string_lossy()}),
            ));
        }
        if profile_complete(&entry.path(), &name) {
            candidates.push((version, name, entry.path()));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp_precedence(&b.0).then(a.1.cmp(&b.1)));
    let staging = profiles.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| err("plugin.package.error.writeFailed", e))?;
    let result = (|| {
        let target = PackageStore::new(staging.clone(), app_version)?;
        if let Some((_, version, path)) = candidates.last() {
            let source = PackageStore::new(path.clone(), version)?;
            let _source_lock = source.lock()?;
            let index = source.read_index()?;
            let mut digests = BTreeMap::new();
            let mut total = 0u64;
            for (id, record) in index.installed.iter().chain(
                index
                    .history
                    .iter()
                    .flat_map(|(id, records)| records.iter().map(move |record| (id, record))),
            ) {
                if let Some(previous_id) = digests.get(&record.digest) {
                    if previous_id != id {
                        return Err(coded("plugin.package.error.seedIds", json!({})));
                    }
                    continue;
                }
                digests.insert(record.digest.clone(), id.clone());
                if digests.len() > 1024 {
                    return Err(coded(
                        "plugin.package.error.seedCount",
                        json!({"max": 1024}),
                    ));
                }
                let package = source.load(id, record)?;
                total += package.bytes.len() as u64;
                if total > 128 * 1024 * 1024 {
                    return Err(coded("plugin.package.error.seedSize", json!({})));
                }
                target.atomic_write(&target.blob_path(&record.digest), &package.bytes)?;
            }
            target.save_index(&index)?;
            let inherited = InheritedPackages {
                version: version.clone(),
                installed: index
                    .installed
                    .iter()
                    .map(|(id, r)| (id.clone(), r.digest.clone()))
                    .collect(),
            };
            target.atomic_write(
                &staging.join(".inherited.json"),
                &serde_json::to_vec(&inherited)
                    .map_err(|e| err("plugin.package.error.migration", e))?,
            )?;
        } else {
            target.save_index(&Index::default())?;
        }
        target.atomic_write(&staging.join(".complete"), app_version.as_bytes())?;
        fs::rename(&staging, &destination)
            .map_err(|e| err("plugin.package.error.writeFailed", e))?;
        #[cfg(unix)]
        File::open(&profiles)
            .and_then(|directory| directory.sync_all())
            .map_err(|e| err("plugin.package.error.writeFailed", e))?;
        PackageStore::new(destination, app_version)
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn profile_directory(path: &Path) -> Result<(), AppError> {
    // Check existing ancestors as well: create_dir_all otherwise follows a link.
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) if !meta.is_dir() => {
                return Err(coded(
                    "plugin.package.error.profileAncestors",
                    json!({"path": ancestor.to_string_lossy()}),
                ))
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(err("plugin.package.error.readFailed", e)),
        }
    }
    fs::create_dir_all(path).map_err(|e| err("plugin.package.error.writeFailed", e))
}

fn profile_complete(path: &Path, version: &str) -> bool {
    read_bounded(&path.join(".complete"), 128).is_ok_and(|bytes| bytes == version.as_bytes())
        && fs::symlink_metadata(path.join("index.json")).is_ok_and(|meta| meta.is_file())
}

impl PackageStore {
    pub fn new(root: PathBuf, app_version: &str) -> Result<Self, AppError> {
        Ok(Self {
            root,
            settings_config: None,
            app_version: Version::parse(app_version)
                .map_err(|e| err("plugin.package.error.versionParse", e))?,
        })
    }

    pub fn with_settings_config(mut self, config: PathBuf) -> Self {
        self.settings_config = Some(config);
        self
    }

    fn lock(&self) -> Result<File, AppError> {
        fs::create_dir_all(&self.root).map_err(|e| err("plugin.package.error.writeFailed", e))?;
        if fs::symlink_metadata(&self.root)
            .map_err(|e| err("plugin.package.error.readFailed", e))?
            .file_type()
            .is_symlink()
        {
            return Err(coded(
                "plugin.package.error.storeSymlink",
                json!({"path": self.root.to_string_lossy()}),
            ));
        }
        let path = self.root.join("store.lock");
        if let Ok(metadata) = fs::symlink_metadata(&path) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(coded(
                    "plugin.package.error.storeLock",
                    json!({"path": path.to_string_lossy()}),
                ));
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(path)
            .map_err(|e| err("plugin.package.error.lockFailed", e))?;
        file.lock()
            .map_err(|e| err("plugin.package.error.lockFailed", e))?;
        if let Some(config) = &self.settings_config {
            crate::settings_resources_store::recover_resources(
                config,
                &self.root.join("index.json"),
            )?;
        }
        Ok(file)
    }

    fn read_index(&self) -> Result<Index, AppError> {
        let path = self.root.join("index.json");
        let index: Index = if path
            .try_exists()
            .map_err(|e| err("plugin.package.error.readFailed", e))?
        {
            serde_json::from_slice(&read_bounded(&path, MAX_INDEX)?)
                .map_err(|e| err("plugin.package.error.indexParse", e))?
        } else {
            Index::default()
        };
        for (id, record) in &index.installed {
            check_id(id)?;
            Self::check_record(record)?;
        }
        for (id, records) in &index.history {
            check_id(id)?;
            if records.len() > MAX_HISTORY {
                return Err(coded(
                    "plugin.package.error.historyLimit",
                    json!({"max": MAX_HISTORY}),
                ));
            }
            for record in records {
                Self::check_record(record)?;
            }
        }
        Ok(index)
    }

    fn check_record(record: &Record) -> Result<(), AppError> {
        if !valid_digest(&record.digest)
            || record
                .approved_digest
                .as_ref()
                .is_some_and(|d| !valid_digest(d))
        {
            return Err(coded("plugin.package.error.digest", json!({})));
        }
        Ok(())
    }

    fn atomic_write(&self, path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        let parent = path.parent().ok_or_else(|| {
            coded(
                "plugin.package.error.destinationParent",
                json!({"path": path.to_string_lossy()}),
            )
        })?;
        let temporary = parent.join(format!(".package-{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|e| err("plugin.package.error.writeFailed", e))?;
            file.write_all(bytes)
                .map_err(|e| err("plugin.package.error.writeFailed", e))?;
            file.sync_all()
                .map_err(|e| err("plugin.package.error.writeFailed", e))?;
            drop(file);
            fs::rename(&temporary, path).map_err(|e| err("plugin.package.error.writeFailed", e))?;
            #[cfg(unix)]
            File::open(parent)
                .and_then(|directory| directory.sync_all())
                .map_err(|e| err("plugin.package.error.writeFailed", e))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    fn save_index(&self, index: &Index) -> Result<(), AppError> {
        let bytes = serde_json::to_vec_pretty(index)
            .map_err(|e| err("plugin.package.error.writeFailed", e))?;
        if bytes.len() as u64 > MAX_INDEX {
            return Err(coded(
                "plugin.package.error.indexSize",
                json!({"max": MAX_INDEX}),
            ));
        }
        self.atomic_write(&self.root.join("index.json"), &bytes)
    }

    fn blob_path(&self, digest: &str) -> PathBuf {
        self.root.join(format!("{digest}.zip"))
    }

    fn load(&self, id: &str, record: &Record) -> Result<ValidatedPackage, AppError> {
        Self::check_record(record)?;
        let package =
            validate_package(read_bounded(&self.blob_path(&record.digest), MAX_ARCHIVE)?)?;
        if package.digest != record.digest || package.manifest.metadata.id != id {
            return Err(coded(
                "plugin.package.error.changedImport",
                json!({"id": id}),
            ));
        }
        Ok(package)
    }

    fn dto(
        &self,
        id: &str,
        record: &Record,
        index: &Index,
    ) -> Result<InstalledPluginPackage, AppError> {
        let package = self.load(id, record)?;
        let approved = record.approved_digest.as_ref() == Some(&package.digest);
        let compatible = self.compatibility_errors(&package.manifest).is_empty();
        let inherited = self.root.join(".inherited.json");
        let migrated_from_version = if inherited
            .try_exists()
            .map_err(|e| err("plugin.package.error.migration", e))?
        {
            let saved: InheritedPackages =
                serde_json::from_slice(&read_bounded(&inherited, MAX_INDEX)?)
                    .map_err(|e| err("plugin.package.error.migration", e))?;
            Version::parse(&saved.version)
                .map_err(|e| err("plugin.package.error.versionParse", e))?;
            (saved.installed.get(id) == Some(&record.digest)).then_some(saved.version)
        } else {
            None
        };
        Ok(InstalledPluginPackage {
            resource_warning: None,
            migrated_from_version,
            metadata: package.manifest.metadata,
            permissions: package.manifest.permissions,
            digest: package.digest,
            approved,
            enabled: approved && record.enabled && compatible,
            can_rollback: index.history.get(id).is_some_and(|h| !h.is_empty()),
            rollback_digest: index
                .history
                .get(id)
                .and_then(|h| h.last())
                .map(|record| record.digest.clone()),
        })
    }

    fn compatibility_errors(&self, manifest: &PluginManifest) -> Vec<AppError> {
        let mut errors = vec![];
        if !satisfies(
            &self.app_version.to_string(),
            &manifest.metadata.devcel_version,
        )
        .unwrap_or(false)
        {
            errors.push(coded("plugin.package.error.hostVersion", json!({"required": manifest.metadata.devcel_version, "current": self.app_version.to_string()})));
        }
        if manifest.metadata.api_version.as_deref() != Some("2.0.0") {
            errors.push(match &manifest.metadata.api_version {
                Some(actual) => coded(
                    "plugin.package.error.apiVersion",
                    json!({"required": "2.0.0", "actual": actual}),
                ),
                None => coded(
                    "plugin.package.error.apiVersionMissing",
                    json!({"required": "2.0.0"}),
                ),
            });
        }
        errors
    }

    fn dependency_issues(
        &self,
        metadata: &PluginMetadata,
        index: &Index,
        require_enabled: bool,
    ) -> Vec<AppError> {
        let mut issues = Vec::new();
        for (id, range) in &metadata.dependencies {
            if let Some(record) = index.installed.get(id) {
                match self.load(id, record) {
                    Ok(package) => {
                        if !satisfies(&package.manifest.metadata.version, range).unwrap_or(false) {
                            issues.push(coded("plugin.package.error.dependencyVersion", json!({"id": id, "required": range, "current": package.manifest.metadata.version})));
                        }
                        if require_enabled
                            && (!record.enabled
                                || record.approved_digest.as_ref() != Some(&record.digest))
                        {
                            issues.push(coded(
                                "plugin.package.error.dependencyDisabled",
                                json!({"id": id}),
                            ));
                        }
                    }
                    Err(error) => issues.push(error),
                }
            } else if let Some(version) = match id.as_str() {
                "csv-exporter" => Some("1.2.0"),
                _ => None,
            } {
                // PluginManager performs the final check of built-in plugins' active state.
                if !satisfies(version, range).unwrap_or(false) {
                    issues.push(coded(
                        "plugin.package.error.builtinVersion",
                        json!({"id": id, "current": version, "required": range}),
                    ));
                }
            } else {
                issues.push(coded(
                    "plugin.package.error.dependencyMissing",
                    json!({"id": id, "required": range}),
                ));
            }
        }
        issues
    }

    fn preview(
        &self,
        package: &ValidatedPackage,
        index: &Index,
    ) -> Result<PackagePreview, AppError> {
        let metadata = &package.manifest.metadata;
        let installed = index
            .installed
            .get(&metadata.id)
            .map(|r| self.load(&metadata.id, r))
            .transpose()?;
        let conflict = match &installed {
            None => "new",
            Some(old) if old.digest == package.digest => "same",
            Some(old) => match Version::parse(&metadata.version)
                .unwrap()
                .cmp_precedence(&Version::parse(&old.manifest.metadata.version).unwrap())
            {
                std::cmp::Ordering::Greater => "update",
                std::cmp::Ordering::Less => "downgrade",
                std::cmp::Ordering::Equal => "same-version-different-content",
            },
        };
        let compatibility_errors = self.compatibility_errors(&package.manifest);
        Ok(PackagePreview {
            metadata: metadata.clone(),
            permissions: package.manifest.permissions.clone(),
            digest: package.digest.clone(),
            compatible: compatibility_errors.is_empty(),
            compatibility_errors,
            dependency_issues: self.dependency_issues(metadata, index, false),
            installed_version: installed.map(|p| p.manifest.metadata.version),
            conflict: conflict.into(),
            entry_count: package.entry_count,
            expanded_bytes: package.expanded_bytes,
        })
    }

    pub fn preview_package(&self, path: &Path) -> Result<PackagePreview, AppError> {
        let package = validate_package(read_bounded(path, MAX_ARCHIVE)?)?;
        let _lock = self.lock()?;
        self.preview(&package, &self.read_index()?)
    }

    pub fn list(&self) -> Result<Vec<InstalledPluginPackage>, AppError> {
        let _lock = self.lock()?;
        let index = self.read_index()?;
        index
            .installed
            .iter()
            .map(|(id, record)| self.dto(id, record, &index))
            .collect()
    }

    /// List the latest removed versions so removal can be undone after restarting.
    pub fn list_removed(&self) -> Result<Vec<InstalledPluginPackage>, AppError> {
        let _lock = self.lock()?;
        let index = self.read_index()?;
        index
            .history
            .iter()
            .filter(|(id, _)| !index.installed.contains_key(*id))
            .filter_map(|(id, history)| history.last().map(|record| (id, record)))
            .map(|(id, record)| {
                let mut dto = self.dto(id, record, &index)?;
                dto.enabled = false;
                Ok(dto)
            })
            .collect()
    }

    fn push_history(index: &mut Index, id: &str, record: Record) {
        let history = index.history.entry(id.to_owned()).or_default();
        history.push(record);
        if history.len() > MAX_HISTORY {
            history.remove(0);
        }
    }

    pub fn install(
        &self,
        path: &Path,
        expected_digest: &str,
        conflict_policy: &str,
    ) -> Result<InstalledPluginPackage, AppError> {
        if !matches!(conflict_policy, "reject" | "replace" | "allow-downgrade") {
            return Err(coded(
                "plugin.package.error.replacement",
                json!({"mode": conflict_policy}),
            ));
        }
        let package = validate_package(read_bounded(path, MAX_ARCHIVE)?)?;
        if package.digest != expected_digest {
            return Err(coded("plugin.package.error.zipChanged", json!({})));
        }
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let preview = self.preview(&package, &index)?;
        if !preview.compatible {
            return Err(failures(preview.compatibility_errors));
        }
        let id = &package.manifest.metadata.id;
        if preview.conflict == "same" {
            return self.dto(id, index.installed.get(id).unwrap(), &index);
        }
        if preview.conflict == "downgrade" && conflict_policy != "allow-downgrade" {
            return Err(coded("plugin.package.error.downgrade", json!({})));
        }
        if preview.conflict != "new" && conflict_policy == "reject" {
            return Err(coded("plugin.package.error.installedConflict", json!({})));
        }
        // Do not save updates that break approved dependencies. This boundary is separate from pausing in settings tables.
        self.check_dependents(id, &index, true)?;
        let blob = self.blob_path(&package.digest);
        if blob
            .try_exists()
            .map_err(|e| err("plugin.package.error.readFailed", e))?
        {
            if read_bounded(&blob, MAX_ARCHIVE)? != package.bytes {
                return Err(coded("plugin.package.error.savedCorrupt", json!({})));
            }
        } else {
            self.atomic_write(&blob, &package.bytes)?;
        }
        let record = Record {
            digest: package.digest,
            approved_digest: None,
            enabled: false,
        };
        if let Some(old) = index.installed.insert(id.clone(), record.clone()) {
            Self::push_history(&mut index, id, old);
        }
        // Construct the response before publishing: a successful commit must not
        // become a retryable failure because a later DTO read fails.
        let mut result = self.dto(id, &record, &index)?;
        let mut resources = package.resources;
        if let Some(previous) = index.history.get(id).and_then(|records| records.last()) {
            resources.previous_tables = self.load(id, previous)?.resources.tables;
        }
        if let Some(config) = &self.settings_config {
            let index_path = self.root.join("index.json");
            let before = match fs::read(&index_path) {
                Ok(bytes) => Some(bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(AppError::from(error)),
            };
            let after = serde_json::to_vec_pretty(&index)
                .map_err(|e| err("plugin.package.error.writeFailed", e))?;
            if after.len() as u64 > MAX_INDEX {
                return Err(coded(
                    "plugin.package.error.indexSize",
                    json!({"max":MAX_INDEX}),
                ));
            }
            result.resource_warning = crate::settings_resources_store::register_resources(
                config,
                &resources,
                &index_path,
                before.as_deref(),
                &after,
            )?;
        } else if resources.tables.is_empty() {
            self.save_index(&index)?;
        } else {
            return Err(coded(
                "plugin.resources.error.registry",
                json!({"owner":id,"table":""}),
            ));
        }
        Ok(result)
    }

    pub fn approve(
        &self,
        plugin_id: &str,
        digest: &str,
        allow_full_app_access: bool,
    ) -> Result<InstalledPluginPackage, AppError> {
        check_id(plugin_id)?;
        if !allow_full_app_access {
            return Err(coded("plugin.package.error.approvalRequired", json!({})));
        }
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let record = index
            .installed
            .get_mut(plugin_id)
            .ok_or_else(|| coded("plugin.package.error.notFound", json!({"id": plugin_id})))?;
        self.load(plugin_id, record)?;
        if record.digest != digest {
            return Err(coded("plugin.package.error.changed", json!({})));
        }
        record.approved_digest = Some(digest.into());
        self.save_index(&index)?;
        self.dto(plugin_id, index.installed.get(plugin_id).unwrap(), &index)
    }

    pub fn source(
        &self,
        plugin_id: &str,
        expected_digest: &str,
    ) -> Result<InstalledPluginSource, AppError> {
        check_id(plugin_id)?;
        let _lock = self.lock()?;
        let index = self.read_index()?;
        let record = index
            .installed
            .get(plugin_id)
            .ok_or_else(|| coded("plugin.package.error.notFound", json!({"id": plugin_id})))?;
        if record.digest != expected_digest {
            return Err(coded("plugin.package.error.changed", json!({})));
        }
        if record.approved_digest.as_ref() != Some(&record.digest) {
            return Err(coded("plugin.package.error.notApproved", json!({})));
        }
        if !record.enabled {
            return Err(coded("plugin.package.error.notEnabled", json!({})));
        }
        let package = self.load(plugin_id, record)?;
        // Validate edited resources from the source project immediately before
        // returning executable code. A last-good cache never authorizes activation.
        if !package.resources.tables.is_empty() {
            let config = self.settings_config.as_ref().ok_or_else(|| {
                coded(
                    "plugin.resources.error.registry",
                    json!({"owner":plugin_id,"table":""}),
                )
            })?;
            let _snapshot = crate::app_settings_store::transaction_snapshot_lock(config)?;
            let source = crate::app_settings_store::read_source_locked(config)?;
            let project =
                devcel_core::localization::load(&crate::app_settings_store::project_path(config))
                    .map_err(AppError::from)?;
            let registry = project
                .tables_data
                .values()
                .find(|table| {
                    table.data.metadata.data_name == devcel_core::plugin_resources::REGISTRY_NAME
                })
                .ok_or_else(|| {
                    coded(
                        "plugin.resources.error.registry",
                        json!({"owner":plugin_id,"table":""}),
                    )
                })?;
            let bindings = devcel_core::plugin_resource_registry::bindings(
                &registry.data,
                &project.tables_data,
                &project.interface_registry,
            )
            .map_err(AppError::from)?;
            for table in &package.resources.tables {
                if !bindings.iter().any(|binding| {
                    binding.owner == plugin_id
                        && binding.id == table.id
                        && binding.target_uuid == table.table.uuid
                        && binding.kind == table.kind
                        && binding.cardinality == table.cardinality
                        && binding.contract_uuid == table.contract.uuid
                }) {
                    return Err(coded(
                        "plugin.resources.error.missing",
                        json!({"owner":plugin_id,"table":table.id}),
                    ));
                }
            }
            let _ = source;
        }
        let errors = self.compatibility_errors(&package.manifest);
        if !errors.is_empty() {
            return Err(failures(errors));
        }
        Ok(InstalledPluginSource {
            metadata: package.manifest.metadata,
            code: package.code,
            trusted: true,
            digest: package.digest,
        })
    }

    fn check_dependents(
        &self,
        id: &str,
        index: &Index,
        enabled_only: bool,
    ) -> Result<(), AppError> {
        for (other_id, record) in &index.installed {
            if other_id != id
                && (!enabled_only || record.enabled)
                && self
                    .load(other_id, record)?
                    .manifest
                    .metadata
                    .dependencies
                    .contains_key(id)
            {
                return Err(if enabled_only {
                    coded(
                        "plugin.package.error.dependentEnabled",
                        json!({"id": other_id}),
                    )
                } else {
                    coded(
                        "plugin.package.error.dependentInstalled",
                        json!({"id": other_id}),
                    )
                });
            }
        }
        Ok(())
    }

    fn check_cycle(
        &self,
        id: &str,
        index: &Index,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<(), AppError> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.into()) {
            return Err(coded(
                "plugin.package.error.dependencyCycle",
                json!({"id": id}),
            ));
        }
        if let Some(record) = index.installed.get(id) {
            for dependency in self.load(id, record)?.manifest.metadata.dependencies.keys() {
                self.check_cycle(dependency, index, visiting, visited)?;
            }
        }
        visiting.remove(id);
        visited.insert(id.into());
        Ok(())
    }

    pub fn set_enabled(
        &self,
        plugin_id: &str,
        expected_digest: &str,
        enabled: bool,
    ) -> Result<(), AppError> {
        check_id(plugin_id)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        let record = index
            .installed
            .get(plugin_id)
            .ok_or_else(|| coded("plugin.package.error.notFound", json!({"id": plugin_id})))?;
        if record.digest != expected_digest {
            return Err(coded("plugin.package.error.changed", json!({})));
        }
        let package = self.load(plugin_id, record)?;
        if enabled {
            if record.approved_digest.as_ref() != Some(&record.digest) {
                return Err(coded("plugin.package.error.notApproved", json!({})));
            }
            let mut issues = self.compatibility_errors(&package.manifest);
            issues.extend(self.dependency_issues(&package.manifest.metadata, &index, true));
            if !issues.is_empty() {
                return Err(failures(issues));
            }
            self.check_cycle(
                plugin_id,
                &index,
                &mut BTreeSet::new(),
                &mut BTreeSet::new(),
            )?;
        } else {
            self.check_dependents(plugin_id, &index, true)?;
        }
        index.installed.get_mut(plugin_id).unwrap().enabled = enabled;
        self.save_index(&index)
    }

    pub fn remove(&self, plugin_id: &str, expected_digest: &str) -> Result<(), AppError> {
        check_id(plugin_id)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        if index
            .installed
            .get(plugin_id)
            .map(|record| record.digest.as_str())
            != Some(expected_digest)
        {
            return Err(coded("plugin.package.error.changed", json!({})));
        }
        self.check_dependents(plugin_id, &index, false)?;
        let record = index
            .installed
            .remove(plugin_id)
            .ok_or_else(|| coded("plugin.package.error.notFound", json!({"id": plugin_id})))?;
        Self::push_history(&mut index, plugin_id, record);
        self.save_index(&index)
    }

    pub fn rollback(
        &self,
        plugin_id: &str,
        expected_digest: Option<&str>,
        expected_restore_digest: &str,
    ) -> Result<InstalledPluginPackage, AppError> {
        check_id(plugin_id)?;
        let _lock = self.lock()?;
        let mut index = self.read_index()?;
        if index
            .installed
            .get(plugin_id)
            .map(|record| record.digest.as_str())
            != expected_digest
            || index
                .history
                .get(plugin_id)
                .and_then(|history| history.last())
                .map(|record| record.digest.as_str())
                != Some(expected_restore_digest)
        {
            return Err(coded("plugin.package.error.historyChanged", json!({})));
        }
        self.check_dependents(plugin_id, &index, true)?;
        let mut previous = index
            .history
            .get_mut(plugin_id)
            .and_then(Vec::pop)
            .ok_or_else(|| coded("plugin.package.error.historyMissing", json!({})))?;
        let package = self.load(plugin_id, &previous)?;
        let errors = self.compatibility_errors(&package.manifest);
        if !errors.is_empty() {
            return Err(failures(errors));
        }
        // Retain approval for an unchanged digest, but do not run automatically; the UI explicitly calls loadPackage.
        previous.enabled = false;
        if let Some(current) = index.installed.insert(plugin_id.into(), previous.clone()) {
            Self::push_history(&mut index, plugin_id, current);
        }
        self.save_index(&index)?;
        self.dto(plugin_id, &previous, &index)
    }

    /// Read only the selected source directory. Reject symlinks, special files, and size-limit violations.
    pub fn export_directory(
        &self,
        directory: &Path,
        destination: &Path,
    ) -> Result<PackagePreview, AppError> {
        let metadata = fs::symlink_metadata(directory)
            .map_err(|e| err("plugin.package.error.readFailed", e))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(coded("plugin.package.error.sourceDirectory", json!({})));
        }
        let canonical_directory =
            fs::canonicalize(directory).map_err(|e| err("plugin.package.error.readFailed", e))?;
        let destination_parent = fs::canonicalize(
            destination
                .parent()
                .ok_or_else(|| coded("plugin.package.error.destination", json!({})))?,
        )
        .map_err(|e| err("plugin.package.error.readFailed", e))?;
        let destination = destination_parent.join(
            destination
                .file_name()
                .ok_or_else(|| coded("plugin.package.error.destinationName", json!({})))?,
        );
        if destination.starts_with(&canonical_directory) {
            return Err(coded("plugin.package.error.outputInsideSource", json!({})));
        }
        if let Ok(metadata) = fs::symlink_metadata(&destination) {
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(coded("plugin.package.error.destinationFile", json!({})));
            }
        }
        let mut files = BTreeMap::new();
        Self::collect_files(
            &canonical_directory,
            &canonical_directory,
            &mut files,
            &mut 0,
            &mut 0,
        )?;
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        // Use Stored compression for predictable size limits. Deflate ZIP imports are also supported.
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o644);
        for (name, bytes) in files {
            writer
                .start_file(name, options)
                .map_err(|e| err("plugin.package.error.archiveWrite", e))?;
            writer
                .write_all(&bytes)
                .map_err(|e| err("plugin.package.error.archiveWrite", e))?;
        }
        let bytes = writer
            .finish()
            .map_err(|e| err("plugin.package.error.archiveWrite", e))?
            .into_inner();
        let package = validate_package(bytes)?;
        let _lock = self.lock()?;
        let preview = self.preview(&package, &self.read_index()?)?;
        self.atomic_write(&destination, &package.bytes)?;
        Ok(preview)
    }

    fn collect_files(
        root: &Path,
        directory: &Path,
        files: &mut BTreeMap<String, Vec<u8>>,
        total: &mut u64,
        count: &mut usize,
    ) -> Result<(), AppError> {
        for entry in
            fs::read_dir(directory).map_err(|e| err("plugin.package.error.readFailed", e))?
        {
            let entry = entry.map_err(|e| err("plugin.package.error.readFailed", e))?;
            *count += 1;
            if *count > MAX_ENTRIES {
                return Err(coded(
                    "plugin.package.error.sourceCount",
                    json!({"max": MAX_ENTRIES}),
                ));
            }
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|e| err("plugin.package.error.readFailed", e))?;
            if file_type.is_symlink() || (!file_type.is_file() && !file_type.is_dir()) {
                return Err(coded(
                    "plugin.package.error.sourceSpecial",
                    json!({"path": path.to_string_lossy()}),
                ));
            }
            let name = path
                .strip_prefix(root)
                .map_err(|e| err("plugin.package.error.readFailed", e))?
                .to_str()
                .ok_or_else(|| coded("plugin.package.error.sourceEncoding", json!({})))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            check_path(&name, file_type.is_dir())?;
            if file_type.is_dir() {
                Self::collect_files(root, &path, files, total, count)?;
            } else {
                let bytes = read_bounded(&path, MAX_FILE)?;
                *total += bytes.len() as u64;
                if *total > MAX_ARCHIVE {
                    return Err(coded("plugin.package.error.sourceSize", json!({})));
                }
                files.insert(name, bytes);
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod version_profile_tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("plugin-profile-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn seed(store: &PackageStore, id: &str) -> String {
        let manifest = serde_json::json!({
            "formatVersion": 1,
            "metadata": { "id": id, "name": "Test", "version": "1.0.0",
                "description": "", "author": "Test", "devcelVersion": ">=1.0.0 <2.0.0",
                "apiVersion": "2.0.0" },
            "main": "main.js", "permissions": ["full-app-access"]
        });
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("plugin.json", options).unwrap();
        zip.write_all(serde_json::to_string(&manifest).unwrap().as_bytes())
            .unwrap();
        zip.start_file("main.js", options).unwrap();
        zip.write_all(b"export default {};").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let digest = validate_package(bytes.clone()).unwrap().digest;
        fs::write(store.blob_path(&digest), bytes).unwrap();
        let mut index = Index::default();
        index.installed.insert(
            id.to_owned(),
            Record {
                digest: digest.clone(),
                approved_digest: Some(digest.clone()),
                enabled: true,
            },
        );
        store.save_index(&index).unwrap();
        digest
    }

    #[test]
    fn retired_sample_is_not_a_built_in_package_or_implicit_dependency() {
        let scratch = Scratch::new();
        let store = versioned_store(&scratch.0, "1.0.0").unwrap();
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "formatVersion": 1,
            "metadata": { "id": "hello-world", "name": "User package", "version": "1.0.0",
                "description": "", "author": "Test", "devcelVersion": ">=1.0.0",
                "apiVersion": "2.0.0" },
            "main": "main.js", "permissions": ["full-app-access"]
        }))
        .unwrap();
        validate_manifest(&manifest).unwrap();
        let mut metadata = manifest.metadata.clone();
        metadata.id = "dependent-package".into();
        metadata
            .dependencies
            .insert("hello-world".into(), "*".into());
        let issues = store.dependency_issues(&metadata, &Index::default(), false);
        assert_eq!(
            serde_json::to_value(&issues).unwrap(),
            json!([{
                "kind": "code", "code": "plugin.package.error.dependencyMissing",
                "params": { "id": "hello-world", "required": "*" }
            }])
        );
        metadata.dependencies.clear();
        metadata
            .dependencies
            .insert("csv-exporter".into(), "^1.2.0".into());
        assert!(store
            .dependency_issues(&metadata, &Index::default(), false)
            .is_empty());
        let mut reserved = manifest;
        reserved.metadata.id = "csv-exporter".into();
        assert!(
            matches!(validate_manifest(&reserved).unwrap_err(), AppError::Code { code, .. } if code == "plugin.package.error.builtinId")
        );
    }

    #[test]
    fn isolated_upgrade_preserves_approval_but_gates_incompatible_enable() {
        let scratch = Scratch::new();
        let old = versioned_store(&scratch.0, "1.0.0").unwrap();
        let digest = seed(&old, "example");
        let old_index = fs::read(old.root.join("index.json")).unwrap();
        let new = versioned_store(&scratch.0, "2.0.0").unwrap();
        let packages = new.list().unwrap();
        assert_eq!(packages.len(), 1);
        assert!(packages[0].approved);
        assert_eq!(packages[0].migrated_from_version.as_deref(), Some("1.0.0"));
        assert!(!packages[0].enabled);
        assert!(old.list().unwrap()[0].enabled);
        assert_eq!(fs::read(old.root.join("index.json")).unwrap(), old_index);
        fs::remove_file(old.blob_path(&digest)).unwrap();
        assert_eq!(new.list().unwrap().len(), 1);
        assert_eq!(versioned_store(&scratch.0, "2.0.0").unwrap().root, new.root);
        seed(&new, "fresh-package");
        assert!(new.list().unwrap()[0].migrated_from_version.is_none());
    }

    #[test]
    fn selects_latest_stable_lower_version_and_ignores_legacy_and_partial() {
        let scratch = Scratch::new();
        let old = versioned_store(&scratch.0, "1.0.0").unwrap();
        seed(&old, "first");
        let newer = versioned_store(&scratch.0, "1.5.0").unwrap();
        seed(&newer, "latest");
        let preview = versioned_store(&scratch.0, "1.9.0-beta.1").unwrap();
        seed(&preview, "preview");
        fs::create_dir(scratch.0.join("plugin-versions/1.8.0")).unwrap();
        let future = versioned_store(&scratch.0, "3.0.0").unwrap();
        seed(&future, "future");
        fs::create_dir(scratch.0.join("plugin-versions/.staging-interrupted")).unwrap();
        fs::write(
            scratch
                .0
                .join("plugin-versions/.staging-interrupted/index.json"),
            b"partial",
        )
        .unwrap();
        let current = versioned_store(&scratch.0, "2.0.0").unwrap();
        assert_eq!(current.list().unwrap()[0].metadata.id, "latest");
        let clean = Scratch::new();
        fs::create_dir(clean.0.join("plugin-packages-v1")).unwrap();
        fs::write(
            clean.0.join("plugin-packages-v1/index.json"),
            b"invalid legacy",
        )
        .unwrap();
        assert!(versioned_store(&clean.0, "1.0.0")
            .unwrap()
            .list()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn exact_release_isolation_and_incomplete_target_fail_closed() {
        let scratch = Scratch::new();
        let a = versioned_store(&scratch.0, "1.0.0+one").unwrap();
        seed(&a, "example");
        let b = versioned_store(&scratch.0, "1.0.0+two").unwrap();
        assert_ne!(a.root, b.root);
        assert!(b.list().unwrap().is_empty()); // equal precedence is not an older release
        fs::create_dir(scratch.0.join("plugin-versions/2.0.0")).unwrap();
        assert!(versioned_store(&scratch.0, "2.0.0").is_err());
        assert!(versioned_store(&scratch.0, "../../escape").is_err());
    }

    #[test]
    fn concurrent_initialization_publishes_one_complete_store() {
        let scratch = Scratch::new();
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let root = scratch.0.clone();
                std::thread::spawn(move || versioned_store(&root, "1.0.0").unwrap().root)
            })
            .collect();
        for thread in threads {
            assert_eq!(
                thread.join().unwrap(),
                scratch.0.join("plugin-versions/1.0.0")
            );
        }
        assert!(profile_complete(
            &scratch.0.join("plugin-versions/1.0.0"),
            "1.0.0"
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_archive_aborts_without_publishing_or_changing_source() {
        use std::os::unix::fs::symlink;
        let scratch = Scratch::new();
        let old = versioned_store(&scratch.0, "1.0.0").unwrap();
        let digest = seed(&old, "example");
        let external = scratch.0.join("external.zip");
        fs::rename(old.blob_path(&digest), &external).unwrap();
        symlink(&external, old.blob_path(&digest)).unwrap();
        assert!(versioned_store(&scratch.0, "2.0.0").is_err());
        assert!(!scratch.0.join("plugin-versions/2.0.0").exists());
        assert!(external.exists());
        assert!(fs::read_dir(scratch.0.join("plugin-versions"))
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".staging-")));
    }
    fn example_manifest() -> PluginManifest {
        serde_json::from_value(json!({
            "formatVersion": 1,
            "metadata": { "id": "example", "name": "利用者の名前 {raw}", "version": "1.0.0", "description": "Invalid plugin ID", "author": "Test", "devcelVersion": ">=1.0.0", "apiVersion": "2.0.0" },
            "main": "main.js", "permissions": ["full-app-access"]
        })).unwrap()
    }

    #[test]
    fn manifest_and_preview_errors_are_structured_without_translating_plugin_text() {
        let mut manifest = example_manifest();
        validate_manifest(&manifest).unwrap();
        assert_eq!(manifest.metadata.description, "Invalid plugin ID");
        manifest.format_version = 9;
        let error = serde_json::to_value(validate_manifest(&manifest).unwrap_err()).unwrap();
        assert_eq!(
            error,
            json!({ "kind": "code", "code": "plugin.package.error.formatVersion", "params": { "actual": 9, "supported": 1 } })
        );
        manifest.format_version = 1;
        manifest.metadata.api_version = Some("1.0.0".into());
        let scratch = Scratch::new();
        let store = PackageStore::new(scratch.0.clone(), "1.0.0").unwrap();
        let errors = store.compatibility_errors(&manifest);
        assert_eq!(
            serde_json::to_value(&errors).unwrap()[0]["code"],
            "plugin.package.error.apiVersion"
        );
        let rejected = serde_json::to_value(failures(errors)).unwrap();
        assert_eq!(rejected["kind"], "diagnostics");
        assert_eq!(rejected["diagnostics"][0]["params"]["actual"], "1.0.0");
        manifest.metadata.api_version = None;
        assert_eq!(
            serde_json::to_value(store.compatibility_errors(&manifest)).unwrap()[0]["code"],
            "plugin.package.error.apiVersionMissing"
        );
    }

    #[test]
    fn filesystem_and_zip_diagnostics_keep_paths_and_native_causes() {
        let scratch = Scratch::new();
        let path = scratch.0.join("存在しない {not_a_key}.zip");
        let error = serde_json::to_value(read_bounded(&path, 100).unwrap_err()).unwrap();
        assert_eq!(error["code"], "plugin.package.error.pathCause");
        assert_eq!(error["params"]["path"], path.to_string_lossy().as_ref());
        assert_eq!(
            error["params"]["error"]["code"],
            "plugin.package.error.readFailed"
        );
        assert!(!error["params"]["error"]["params"]["details"]
            .as_str()
            .unwrap()
            .is_empty());
        assert!(!path.exists());
        let error = serde_json::to_value(check_path("../利用者の値", false).unwrap_err()).unwrap();
        assert_eq!(error["code"], "plugin.package.error.zipPath");
        assert_eq!(error["params"]["path"], "../利用者の値");
        assert_eq!(
            serde_json::to_value(preflight_zip(&[]).unwrap_err()).unwrap()["code"],
            "plugin.package.error.zipSize"
        );
    }

    #[test]
    fn dependency_arrays_retain_nested_diagnostics_and_install_state() {
        let scratch = Scratch::new();
        let store = versioned_store(&scratch.0, "1.0.0").unwrap();
        let digest = seed(&store, "example");
        let mut metadata = example_manifest().metadata;
        metadata.id = "consumer".into();
        metadata
            .dependencies
            .insert("example".into(), "^1.0.0".into());
        let mut index = store.read_index().unwrap();
        index.installed.get_mut("example").unwrap().enabled = false;
        let issues =
            serde_json::to_value(store.dependency_issues(&metadata, &index, true)).unwrap();
        assert_eq!(issues[0]["code"], "plugin.package.error.dependencyDisabled");
        let before = fs::read(store.root.join("index.json")).unwrap();
        fs::remove_file(store.blob_path(&digest)).unwrap();
        let issues = store.dependency_issues(&metadata, &index, true);
        let error = serde_json::to_value(failures(issues)).unwrap();
        assert_eq!(
            error["diagnostics"][0]["code"],
            "plugin.package.error.pathCause"
        );
        assert_eq!(
            error["diagnostics"][0]["params"]["error"]["code"],
            "plugin.package.error.readFailed"
        );
        assert_eq!(fs::read(store.root.join("index.json")).unwrap(), before);
    }
    fn resource_fixture_bytes(change: impl FnOnce(&mut serde_json::Value)) -> Vec<u8> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugin-owned-tables");
        let mut manifest: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("plugin.json")).unwrap()).unwrap();
        change(&mut manifest);
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
        zip.start_file("plugin.json", options).unwrap();
        zip.write_all(&serde_json::to_vec(&manifest).unwrap())
            .unwrap();
        for name in [
            "main.js",
            "preferences.table.toml",
            "translations.table.toml",
            "preferences.interface.toml",
            "translations.interface.toml",
        ] {
            zip.start_file(name, options).unwrap();
            zip.write_all(&fs::read(root.join(name)).unwrap()).unwrap();
        }
        zip.finish().unwrap().into_inner()
    }
    #[test]
    fn declared_resource_archive_is_validated_without_executing_code() {
        let bytes = resource_fixture_bytes(|_| {});
        let package = validate_package(bytes).unwrap();
        assert_eq!(package.resources.tables.len(), 2);
        let absent = resource_fixture_bytes(|manifest| manifest["capabilities"] = json!([]));
        assert!(
            matches!(validate_package(absent),Err(AppError::Code{code,..}) if code=="plugin.resources.error.capabilities")
        );
        for path in [
            "../preferences.table.toml",
            "/preferences.table.toml",
            "missing.table.toml",
        ] {
            assert!(
                validate_package(resource_fixture_bytes(|manifest| manifest["resources"]
                    ["settingsTables"][0]["path"] =
                    json!(path)))
                .is_err()
            );
        }
        for contract in [
            "../preferences.interface.toml",
            "missing.interface.toml",
            "translations.interface.toml",
        ] {
            assert!(
                validate_package(resource_fixture_bytes(|manifest| manifest["resources"]
                    ["settingsTables"][0]["contract"] =
                    json!(contract)))
                .is_err()
            );
        }
        assert!(validate_package(resource_fixture_bytes(|manifest| {
            manifest["resources"]["settingsTables"][0]
                .as_object_mut()
                .unwrap()
                .remove("contract");
        }))
        .is_err());
        assert!(
            validate_package(resource_fixture_bytes(|manifest| manifest["metadata"]
                ["id"] =
                json!("other-owner")))
            .is_err()
        );
    }
    #[test]
    fn package_resources_survive_permission_restart_removal_and_reinstall() {
        let scratch = Scratch::new();
        let config = scratch.0.join("profile");
        let baseline = crate::app_settings_store::load(&config);
        assert_eq!(baseline.source, "project");
        let root = scratch.0.join("packages");
        let store = PackageStore::new(root.clone(), "0.0.2")
            .unwrap()
            .with_settings_config(config.clone());
        let path = scratch.0.join("fixture.zip");
        fs::write(&path, resource_fixture_bytes(|_| {})).unwrap();
        let preview = store.preview_package(&path).unwrap();
        assert!(preview.compatible);
        let installed = store.install(&path, &preview.digest, "reject").unwrap();
        assert!(!installed.enabled);
        assert!(!installed.approved);
        let table = config.join("settings/Tables/Plugins/report-tools/preferences.table.toml");
        let mut document: devcel_core::TableData =
            toml::from_str(&fs::read_to_string(&table).unwrap()).unwrap();
        let column = document
            .schema
            .columns
            .iter()
            .find(|column| column.data_name == "prefix")
            .unwrap();
        assert_eq!(
            document.records[0].get_cell_value(column).unwrap(),
            "Report"
        );
        document.records[0].set_cell_value(column, "Authored".into());
        assert_eq!(
            document.records[0].get_cell_value(column).unwrap(),
            "Authored"
        );
        let authored = toml::to_string(&document).unwrap();
        fs::write(&table, &authored).unwrap();
        store
            .approve("report-tools", &installed.digest, true)
            .unwrap();
        store
            .set_enabled("report-tools", &installed.digest, true)
            .unwrap();
        // Reading source is not execution; all authored tables are revalidated first.
        store.source("report-tools", &installed.digest).unwrap();
        store
            .set_enabled("report-tools", &installed.digest, false)
            .unwrap();
        drop(store);
        let store = PackageStore::new(root, "0.0.2")
            .unwrap()
            .with_settings_config(config);
        assert_eq!(fs::read_to_string(&table).unwrap(), authored);
        store.remove("report-tools", &installed.digest).unwrap();
        assert_eq!(fs::read_to_string(&table).unwrap(), authored);
        store.install(&path, &installed.digest, "reject").unwrap();
        assert_eq!(fs::read_to_string(&table).unwrap(), authored);
    }
}
