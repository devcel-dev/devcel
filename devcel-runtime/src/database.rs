//! Database handle with hot-reload support.
//!
//! Holds the current snapshot in [`ArcSwap`], giving readers lock-free, consistent
//! immutable views. `reload_if_changed` compares the file's `content_hash` and
//! reparses and atomically replaces the snapshot only on change. In-flight queries
//! remain consistent while holding an Arc to their acquired snapshot.

use crate::snapshot::Snapshot;
use arc_swap::ArcSwap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Devcel runtime database.
pub struct Database {
    /// Reload source file (None when constructed with `from_json`).
    path: Option<PathBuf>,
    /// Current snapshot, replaceable atomically.
    snapshot: ArcSwap<Snapshot>,
}

impl Database {
    /// Construct a database from a JSON string without associating it with a file.
    pub fn from_json(json: &str) -> Result<Database, String> {
        let snap = Snapshot::from_json(json)?;
        Ok(Database {
            path: None,
            snapshot: ArcSwap::from_pointee(snap),
        })
    }

    /// Open a bundle JSON file and construct a database.
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Database, String> {
        let path = path.as_ref().to_path_buf();
        let json = std::fs::read_to_string(&path)
            .map_err(|e| format!("Could not read the file ({}): {e}", path.display()))?;
        let snap = Snapshot::from_json(&json)?;
        Ok(Database {
            path: Some(path),
            snapshot: ArcSwap::from_pointee(snap),
        })
    }

    /// Get a consistent immutable view of the current snapshot (lock-free Arc clone).
    /// The snapshot remains alive while the returned value exists.
    #[inline]
    pub fn load(&self) -> Arc<Snapshot> {
        self.snapshot.load_full()
    }

    /// Content hash of the current snapshot.
    pub fn content_hash(&self) -> String {
        self.snapshot.load().content_hash().to_string()
    }

    /// Reload and replace the snapshot if the file contents changed.
    ///
    /// Returns `Ok(true)` when replaced after detecting a change, or `Ok(false)` when unchanged.
    /// Skip reparsing when `content_hash` matches the current snapshot (cache).
    pub fn reload_if_changed(&self) -> Result<bool, String> {
        let path = self
            .path
            .as_ref()
            .ok_or("Cannot reload this database because it is not associated with a file")?;

        let json = std::fs::read_to_string(path)
            .map_err(|e| format!("Could not read the file ({}): {e}", path.display()))?;

        // JSON parsing itself is unavoidable. Most cost lies in building the Snapshot
        // (string pool, typed arrays, and indices), so parse once and compare content_hash,
        // skipping Snapshot construction if it is unchanged.
        let bundle: crate::bundle::Bundle =
            serde_json::from_str(&json).map_err(|e| format!("Failed to parse bundle JSON: {e}"))?;

        let current = self.snapshot.load();
        if bundle.manifest.content_hash == current.content_hash()
            && bundle.manifest.content_version == current.manifest.content_version
            && bundle.manifest.mode == current.manifest.mode
            && bundle.project_name == current.project_name
        {
            bundle.validate()?;
            return Ok(false);
        }
        drop(current);

        let snap = Snapshot::from_bundle(bundle)?;
        self.snapshot.store(Arc::new(snap));
        Ok(true)
    }
}
