use crate::operations::{DevcelOperation, OperationMetadata};
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::RwLock;

/// Maximum number of operations to keep in history
const MAX_OPERATION_HISTORY: usize = 10000;
const MAX_PENDING_COUNT: usize = 1024;
const MAX_PENDING_PER_CLIENT: usize = 128;
const MAX_PENDING_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_OPERATION_BYTES: usize = 8 * 1024 * 1024;
struct PendingOperation {
    operation: DevcelOperation,
    metadata: OperationMetadata,
    _memory: tokio::sync::OwnedSemaphorePermit,
}
struct SizeCounter(usize);
impl std::io::Write for SizeCounter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self
            .0
            .checked_add(bytes.len())
            .filter(|size| *size <= MAX_PENDING_OPERATION_BYTES)
            .ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Pending operation exceeds retained limit",
                )
            })?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Type alias for pending operations map
type PendingOperationsMap = HashMap<u64, VecDeque<PendingOperation>>;

/// Manages operation ordering and conflict resolution
pub struct ConflictResolver {
    /// Operations waiting to be applied, keyed by client ID
    pending_operations: Arc<RwLock<PendingOperationsMap>>,
    /// Last applied sequence number for each client
    last_sequences: Arc<RwLock<HashMap<u64, u64>>>,
    /// Operation history for causality tracking
    operation_history: Arc<RwLock<Vec<OperationMetadata>>>,
    retained_memory: Arc<tokio::sync::Semaphore>,
}

impl Default for ConflictResolver {
    fn default() -> Self {
        Self {
            pending_operations: Arc::new(RwLock::new(HashMap::new())),
            last_sequences: Arc::new(RwLock::new(HashMap::new())),
            operation_history: Arc::new(RwLock::new(Vec::new())),
            retained_memory: Arc::new(tokio::sync::Semaphore::new(MAX_PENDING_BYTES)),
        }
    }
}

impl ConflictResolver {
    pub fn new() -> Self {
        Self::default()
    }

    async fn record_history(&self, metadata: impl IntoIterator<Item = OperationMetadata>) {
        // Causality history needs metadata, never potentially huge operation bodies.
        let mut history = self.operation_history.write().await;
        history.extend(metadata);
        let excess = history.len().saturating_sub(MAX_OPERATION_HISTORY);
        history.drain(0..excess);
    }

    pub(crate) async fn next_sequence(&self, peer: u64) -> Result<u64, String> {
        self.last_sequences
            .read()
            .await
            .get(&peer)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or_else(|| "Peer sequence exhausted; reconnect".into())
    }

    /// Rejected admission leaves every previously accepted pending operation intact.
    pub async fn add_operation(
        &self,
        operation: DevcelOperation,
        metadata: OperationMetadata,
    ) -> Result<bool, String> {
        if metadata.sequence == 0
            || metadata.previous_hash.as_ref().is_some_and(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
        {
            return Err("Invalid operation sequence or causality hash".into());
        }
        let mut sequences = self.last_sequences.write().await;
        let next = sequences
            .get(&metadata.client_id)
            .copied()
            .unwrap_or(0)
            .checked_add(1)
            .ok_or("Peer sequence exhausted; reconnect")?;
        if metadata.sequence < next {
            return Ok(false);
        }
        let mut pending = self.pending_operations.write().await;
        if pending.get(&metadata.client_id).is_some_and(|queue| {
            queue
                .iter()
                .any(|entry| entry.metadata.sequence == metadata.sequence)
        }) {
            return Err("Duplicate pending sequence; original operation remains queued".into());
        }
        if metadata.sequence == next {
            sequences.insert(metadata.client_id, metadata.sequence);
            drop(pending);
            drop(sequences);
            self.record_history([metadata]).await;
            return Ok(true);
        }
        let total: usize = pending.values().map(VecDeque::len).sum();
        if total >= MAX_PENDING_COUNT
            || pending
                .get(&metadata.client_id)
                .is_some_and(|queue| queue.len() >= MAX_PENDING_PER_CLIENT)
        {
            return Err(
                "Pending operation count exhausted; fill sequence gaps or reconnect".into(),
            );
        }
        let mut size = SizeCounter(0);
        serde::Serialize::serialize(
            &(&operation, &metadata),
            &mut rmp_serde::Serializer::new(&mut size).with_struct_map(),
        )
        .map_err(|_| "Pending operation exceeds retained byte limit")?;
        let memory = self
            .retained_memory
            .clone()
            .try_acquire_many_owned(size.0 as u32)
            .map_err(|_| {
                "Pending operation byte budget exhausted; fill sequence gaps or reconnect"
            })?;
        let queue = pending.entry(metadata.client_id).or_default();
        let position = queue
            .iter()
            .position(|entry| entry.metadata.sequence > metadata.sequence)
            .unwrap_or(queue.len());
        queue.insert(
            position,
            PendingOperation {
                operation,
                metadata,
                _memory: memory,
            },
        );
        Ok(false)
    }

    pub async fn get_ready_operations(
        &self,
        client_id: u64,
    ) -> Vec<(DevcelOperation, OperationMetadata)> {
        let mut ready = Vec::new();
        let mut sequences = self.last_sequences.write().await;
        let mut pending = self.pending_operations.write().await;
        let mut last = sequences.get(&client_id).copied().unwrap_or(0);
        if let Some(queue) = pending.get_mut(&client_id) {
            while queue
                .front()
                .is_some_and(|entry| last.checked_add(1) == Some(entry.metadata.sequence))
            {
                let entry = queue.pop_front().unwrap();
                last = entry.metadata.sequence;
                ready.push((entry.operation, entry.metadata));
                // The returned batch is bounded by the same retained limits.
            }
            if queue.is_empty() {
                pending.remove(&client_id);
            }
        }
        if !ready.is_empty() {
            sequences.insert(client_id, last);
        }
        drop(pending);
        drop(sequences);
        self.record_history(ready.iter().map(|(_, metadata)| metadata.clone()))
            .await;
        ready
    }

    pub async fn forget_client(&self, peer: u64) {
        let mut sequences = self.last_sequences.write().await;
        self.pending_operations.write().await.remove(&peer);
        sequences.remove(&peer);
        self.operation_history
            .write()
            .await
            .retain(|metadata| metadata.client_id != peer);
    }

    /// Resolve conflicts between operations
    pub fn resolve_conflict(
        op1: &DevcelOperation,
        meta1: &OperationMetadata,
        op2: &DevcelOperation,
        meta2: &OperationMetadata,
    ) -> ConflictResolution {
        use DevcelOperation::*;

        // Last write wins helper (timestamp, then client_id as tiebreaker).
        let second_is_newer = meta2.timestamp > meta1.timestamp
            || (meta2.timestamp == meta1.timestamp && meta2.client_id > meta1.client_id);

        // Check for specific conflict cases
        match (op1, op2) {
            // Same cell edits
            (
                SetRecordValue {
                    table_uuid: t1,
                    record_uuid: r1,
                    column_name: c1,
                    ..
                },
                SetRecordValue {
                    table_uuid: t2,
                    record_uuid: r2,
                    column_name: c2,
                    ..
                },
            ) => {
                if t1 == t2 && r1 == r2 && c1 == c2 {
                    // Same cell - apply deterministic last-write-wins.
                    if second_is_newer {
                        ConflictResolution::KeepSecond
                    } else {
                        ConflictResolution::KeepFirst
                    }
                } else {
                    // Different cells - both can be applied
                    ConflictResolution::KeepBoth
                }
            }

            // Delete vs edit conflicts
            (
                DeleteRecord {
                    table_uuid: t1,
                    record_uuid: r1,
                },
                SetRecordValue {
                    table_uuid: t2,
                    record_uuid: r2,
                    ..
                },
            )
            | (
                SetRecordValue {
                    table_uuid: t2,
                    record_uuid: r2,
                    ..
                },
                DeleteRecord {
                    table_uuid: t1,
                    record_uuid: r1,
                },
            ) => {
                if t1 == t2 && r1 == r2 {
                    // Delete wins over edit
                    if matches!(op1, DeleteRecord { .. }) {
                        ConflictResolution::KeepFirst
                    } else {
                        ConflictResolution::KeepSecond
                    }
                } else {
                    ConflictResolution::KeepBoth
                }
            }

            // Column operations
            (
                RemoveColumn {
                    table_uuid: t1,
                    column_name: c1,
                },
                SetRecordValue {
                    table_uuid: t2,
                    column_name: c2,
                    ..
                },
            )
            | (
                SetRecordValue {
                    table_uuid: t2,
                    column_name: c2,
                    ..
                },
                RemoveColumn {
                    table_uuid: t1,
                    column_name: c1,
                },
            ) => {
                if t1 == t2 && c1 == c2 {
                    // Column removal wins
                    if matches!(op1, RemoveColumn { .. }) {
                        ConflictResolution::KeepFirst
                    } else {
                        ConflictResolution::KeepSecond
                    }
                } else {
                    ConflictResolution::KeepBoth
                }
            }

            _ => ConflictResolution::KeepBoth,
        }
    }

    /// Clean up old pending operations that are likely never going to be applied
    pub async fn cleanup_stale_operations(&self, timeout_secs: u64) {
        use std::time::{SystemTime, UNIX_EPOCH};

        let current_time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let mut pending = self.pending_operations.write().await;
        let mut clients_to_remove = Vec::new();

        for (client_id, queue) in pending.iter_mut() {
            // Remove operations older than timeout
            queue.retain(|entry| {
                let op_age = current_time.saturating_sub(entry.metadata.timestamp / 1_000_000); // Convert micros to secs
                op_age < timeout_secs
            });

            if queue.is_empty() {
                clients_to_remove.push(*client_id);
            }
        }

        // Remove empty queues
        for client_id in clients_to_remove {
            pending.remove(&client_id);
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum ConflictResolution {
    KeepFirst,
    KeepSecond,
    KeepBoth,
    Transform(Box<(DevcelOperation, DevcelOperation)>), // Future: operational transformation
}

impl OperationMetadata {
    pub fn new(client_id: u64, sequence: u64) -> Self {
        use std::time::{SystemTime, UNIX_EPOCH};

        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_micros() as u64;

        Self {
            client_id,
            timestamp,
            sequence,
            previous_hash: None,
        }
    }

    /// Calculate hash for causality tracking
    pub fn calculate_hash(&self, operation: &DevcelOperation) -> String {
        use sha2::{Digest, Sha256};

        let mut hasher = Sha256::new();
        hasher.update(format!("{operation:?}").as_bytes());
        hasher.update(self.client_id.to_be_bytes());
        hasher.update(self.timestamp.to_be_bytes());
        hasher.update(self.sequence.to_be_bytes());

        format!("{:x}", hasher.finalize())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operations::DevcelOperation;

    #[tokio::test]
    async fn pending_limits_preserve_sequences_and_disconnect_releases_memory() {
        let resolver = ConflictResolver::new();
        for sequence in 2..=MAX_PENDING_PER_CLIENT as u64 + 1 {
            assert!(!resolver
                .add_operation(DevcelOperation::Ping, OperationMetadata::new(7, sequence))
                .await
                .unwrap());
        }
        assert!(resolver
            .add_operation(DevcelOperation::Ping, OperationMetadata::new(7, 130))
            .await
            .is_err());
        assert!(resolver
            .add_operation(DevcelOperation::Ping, OperationMetadata::new(7, 2))
            .await
            .is_err());
        assert_eq!(
            resolver.pending_operations.read().await[&7].len(),
            MAX_PENDING_PER_CLIENT
        );
        assert!(resolver
            .add_operation(DevcelOperation::Ping, OperationMetadata::new(7, 1))
            .await
            .unwrap());
        let ready = resolver.get_ready_operations(7).await;
        assert_eq!(
            ready
                .iter()
                .map(|(_, meta)| meta.sequence)
                .collect::<Vec<_>>(),
            (2..=129).collect::<Vec<_>>()
        );
        assert_eq!(resolver.next_sequence(7).await.unwrap(), 130);
        assert_eq!(
            resolver.retained_memory.available_permits(),
            MAX_PENDING_BYTES
        );
        assert!(!resolver
            .add_operation(DevcelOperation::Ping, OperationMetadata::new(7, 140))
            .await
            .unwrap());
        assert!(resolver.retained_memory.available_permits() < MAX_PENDING_BYTES);
        resolver.forget_client(7).await;
        assert_eq!(
            resolver.retained_memory.available_permits(),
            MAX_PENDING_BYTES
        );
        assert!(resolver.pending_operations.read().await.is_empty());
        assert!(resolver.operation_history.read().await.is_empty());
        assert_eq!(resolver.next_sequence(7).await.unwrap(), 1);
    }

    #[tokio::test]
    async fn pending_global_count_and_byte_limits_reject_without_eviction() {
        let resolver = ConflictResolver::new();
        for peer in 0..8 {
            for sequence in 2..=129 {
                resolver
                    .add_operation(
                        DevcelOperation::Ping,
                        OperationMetadata::new(peer, sequence),
                    )
                    .await
                    .unwrap();
            }
        }
        assert!(resolver
            .add_operation(DevcelOperation::Ping, OperationMetadata::new(9, 2))
            .await
            .is_err());
        assert_eq!(
            resolver
                .pending_operations
                .read()
                .await
                .values()
                .map(VecDeque::len)
                .sum::<usize>(),
            MAX_PENDING_COUNT
        );
        for peer in 0..8 {
            resolver.forget_client(peer).await;
        }
        let large = DevcelOperation::SetRecordValue {
            table_uuid: "t".into(),
            record_uuid: "r".into(),
            column_name: "c".into(),
            value: "x".repeat(7 * 1024 * 1024),
        };
        for sequence in 2..=5 {
            resolver
                .add_operation(large.clone(), OperationMetadata::new(1, sequence))
                .await
                .unwrap();
        }
        assert!(resolver
            .add_operation(large, OperationMetadata::new(1, 6))
            .await
            .is_err());
        assert_eq!(resolver.pending_operations.read().await[&1].len(), 4);
        resolver.forget_client(1).await;
        assert_eq!(
            resolver.retained_memory.available_permits(),
            MAX_PENDING_BYTES
        );
        let oversized = DevcelOperation::SetRecordValue {
            table_uuid: "t".into(),
            record_uuid: "r".into(),
            column_name: "c".into(),
            value: "x".repeat(MAX_PENDING_OPERATION_BYTES),
        };
        assert!(resolver
            .add_operation(oversized, OperationMetadata::new(1, 2))
            .await
            .is_err());
        assert!(resolver.pending_operations.read().await.is_empty());
    }

    #[tokio::test]
    async fn test_last_write_wins() {
        // Test that newer timestamp wins
        let op1 = DevcelOperation::SetRecordValue {
            table_uuid: "table1".to_string(),
            record_uuid: "record1".to_string(),
            column_name: "col1".to_string(),
            value: "value1".to_string(),
        };

        let op2 = DevcelOperation::SetRecordValue {
            table_uuid: "table1".to_string(),
            record_uuid: "record1".to_string(),
            column_name: "col1".to_string(),
            value: "value2".to_string(),
        };

        let meta1 = OperationMetadata {
            client_id: 1,
            timestamp: 1000,
            sequence: 1,
            previous_hash: None,
        };

        let meta2 = OperationMetadata {
            client_id: 2,
            timestamp: 2000, // Newer timestamp
            sequence: 1,
            previous_hash: None,
        };

        let resolution = ConflictResolver::resolve_conflict(&op1, &meta1, &op2, &meta2);
        assert_eq!(resolution, ConflictResolution::KeepSecond);
    }

    #[tokio::test]
    async fn test_operation_sequencing() {
        let resolver = ConflictResolver::new();

        let op1 = DevcelOperation::SetRecordValue {
            table_uuid: "table1".to_string(),
            record_uuid: "record1".to_string(),
            column_name: "col1".to_string(),
            value: "value1".to_string(),
        };

        let meta1 = OperationMetadata::new(1, 1);
        let meta3 = OperationMetadata::new(1, 3); // Out of order

        // Add operation with sequence 3 (should be queued)
        let should_apply = resolver.add_operation(op1.clone(), meta3).await.unwrap();
        assert!(!should_apply);

        // Add operation with sequence 1 (should be applied)
        let should_apply = resolver.add_operation(op1.clone(), meta1).await.unwrap();
        assert!(should_apply);

        // Check that no operations are ready yet (missing sequence 2)
        let ready_ops = resolver.get_ready_operations(1).await;
        assert_eq!(ready_ops.len(), 0);
    }

    #[tokio::test]
    async fn test_history_cleanup() {
        let resolver = ConflictResolver::new();

        // Add more than MAX_OPERATION_HISTORY operations
        for i in 0..12000 {
            let op = DevcelOperation::Ping;
            let meta = OperationMetadata::new(1, i + 1);
            let _ = resolver.add_operation(op, meta).await;
        }

        // History should be limited to MAX_OPERATION_HISTORY
        let history = resolver.operation_history.read().await;
        assert!(history.len() <= MAX_OPERATION_HISTORY);
    }

    #[tokio::test]
    async fn test_stale_operation_cleanup() {
        let resolver = ConflictResolver::new();

        // Add an out-of-order operation with old timestamp
        let op = DevcelOperation::Ping;
        let mut meta = OperationMetadata::new(1, 10);
        meta.timestamp = 1000; // Very old timestamp

        let _ = resolver.add_operation(op, meta).await;

        // Clean up operations older than 1 second
        resolver.cleanup_stale_operations(1).await;

        // Pending operations should be empty
        let pending = resolver.pending_operations.read().await;
        assert!(pending.is_empty());
    }
}
