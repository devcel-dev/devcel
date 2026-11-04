//! Crash recovery for the bounded project-tag transaction only.
//! Mutation callers hold the stable project lock; recovery acquires it itself.
use crate::{DevcelError, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};

const JOURNAL: &str = ".devcel-tag-transaction";
const MANIFEST: &str = "manifest.json";
const COMMITTED: &str = "committed";
fn invalid(message: impl Into<String>) -> DevcelError {
    DevcelError::Validation(message.into())
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    path: String,
    before: Option<String>,
    after: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u32,
    entries: Vec<Entry>,
}
pub type FileChange = (PathBuf, Vec<u8>, Option<Vec<u8>>);

pub struct Journal {
    root: PathBuf,
    directory: PathBuf,
}
pub fn pending(root: &Path) -> bool {
    !matches!(fs::symlink_metadata(root.join(JOURNAL)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
}
pub fn acquire_lock(root: &Path) -> Result<crate::write_locks::LockGuard> {
    regular(root, true)?;
    Ok(crate::write_locks::lock_file(
        &root.join(".devcel-tag-transaction.lock"),
        false,
    )?)
}
fn regular(path: &Path, directory: bool) -> Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || if directory {
            !metadata.is_dir()
        } else {
            !metadata.is_file()
        }
    {
        return Err(invalid(format!(
            "Unsafe tag transaction path: {}",
            path.display()
        )));
    }
    Ok(())
}
fn sync_dir(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        fs::File::open(path)?.sync_all()?;
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
    Ok(())
}
fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}
fn project_filename(root: &Path, project: &Path) -> Result<String> {
    let absolute = if project.is_absolute() {
        project.to_path_buf()
    } else {
        std::env::current_dir()?.join(project)
    };
    let parent = absolute
        .parent()
        .ok_or_else(|| invalid("Missing project parent"))?;
    if fs::canonicalize(parent)? != root {
        return Err(invalid("Project file is outside journal root"));
    }
    absolute
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_owned)
        .ok_or_else(|| invalid("Invalid project filename"))
}
fn safe_target(root: &Path, relative: &str, project_file: &str) -> Result<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || relative.contains('\\')
        || path
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(invalid("Invalid relative tag transaction path"));
    }
    if path.components().next().is_some_and(|c| {
        c.as_os_str()
            .to_string_lossy()
            .starts_with(".devcel-tag-transaction")
    }) {
        return Err(invalid("Tag transaction cannot target its journal"));
    }
    let parts: Vec<_> = path.components().collect();
    let normalized = parts
        .iter()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if normalized != relative {
        return Err(invalid("Noncanonical tag transaction path"));
    }
    let table_target =
        parts.len() >= 2 && parts[0].as_os_str() == "Tables" && relative.ends_with(".table.toml");
    if relative != project_file && !table_target {
        return Err(invalid(
            "Tag journal target is not this project file or a table",
        ));
    }
    let mut current = root.to_path_buf();
    for (i, part) in parts.iter().enumerate() {
        current.push(part.as_os_str());
        match fs::symlink_metadata(&current) {
            Ok(_) => regular(&current, i + 1 < parts.len())?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && i + 1 == parts.len() => {}
            Err(e) => return Err(e.into()),
        }
    }
    Ok(current)
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn hash_matches(bytes: Option<&[u8]>, expected: Option<&str>) -> bool {
    match (bytes, expected) {
        (None, None) => true,
        (Some(bytes), Some(hash)) => digest(bytes) == hash,
        _ => false,
    }
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_hexdigit())
}
impl Journal {
    /// Per-file backups, rather than embedding table bytes in one manifest.
    /// Caller has already locked the complete write/read set and checked CAS.
    pub fn prepare(root: &Path, project_path: &Path, changes: &[FileChange]) -> Result<Self> {
        regular(root, true)?;
        let root = fs::canonicalize(root)?;
        let project_file = project_filename(&root, project_path)?;
        let directory = root.join(JOURNAL);
        if pending(&root) {
            return Err(invalid("Pending tag transaction requires recovery"));
        }
        let staging = root.join(format!("{JOURNAL}.preparing-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&staging)?;
        let mut entries = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for (index, (path, after, before)) in changes.iter().enumerate() {
            let absolute = if path.is_absolute() {
                path.clone()
            } else {
                std::env::current_dir()?.join(path)
            };
            let parent = absolute
                .parent()
                .ok_or_else(|| invalid("Missing target parent"))?;
            let canonical_parent = fs::canonicalize(parent)?;
            if !canonical_parent.starts_with(&root) {
                return Err(invalid("Tag transaction target is outside project"));
            }
            // Validate every supplied parent below the project before using its
            // canonical spelling (including Windows verbatim-prefix normalization).
            let mut ancestor = parent;
            loop {
                regular(ancestor, true)?;
                if fs::canonicalize(ancestor)? == root {
                    break;
                }
                ancestor = ancestor
                    .parent()
                    .ok_or_else(|| invalid("Target parent escapes project"))?;
            }
            let filename = absolute
                .file_name()
                .ok_or_else(|| invalid("Missing target filename"))?;
            let absolute = canonical_parent.join(filename);
            let relative = absolute
                .strip_prefix(&root)
                .map_err(|_| invalid("Tag transaction target is outside project"))?
                .to_str()
                .ok_or_else(|| invalid("Tag transaction path is not UTF-8"))?
                .replace(std::path::MAIN_SEPARATOR, "/");
            if !seen.insert(relative.clone()) {
                return Err(invalid("Duplicate tag transaction target"));
            }
            let target = safe_target(&root, &relative, &project_file)?;
            let before_hash = before.as_deref().map(digest);
            if !hash_matches(read_optional(&target)?.as_deref(), before_hash.as_deref()) {
                return Err(invalid("Tag transaction target changed before journaling"));
            }
            if let Some(bytes) = before {
                write_new(&staging.join(format!("{index}.before")), bytes)?;
            }
            entries.push(Entry {
                path: relative,
                before: before_hash,
                after: digest(after),
            });
        }
        let manifest = serde_json::to_vec(&Manifest {
            version: 1,
            entries,
        })
        .map_err(|e| invalid(e.to_string()))?;
        if manifest.len() > 16 * 1024 * 1024 {
            return Err(invalid("Tag transaction manifest is too large"));
        }
        write_new(&staging.join(MANIFEST), &manifest)?;
        sync_dir(&staging)?;
        fs::rename(&staging, &directory)?;
        sync_dir(&root)?;
        Ok(Self { root, directory })
    }
    /// Publication must have synced all destination files/directories first.
    pub fn commit(&self) -> Result<()> {
        let marker = self.directory.join(COMMITTED);
        let result = write_new(&marker, b"committed\n").and_then(|()| sync_dir(&self.directory));
        if let Err(error) = result {
            if marker.try_exists()? {
                fs::remove_file(&marker)?;
                sync_dir(&self.directory)?;
            }
            return Err(error);
        }
        self.cleanup();
        Ok(())
    }
    /// A failed commit may have an uncertain marker outcome. Never start rollback
    /// unless its absence is itself durable; leave the journal pending otherwise.
    pub fn rollback_is_safe(&self) -> Result<bool> {
        match fs::symlink_metadata(self.directory.join(COMMITTED)) {
            Ok(_) => Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                sync_dir(&self.directory)?;
                Ok(true)
            }
            Err(error) => Err(error.into()),
        }
    }
    /// Caller restored all originals durably. Keep recovery idempotent if cleanup fails.
    pub fn rollback_completed(self) -> Result<()> {
        self.cleanup();
        Ok(())
    }
    fn cleanup(&self) {
        // Rename the entire journal before deleting anything: interrupted cleanup
        // must never leave a partially missing backup set at the recovery name.
        let retired = self
            .root
            .join(format!("{JOURNAL}.finished-{}", uuid::Uuid::new_v4()));
        if fs::rename(&self.directory, &retired).is_ok() {
            let _ = sync_dir(&self.root);
            let _ = fs::remove_dir_all(retired);
        }
    }
}

/// Run before loading/exposing a project. Divergence leaves all files and journal
/// intact; no original is restored until the entire recovery read set is valid.
pub fn recover(root: &Path, project_path: &Path) -> Result<()> {
    // Ordinary read-only project loading must not create a write lock. Mutation
    // paths acquire the project lock separately and check pending before writes.
    if !pending(root) {
        return Ok(());
    }
    let _project_lock = acquire_lock(root)?;
    regular(root, true)?;
    let root = fs::canonicalize(root)?;
    let project_file = project_filename(&root, project_path)?;
    let directory = root.join(JOURNAL);
    if !pending(&root) {
        return Ok(());
    }
    regular(&directory, true)?;
    let journal = Journal {
        root: root.clone(),
        directory: directory.clone(),
    };
    let committed = directory.join(COMMITTED);
    if committed.try_exists()? {
        regular(&committed, false)?;
        if fs::read(&committed)? != b"committed\n" {
            return Err(invalid("Malformed tag transaction commit marker"));
        }
        journal.cleanup();
        return Ok(());
    }
    let manifest_path = directory.join(MANIFEST);
    regular(&manifest_path, false)?;
    if fs::metadata(&manifest_path)?.len() > 16 * 1024 * 1024 {
        return Err(invalid("Tag transaction manifest is too large"));
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(manifest_path)?)
        .map_err(|e| invalid(format!("Invalid tag transaction journal: {e}")))?;
    if manifest.version != 1 {
        return Err(invalid("Unknown tag transaction journal version"));
    }
    let mut targets = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (index, entry) in manifest.entries.iter().enumerate() {
        if !valid_hash(&entry.after)
            || entry
                .before
                .as_deref()
                .is_some_and(|hash| !valid_hash(hash))
            || !seen.insert(&entry.path)
        {
            return Err(invalid("Invalid tag transaction entry"));
        }
        let target = safe_target(&root, &entry.path, &project_file)?;
        if let Some(hash) = &entry.before {
            let backup = directory.join(format!("{index}.before"));
            regular(&backup, false)?;
            if digest(&fs::read(backup)?) != *hash {
                return Err(invalid("Damaged tag transaction backup"));
            }
        }
        targets.push((target, index));
    }
    targets.sort_by(|a, b| a.0.cmp(&b.0));
    let _locks =
        crate::write_locks::lock_files(targets.iter().map(|(path, _)| path.as_path()), false)?;
    for (path, index) in &targets {
        safe_target(&root, &manifest.entries[*index].path, &project_file)?;
        let bytes = read_optional(path)?;
        let entry = &manifest.entries[*index];
        if !hash_matches(bytes.as_deref(), entry.before.as_deref())
            && !hash_matches(bytes.as_deref(), Some(&entry.after))
        {
            return Err(invalid(format!(
                "Tag recovery found an external edit: {}",
                path.display()
            )));
        }
    }
    for (path, index) in &targets {
        let entry = &manifest.entries[*index];
        if let Some(hash) = &entry.before {
            let bytes = fs::read(directory.join(format!("{index}.before")))?;
            if digest(&bytes) != *hash {
                return Err(invalid("Tag transaction backup changed during recovery"));
            }
            let parent = path
                .parent()
                .ok_or_else(|| invalid("Missing target parent"))?;
            let mut temp = crate::utils::new_atomic_save_temp(parent)?;
            if let Ok(metadata) = fs::metadata(path) {
                temp.as_file().set_permissions(metadata.permissions())?;
            }
            temp.write_all(&bytes)?;
            temp.as_file().sync_all()?;
            temp.persist(path).map_err(|e| DevcelError::Io(e.error))?;
            sync_dir(parent)?;
        } else if path.try_exists()? {
            fs::remove_file(path)?;
            sync_dir(path.parent().unwrap())?;
        }
    }
    journal.rollback_completed()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn recover(root: &Path) -> Result<()> {
        super::recover(root, &root.join("project.devcelproj.toml"))
    }
    type Changes = Vec<(PathBuf, Vec<u8>, Option<Vec<u8>>)>;
    fn fixture() -> (tempfile::TempDir, Changes) {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("Tables")).unwrap();
        let changes = vec![
            (
                dir.path().join("project.devcelproj.toml"),
                b"new registry".to_vec(),
                Some(b"old registry".to_vec()),
            ),
            (
                dir.path().join("Tables/a.table.toml"),
                b"new tags".to_vec(),
                Some(b"old tags".to_vec()),
            ),
        ];
        for (path, _, old) in &changes {
            fs::write(path, old.as_ref().unwrap()).unwrap();
        }
        (dir, changes)
    }
    #[test]
    fn crafted_journal_cannot_restore_unrelated_root_file() {
        let (dir, changes) = fixture();
        let journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        let readme = dir.path().join("README.md");
        fs::write(&readme, b"current").unwrap();
        let entry = Entry {
            path: "README.md".into(),
            before: Some(digest(b"old registry")),
            after: digest(b"current"),
        };
        fs::write(
            journal.directory.join(MANIFEST),
            serde_json::to_vec(&Manifest {
                version: 1,
                entries: vec![entry],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(recover(dir.path()).is_err());
        assert_eq!(fs::read(readme).unwrap(), b"current");
        assert!(pending(dir.path()));
        assert!(safe_target(
            dir.path(),
            "other.devcelproj.toml",
            "project.devcelproj.toml"
        )
        .is_err());
        assert!(safe_target(dir.path(), "Tables/script.js", "project.devcelproj.toml").is_err());
    }
    #[test]
    fn actual_project_filename_does_not_require_standard_extension() {
        let (dir, mut changes) = fixture();
        let actual = dir.path().join("custom.project");
        fs::rename(&changes[0].0, &actual).unwrap();
        changes[0].0 = actual.clone();
        let _journal = Journal::prepare(dir.path(), &actual, &changes).unwrap();
        super::recover(dir.path(), &actual).unwrap();
        assert_eq!(fs::read(actual).unwrap(), b"old registry");
    }
    #[test]
    fn ordinary_load_without_journal_creates_no_lock() {
        let (dir, _) = fixture();
        recover(dir.path()).unwrap();
        assert!(!dir.path().join(".devcel-tag-transaction.lock").exists());
    }
    #[test]
    fn before_publication_recovers_without_changing_originals() {
        let (dir, changes) = fixture();
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        recover(dir.path()).unwrap();
        for (path, _, old) in changes {
            assert_eq!(fs::read(path).unwrap(), old.unwrap());
        }
        assert!(!pending(dir.path()));
    }
    #[test]
    fn partial_publication_and_interrupted_rollback_are_idempotent() {
        let (dir, changes) = fixture();
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        for (path, new, _) in &changes {
            fs::write(path, new).unwrap();
        }
        // First target has already been restored by an interrupted recovery.
        fs::write(&changes[0].0, changes[0].2.as_ref().unwrap()).unwrap();
        recover(dir.path()).unwrap();
        recover(dir.path()).unwrap();
        for (path, _, old) in changes {
            assert_eq!(fs::read(path).unwrap(), old.unwrap());
        }
    }
    #[test]
    fn committed_before_cleanup_preserves_new_files() {
        let (dir, changes) = fixture();
        let journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        for (path, new, _) in &changes {
            fs::write(path, new).unwrap();
        }
        write_new(&journal.directory.join(COMMITTED), b"committed\n").unwrap();
        recover(dir.path()).unwrap();
        for (path, new, _) in changes {
            assert_eq!(fs::read(path).unwrap(), new);
        }
        assert!(!pending(dir.path()));
    }
    #[test]
    fn divergent_external_edit_blocks_all_restoration() {
        let (dir, changes) = fixture();
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        fs::write(&changes[0].0, &changes[0].1).unwrap();
        fs::write(&changes[1].0, b"external edit").unwrap();
        assert!(recover(dir.path()).is_err());
        assert_eq!(fs::read(&changes[0].0).unwrap(), changes[0].1);
        assert_eq!(fs::read(&changes[1].0).unwrap(), b"external edit");
        assert!(pending(dir.path()));
    }
    #[test]
    fn malformed_manifest_and_escape_preserve_targets() {
        let (dir, changes) = fixture();
        let journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        fs::write(journal.directory.join(MANIFEST), b"malformed").unwrap();
        assert!(recover(dir.path()).is_err());
        let entry = Entry {
            path: "../outside".into(),
            before: None,
            after: digest(b"new"),
        };
        fs::write(
            journal.directory.join(MANIFEST),
            serde_json::to_vec(&Manifest {
                version: 1,
                entries: vec![entry],
            })
            .unwrap(),
        )
        .unwrap();
        assert!(recover(dir.path()).is_err());
        for (path, _, old) in changes {
            assert_eq!(fs::read(path).unwrap(), old.unwrap());
        }
        assert!(pending(dir.path()));
    }
    #[test]
    fn damaged_backup_blocks_before_any_restore() {
        let (dir, changes) = fixture();
        let journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        for (path, new, _) in &changes {
            fs::write(path, new).unwrap();
        }
        fs::write(journal.directory.join("1.before"), b"broken").unwrap();
        assert!(recover(dir.path()).is_err());
        for (path, new, _) in changes {
            assert_eq!(fs::read(path).unwrap(), new);
        }
    }
    #[test]
    fn newly_created_target_is_removed_on_rollback() {
        let (dir, mut changes) = fixture();
        let path = dir.path().join("Tables/new.table.toml");
        changes.push((path.clone(), b"new".to_vec(), None));
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        fs::write(&path, b"new").unwrap();
        recover(dir.path()).unwrap();
        assert!(!path.exists());
    }
    #[test]
    fn noncanonical_parent_and_normal_windows_paths_are_normalized() {
        let (dir, mut changes) = fixture();
        changes[1].0 = dir.path().join("Tables/../Tables/a.table.toml");
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        recover(dir.path()).unwrap();
        assert_eq!(fs::read(&changes[1].0).unwrap(), b"old tags");
    }
    #[test]
    fn normalized_duplicate_targets_are_rejected_before_locking() {
        let (dir, mut changes) = fixture();
        let mut alias = changes[1].clone();
        alias.0 = dir.path().join("Tables/../Tables/a.table.toml");
        changes.push(alias);
        assert!(Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes
        )
        .is_err());
        assert!(!pending(dir.path()));
    }
    #[test]
    fn duplicate_separator_path_is_rejected() {
        let (dir, _) = fixture();
        assert!(safe_target(
            dir.path(),
            "Tables//a.table.toml",
            "project.devcelproj.toml"
        )
        .is_err());
        assert!(safe_target(
            dir.path(),
            "Tables/./a.table.toml",
            "project.devcelproj.toml"
        )
        .is_err());
    }
    #[cfg(unix)]
    #[test]
    fn dangling_temp_lock_symlink_blocks_recovery() {
        use std::os::unix::fs::symlink;
        let (dir, changes) = fixture();
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        let outside = dir.path().join("must-not-create");
        let lock =
            crate::write_locks::path_for_target(&dir.path().join("Tables/a.table.toml")).unwrap();
        symlink(&outside, &lock).unwrap();
        assert!(recover(dir.path()).is_err());
        assert!(!outside.exists());
        assert!(pending(dir.path()));
        fs::remove_file(lock).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_target_or_journal_is_rejected() {
        use std::os::unix::fs::symlink;
        let (dir, changes) = fixture();
        let _journal = Journal::prepare(
            dir.path(),
            &dir.path().join("project.devcelproj.toml"),
            &changes,
        )
        .unwrap();
        let external = tempfile::NamedTempFile::new().unwrap();
        fs::write(external.path(), b"external").unwrap();
        fs::remove_file(&changes[1].0).unwrap();
        symlink(external.path(), &changes[1].0).unwrap();
        assert!(recover(dir.path()).is_err());
        assert_eq!(fs::read(external.path()).unwrap(), b"external");
    }
}
