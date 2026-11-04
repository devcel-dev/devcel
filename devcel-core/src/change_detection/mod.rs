use crate::Result;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::time::SystemTime;

pub mod simple_version;

pub use simple_version::SimpleVersionDetector;

/// Structure representing a change
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub sequence_id: SequenceId,
    pub timestamp: SystemTime,
    pub source_instance: String,
    pub change_type: ChangeType,
    pub affected_items: Vec<String>,
}

/// Abstract sequence ID type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum SequenceId {
    Simple(u64),
    Vector(HashMap<String, u64>),
    Timestamp(SystemTime),
    Custom(String),
}

/// Change type
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum ChangeType {
    ProjectMetadataChanged,
    TableAdded {
        table_uuid: String,
    },
    TableModified {
        table_uuid: String,
    },
    TableDeleted {
        table_uuid: String,
    },
    RecordChanged {
        table_uuid: String,
        record_uuid: String,
    },
    ColumnChanged {
        table_uuid: String,
        column_uuid: String,
    },
    DirectoryChanged {
        path: String,
    },
    CommandExecuted {
        command_type: String,
    },
}

/// Sequence comparison result
#[derive(Debug, PartialEq, Eq)]
pub enum SequenceComparison {
    Behind,
    Ahead,
    Equal,
    Diverged,
}

/// Change detector trait
#[async_trait]
pub trait ChangeDetector: Send + Sync {
    /// Initialize
    async fn initialize(&mut self, project_path: &Path, instance_id: &str) -> Result<()>;

    /// Get the current sequence ID
    fn get_current_sequence(&self) -> SequenceId;

    /// Record a change
    async fn record_change(
        &mut self,
        change_type: ChangeType,
        affected_items: Vec<String>,
    ) -> Result<SequenceId>;

    /// Get changes after the specified sequence
    async fn get_changes_since(&self, since: &SequenceId) -> Result<Vec<ChangeEvent>>;

    /// Start watching for changes (pass the callback in a Box)
    async fn start_watching(
        &mut self,
        callback: Box<dyn Fn(ChangeEvent) + Send + Sync>,
    ) -> Result<()>;

    /// Stop watching
    async fn stop_watching(&mut self) -> Result<()>;

    /// Compare with another instance's sequence
    fn compare_sequence(&self, other: &SequenceId) -> SequenceComparison;

    /// Clean up (called automatically on Drop)
    async fn cleanup(&mut self) -> Result<()> {
        Ok(())
    }
}
