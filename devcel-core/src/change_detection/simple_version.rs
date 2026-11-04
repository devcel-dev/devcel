use async_trait::async_trait;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::change_detection::{
    ChangeDetector, ChangeEvent, ChangeType, SequenceComparison, SequenceId,
};
use crate::{DevcelError, Result};

/// Simple version-number-based change detector
pub struct SimpleVersionDetector {
    current_version: u64,
    project_path: PathBuf,
    instance_id: String,
    operation_log: Arc<Mutex<VecDeque<ChangeEvent>>>,
    watcher_handle: Option<tokio::task::JoinHandle<()>>,
}

impl Default for SimpleVersionDetector {
    fn default() -> Self {
        Self {
            current_version: 0,
            project_path: PathBuf::new(),
            instance_id: String::new(),
            operation_log: Arc::new(Mutex::new(VecDeque::new())),
            watcher_handle: None,
        }
    }
}

impl SimpleVersionDetector {
    /// Create an instance
    pub fn new() -> Self {
        Self::default()
    }

    /// Get the version file path
    fn version_file_path(&self) -> PathBuf {
        self.project_path.join(".devcel_version")
    }

    /// Get the log file path
    fn log_file_path(&self) -> PathBuf {
        self.project_path.join(".devcel_changes.log")
    }

    /// Save the version to a file
    async fn save_version(&self) -> Result<()> {
        let version_file = self.version_file_path();
        tokio::fs::write(&version_file, self.current_version.to_string())
            .await
            .map_err(DevcelError::Io)?;
        Ok(())
    }

    /// Save the log to a file
    async fn save_log(&self) -> Result<()> {
        let log_file = self.log_file_path();
        let log = self.operation_log.lock().await;
        let log_vec: Vec<_> = log.iter().cloned().collect();

        let json = serde_json::to_string_pretty(&log_vec).map_err(DevcelError::Serialization)?;

        tokio::fs::write(&log_file, json)
            .await
            .map_err(DevcelError::Io)?;

        Ok(())
    }
}

#[async_trait]
impl ChangeDetector for SimpleVersionDetector {
    async fn initialize(&mut self, project_path: &Path, instance_id: &str) -> Result<()> {
        self.project_path = project_path.to_path_buf();
        self.instance_id = instance_id.to_string();

        // Read from the version file
        let version_file = self.version_file_path();
        if version_file.exists() {
            let content = tokio::fs::read_to_string(&version_file)
                .await
                .map_err(DevcelError::Io)?;
            self.current_version = content.trim().parse().unwrap_or(0);
        }

        // Read from the log file
        let log_file = self.log_file_path();
        if log_file.exists() {
            let content = tokio::fs::read_to_string(&log_file)
                .await
                .map_err(DevcelError::Io)?;

            if let Ok(log_vec) = serde_json::from_str::<Vec<ChangeEvent>>(&content) {
                let mut log = self.operation_log.lock().await;
                *log = log_vec.into_iter().collect();
            }
        }

        Ok(())
    }

    fn get_current_sequence(&self) -> SequenceId {
        SequenceId::Simple(self.current_version)
    }

    async fn record_change(
        &mut self,
        change_type: ChangeType,
        affected_items: Vec<String>,
    ) -> Result<SequenceId> {
        self.current_version += 1;

        let event = ChangeEvent {
            sequence_id: SequenceId::Simple(self.current_version),
            timestamp: std::time::SystemTime::now(),
            source_instance: self.instance_id.clone(),
            change_type,
            affected_items,
        };

        // Append to the log
        {
            let mut log = self.operation_log.lock().await;
            if log.len() >= 1000 {
                log.pop_front();
            }
            log.push_back(event.clone());
        }

        // Save to a file
        self.save_version().await?;
        self.save_log().await?;

        Ok(SequenceId::Simple(self.current_version))
    }

    async fn get_changes_since(&self, since: &SequenceId) -> Result<Vec<ChangeEvent>> {
        if let SequenceId::Simple(since_version) = since {
            let log = self.operation_log.lock().await;
            let changes: Vec<_> = log
                .iter()
                .filter(|event| {
                    if let SequenceId::Simple(v) = &event.sequence_id {
                        v > since_version
                    } else {
                        false
                    }
                })
                .cloned()
                .collect();
            Ok(changes)
        } else {
            Err(DevcelError::InvalidOperation(
                "Incompatible sequence ID type".to_string(),
            ))
        }
    }

    async fn start_watching(
        &mut self,
        callback: Box<dyn Fn(ChangeEvent) + Send + Sync>,
    ) -> Result<()> {
        // Poll the version file once per second.
        let version_file = self.version_file_path();
        let current_version = self.current_version;
        let _instance_id = self.instance_id.clone();
        let callback = Arc::new(callback);

        let handle = tokio::spawn(async move {
            let mut last_version = current_version;

            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

                if let Ok(content) = tokio::fs::read_to_string(&version_file).await {
                    if let Ok(version) = content.trim().parse::<u64>() {
                        if version > last_version {
                            // Detect changes
                            let event = ChangeEvent {
                                sequence_id: SequenceId::Simple(version),
                                timestamp: std::time::SystemTime::now(),
                                source_instance: "external".to_string(),
                                change_type: ChangeType::ProjectMetadataChanged,
                                affected_items: vec![],
                            };
                            callback(event);
                            last_version = version;
                        }
                    }
                }
            }
        });

        self.watcher_handle = Some(handle);
        Ok(())
    }

    async fn stop_watching(&mut self) -> Result<()> {
        if let Some(handle) = self.watcher_handle.take() {
            handle.abort();
        }
        Ok(())
    }

    fn compare_sequence(&self, other: &SequenceId) -> SequenceComparison {
        match (self.get_current_sequence(), other) {
            (SequenceId::Simple(current), SequenceId::Simple(other)) => match current.cmp(other) {
                std::cmp::Ordering::Less => SequenceComparison::Behind,
                std::cmp::Ordering::Greater => SequenceComparison::Ahead,
                std::cmp::Ordering::Equal => SequenceComparison::Equal,
            },
            _ => SequenceComparison::Diverged,
        }
    }

    async fn cleanup(&mut self) -> Result<()> {
        self.stop_watching().await?;
        Ok(())
    }
}

impl Drop for SimpleVersionDetector {
    fn drop(&mut self) {
        if let Some(handle) = self.watcher_handle.take() {
            handle.abort();
        }
    }
}
