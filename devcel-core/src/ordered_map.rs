//! Stable ordering for unordered persisted maps. Struct declaration order and
//! semantic sequence order stay unchanged; only map keys are sorted.
use serde::{Serialize, Serializer};
use std::collections::HashMap;

pub(crate) fn serialize<K: Ord + Serialize, V: Serialize, S: Serializer>(
    values: &HashMap<K, V>,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    let mut entries: Vec<_> = values.iter().collect();
    entries.sort_unstable_by_key(|(left, _)| *left);
    serializer.collect_map(entries)
}
