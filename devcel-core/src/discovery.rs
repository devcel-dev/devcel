use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::time::{Duration, SystemTime};

// Service discovery and P2P connection management
// Service discovery and P2P connection management
//
// Relationship between timing constants:
// HEARTBEAT_INTERVAL < SERVICE_STALE_TIMEOUT < SERVICE_CLEANUP_TIMEOUT
// Allow at least three heartbeat intervals before the stale timeout
// (to preserve discoverability if file-registry write contention loses one update)

/// Registry heartbeat interval (last_seen update interval)
pub const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(3);

/// Services not updated within this duration are stale and excluded from discovery
pub const SERVICE_STALE_TIMEOUT: Duration = Duration::from_secs(10);

/// Services not updated within this duration are removed from the registry file
pub const SERVICE_CLEANUP_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceInfo {
    /// Application type (devcel-studio, unity-editor, etc.)
    pub app_type: String,
    /// Normalized project file path
    pub project_path: String,
    /// Project UUID
    pub project_uuid: String,
    /// Service address
    pub address: SocketAddr,
    /// Last update time
    pub last_seen: SystemTime,
    /// Service state
    pub status: ServiceStatus,
    /// Connection order (used for promotion priority)
    pub connection_order: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ServiceStatus {
    /// Running as a server
    Active,
    /// Connected as a client
    Client(SocketAddr), // Address of the connected server
    /// Stopped
    Inactive,
}

impl ServiceInfo {
    /// Check whether the service is alive (updated within the stale timeout)
    pub fn is_alive(&self) -> bool {
        if let Ok(elapsed) = self.last_seen.elapsed() {
            elapsed < SERVICE_STALE_TIMEOUT
        } else {
            false
        }
    }
}

/// Normalize the project path
pub fn normalize_project_path(path: &str) -> String {
    // Normalize Windows paths, resolve relative paths, etc.
    let canonical = std::fs::canonicalize(path).unwrap_or_else(|_| std::path::PathBuf::from(path));

    let result = if cfg!(target_os = "windows") {
        // Windows: remove the \\?\ prefix and replace backslashes with slashes
        let path_str = canonical.to_string_lossy();
        let cleaned = path_str.strip_prefix(r"\\?\").unwrap_or(&path_str);
        // Replace backslashes with slashes for consistency
        cleaned.replace('\\', "/")
    } else {
        canonical.to_string_lossy().to_string()
    };

    crate::p2p_diagnostics::trace!("[Discovery] Normalized path: {path} -> {result}");
    result
}
