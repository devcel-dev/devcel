use crate::discovery::{normalize_project_path, ServiceInfo, ServiceStatus};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, TryLockError};
use std::io::Write;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

/// Shared discovery is read from disk on every lookup. A process-local cache can
/// hide another editor's registration, promotion, or shutdown indefinitely.
pub struct FileBasedRegistry {
    registry_dir: PathBuf,
    legacy_dir: Option<PathBuf>,
}

#[cfg(test)]
mod private_discovery_tests {
    use super::*;
    #[test]
    fn running_legacy_server_blocks_new_host_without_changing_legacy_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("private");
        drop(crate::p2p_auth::SessionCapability::create_at(&root, 12345).unwrap());
        let legacy = temp.path().join("legacy");
        fs::create_dir(&legacy).unwrap();
        let project = normalize_project_path(
            &temp
                .path()
                .join("Project.devcelproj.toml")
                .to_string_lossy(),
        );
        let lock_path = legacy.join(format!(
            "{}.server.lock",
            FileBasedRegistry::hash_path(&project)
        ));
        fs::write(&lock_path, b"unchanged legacy coordination").unwrap();
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&lock_path)
            .unwrap();
        file.try_lock().unwrap();
        let registry = FileBasedRegistry {
            registry_dir: root,
            legacy_dir: Some(legacy),
        };
        assert!(registry.try_project_lock(&project, "server").is_err());
        drop(file);
        assert_eq!(
            fs::read(&lock_path).unwrap(),
            b"unchanged legacy coordination"
        );
        assert!(registry
            .try_project_lock(&project, "server")
            .unwrap()
            .is_some());
    }
    #[test]
    fn discovery_updates_and_coordination_files_remain_owner_only() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("private-discovery");
        drop(crate::p2p_auth::SessionCapability::create_at(&root, 12345).unwrap());
        let registry = FileBasedRegistry {
            registry_dir: root.clone(),
            legacy_dir: None,
        };
        let path = temp
            .path()
            .join("Project.devcelproj.toml")
            .to_string_lossy()
            .into_owned();
        let service = ServiceInfo {
            app_type: "test".into(),
            project_path: path.clone(),
            project_uuid: "fixture".into(),
            address: "127.0.0.1:12345".parse().unwrap(),
            last_seen: SystemTime::now(),
            status: ServiceStatus::Active,
            connection_order: 0,
        };
        registry.register_service(service.clone()).unwrap();
        registry.register_service(service).unwrap();
        assert_eq!(registry.get_all_services(&path).len(), 1);
        for entry in fs::read_dir(&root).unwrap() {
            crate::p2p_auth::verify_private_file(&entry.unwrap().path()).unwrap();
        }
        let lock = registry.try_project_lock(&path, "server").unwrap().unwrap();
        assert!(registry
            .try_project_lock(&path, "server")
            .unwrap()
            .is_none());
        drop(lock);
        assert!(registry
            .try_project_lock(&path, "server")
            .unwrap()
            .is_some());
        assert!(registry.try_project_lock(&path, "../invalid").is_err());
        assert_eq!(
            fs::read_dir(&root)
                .unwrap()
                .filter(|entry| entry
                    .as_ref()
                    .unwrap()
                    .path()
                    .extension()
                    .is_some_and(|e| e == "tmp"))
                .count(),
            0
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryData {
    project_uuid: String,
    project_path: String,
    services: Vec<ServiceInfo>,
    last_updated: SystemTime,
    next_connection_order: u32,
}

impl FileBasedRegistry {
    pub fn new() -> Result<Self, String> {
        let registry_dir = crate::p2p_auth::discovery_directory()
            .map_err(|_| "Private local discovery unavailable".to_string())?;
        // A separately configured session namespace is used by isolated app/test
        // launchers. The default namespace detects a still-running older server
        // without importing or changing its less-private discovery files.
        let legacy_dir = if std::env::var_os("DEVCEL_P2P_SESSION_DIR").is_some() {
            None
        } else {
            #[cfg(windows)]
            let base = std::env::var_os("APPDATA").map(PathBuf::from);
            #[cfg(not(windows))]
            let base =
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"));
            base.map(|base| base.join("devcel/registries"))
        };
        Ok(Self {
            registry_dir,
            legacy_dir,
        })
    }

    fn hash_path(path: &str) -> String {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        path.hash(&mut hasher);
        format!("{:x}", hasher.finish())
    }

    fn get_registry_file_path(&self, project_path: &str) -> PathBuf {
        self.registry_dir
            .join(format!("{}.json", Self::hash_path(project_path)))
    }

    /// OS-held lock, automatically released on process death. Never delete lock
    /// files: unlinking a locked inode permits two simultaneous owners on Unix.
    pub fn try_project_lock(
        &self,
        project_path: &str,
        scope: &str,
    ) -> Result<Option<File>, String> {
        let path = normalize_project_path(project_path);
        if scope == "server" {
            if let Some(legacy) = self.legacy_dir.as_ref() {
                if Self::legacy_server_active(legacy, &path)? {
                    return Err(
                        "Close earlier Devcel sessions for this project before upgrading".into(),
                    );
                }
            }
        }
        if !scope.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') || scope.is_empty() {
            return Err("Invalid project lock scope".into());
        }
        let file = crate::p2p_auth::open_private_lock(
            &self
                .registry_dir
                .join(format!("{}.{scope}.lock", Self::hash_path(&path))),
        )
        .map_err(|_| "Private project lock unavailable".to_string())?;
        match file.try_lock() {
            Ok(()) => Ok(Some(file)),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(e)) => Err(format!("Failed to lock project {scope}: {e}")),
        }
    }

    fn legacy_server_active(directory: &std::path::Path, project: &str) -> Result<bool, String> {
        let lock = directory.join(format!("{}.server.lock", Self::hash_path(project)));
        match fs::symlink_metadata(&lock) {
            Ok(meta) => {
                if !meta.file_type().is_file() {
                    return Err("Unexpected legacy coordination file".into());
                }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if meta.file_attributes() & 0x400 != 0 {
                        return Err("Linked legacy coordination file".into());
                    }
                }
                let file = fs::OpenOptions::new()
                    .read(true)
                    .write(true)
                    .open(&lock)
                    .map_err(|_| "Cannot inspect earlier Devcel session".to_string())?;
                match file.try_lock() {
                    Ok(()) => {}
                    Err(TryLockError::WouldBlock) => return Ok(true),
                    Err(_) => return Err("Cannot inspect earlier Devcel session".into()),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Cannot inspect earlier Devcel session".into()),
        }
        let record = directory.join(format!("{}.json", Self::hash_path(project)));
        let metadata = match fs::symlink_metadata(&record) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err("Cannot inspect earlier Devcel discovery".into()),
        };
        if !metadata.file_type().is_file() || metadata.len() > 1024 * 1024 {
            return Err("Unexpected legacy discovery record".into());
        }
        let data: RegistryData = serde_json::from_slice(
            &fs::read(record).map_err(|_| "Cannot inspect earlier Devcel discovery")?,
        )
        .map_err(|_| "Invalid earlier Devcel discovery")?;
        if data.project_path != project || data.services.len() > 32 {
            return Err("Unexpected earlier Devcel discovery identity".into());
        }
        Ok(data
            .services
            .iter()
            .filter(|service| {
                service.status == ServiceStatus::Active && service.address.ip().is_loopback()
            })
            .any(|service| {
                std::net::TcpStream::connect_timeout(&service.address, Duration::from_millis(100))
                    .is_ok()
            }))
    }

    /// Bounded asynchronous acquisition for server election/startup. The returned
    /// file must remain open until the protected operation has finished.
    pub async fn project_lock(&self, project_path: &str, scope: &str) -> Result<File, String> {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(file) = self.try_project_lock(project_path, scope)? {
                return Ok(file);
            }
            if Instant::now() >= deadline {
                return Err(format!("Timed out acquiring project {scope} lock"));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    fn registry_lock(&self, project_path: &str) -> Result<File, String> {
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(file) = self.try_project_lock(project_path, "registry")? {
                return Ok(file);
            }
            if Instant::now() >= deadline {
                return Err("Timed out locking service registry".to_string());
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    pub fn register_service(&self, mut service: ServiceInfo) -> Result<(), String> {
        let path = normalize_project_path(&service.project_path);
        service.project_path = path.clone();
        let _guard = self.registry_lock(&path)?;
        let mut data = match self.load_registry_data(&path) {
            Ok(data) => data,
            Err(_) if !self.get_registry_file_path(&path).exists() => RegistryData {
                project_uuid: service.project_uuid.clone(),
                project_path: path.clone(),
                services: Vec::new(),
                last_updated: SystemTime::now(),
                next_connection_order: 1,
            },
            Err(e) => return Err(e),
        };
        if let Some(existing) = data
            .services
            .iter_mut()
            .find(|s| s.address == service.address)
        {
            service.connection_order = existing.connection_order;
            *existing = service;
        } else {
            service.connection_order = data.next_connection_order;
            data.next_connection_order = data.next_connection_order.saturating_add(1);
            data.services.push(service);
        }
        data.last_updated = SystemTime::now();
        self.save_registry_data(&path, &data)
    }

    pub fn find_active_server(&self, project_path: &str) -> Option<ServiceInfo> {
        self.get_all_services(project_path)
            .into_iter()
            .filter(|s| s.status == ServiceStatus::Active && s.address.ip().is_loopback())
            // Reachability is authoritative. A live but busy server must not be
            // duplicated just because its registry heartbeat was delayed.
            .filter(|s| {
                std::net::TcpStream::connect_timeout(&s.address, Duration::from_millis(200)).is_ok()
            })
            .min_by_key(|s| s.connection_order)
    }

    fn load_registry_data(&self, project_path: &str) -> Result<RegistryData, String> {
        let path = self.get_registry_file_path(project_path);
        crate::p2p_auth::verify_private_file(&path)
            .map_err(|_| "Private registry unavailable".to_string())?;
        if fs::metadata(&path)
            .map_err(|_| "Private registry unavailable")?
            .len()
            > 1024 * 1024
        {
            return Err("Local registry exceeds limit".into());
        }
        let bytes = fs::read(path).map_err(|e| format!("Failed to read registry: {e}"))?;
        serde_json::from_slice(&bytes).map_err(|e| format!("Failed to parse registry: {e}"))
    }

    fn save_registry_data(&self, project_path: &str, data: &RegistryData) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
        let temporary = self
            .registry_dir
            .join(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut file =
                crate::p2p_auth::create_private_file(&temporary).map_err(|e| e.to_string())?;
            file.write_all(&bytes).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?;
            drop(file);
            fs::rename(&temporary, self.get_registry_file_path(project_path))
                .map_err(|e| e.to_string())
        })();
        let _ = fs::remove_file(&temporary);
        result?;
        Ok(())
    }

    pub fn unregister_service(
        &self,
        project_path: &str,
        address: std::net::SocketAddr,
    ) -> Result<(), String> {
        let path = normalize_project_path(project_path);
        let _guard = self.registry_lock(&path)?;
        if let Ok(mut data) = self.load_registry_data(&path) {
            data.services.retain(|s| s.address != address);
            data.last_updated = SystemTime::now();
            self.save_registry_data(&path, &data)?;
        }
        Ok(())
    }

    /// Remove only the discovery record that was positively identified as a
    /// different project after a protocol handshake. Never evict on timeout.
    pub fn remove_misdirected_server(&self, expected: &ServiceInfo) -> Result<(), String> {
        let path = normalize_project_path(&expected.project_path);
        let _guard = self.registry_lock(&path)?;
        let mut data = self.load_registry_data(&path)?;
        data.services.retain(|service| {
            !(service.address == expected.address
                && service.last_seen == expected.last_seen
                && service.project_uuid == expected.project_uuid
                && service.status == ServiceStatus::Active)
        });
        data.last_updated = SystemTime::now();
        self.save_registry_data(&path, &data)
    }

    pub fn cleanup_stale_services(&self) {
        let Ok(entries) = fs::read_dir(&self.registry_dir) else {
            return;
        };
        for entry in entries.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if crate::p2p_auth::verify_private_file(&entry.path()).is_err()
                || entry
                    .metadata()
                    .map_or(true, |meta| meta.len() > 1024 * 1024)
            {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(data) = serde_json::from_slice::<RegistryData>(&bytes) else {
                continue;
            };
            let Ok(_guard) = self.registry_lock(&data.project_path) else {
                continue;
            };
            // Reload AFTER locking, otherwise cleanup can overwrite a concurrent registration.
            let Ok(mut data) = self.load_registry_data(&data.project_path) else {
                continue;
            };
            let count = data.services.len();
            data.services.retain(|s| {
                if s.status == ServiceStatus::Active {
                    // Never remove a live server merely for an old heartbeat.
                    s.address.ip().is_loopback()
                        && std::net::TcpStream::connect_timeout(
                            &s.address,
                            Duration::from_millis(200),
                        )
                        .is_ok()
                } else {
                    s.last_seen
                        .elapsed()
                        .is_ok_and(|age| age < crate::discovery::SERVICE_CLEANUP_TIMEOUT)
                }
            });
            if data.services.len() != count {
                data.last_updated = SystemTime::now();
                let _ = self.save_registry_data(&data.project_path, &data);
            }
        }
    }

    pub fn get_all_services(&self, project_path: &str) -> Vec<ServiceInfo> {
        self.load_registry_data(&normalize_project_path(project_path))
            .map(|data| data.services)
            .unwrap_or_default()
    }

    pub fn get_next_promotion_candidate(&self, project_path: &str) -> Option<ServiceInfo> {
        self.get_all_services(project_path)
            .into_iter()
            .filter(|s| matches!(s.status, ServiceStatus::Client(_)) && s.is_alive())
            .min_by_key(|s| s.connection_order)
    }
}
