//! Content-addressed acceleration for the existing semantic disk CAS check.
//! Every caller still reads the file under its write lock and hashes its bytes.
//! Only successful TableData decodes may establish a raw -> semantic mapping.
use crate::{cell_rules, Result, TableData};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    sync::{Mutex, OnceLock},
};

const CAPACITY: usize = 64;
type RawHash = [u8; 32];
static REVISIONS: OnceLock<Mutex<VecDeque<(RawHash, String)>>> = OnceLock::new();

fn cache() -> &'static Mutex<VecDeque<(RawHash, String)>> {
    REVISIONS.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAPACITY)))
}

fn raw_hash(text: &str) -> RawHash {
    Sha256::digest(text.as_bytes()).into()
}

fn known_revision(raw: &RawHash) -> Option<String> {
    cache()
        .lock()
        .ok()?
        .iter()
        .find(|(hash, _)| hash == raw)
        .map(|(_, semantic)| semantic.clone())
}

fn remember(raw: RawHash, semantic: String) {
    // A poisoned optimization must never weaken validation or fail a save.
    let Ok(mut entries) = cache().lock() else {
        return;
    };
    if let Some(index) = entries.iter().position(|(hash, _)| hash == &raw) {
        entries.remove(index);
    } else if entries.len() == CAPACITY {
        entries.pop_front();
    }
    entries.push_back((raw, semantic));
}

pub(crate) fn from_toml(text: &str) -> Result<String> {
    let raw = raw_hash(text);
    if let Some(semantic) = known_revision(&raw) {
        return Ok(semantic);
    }
    // Includes format-only rewrites and arbitrary external changes. Parse
    // failures are never cached; equality remains the same canonical revision.
    let data = TableData::from_toml(text)?;
    let semantic = cell_rules::revision(&data);
    remember(raw, semantic.clone());
    Ok(semantic)
}

/// Caller has just successfully decoded these exact bytes as this TableData.
pub(crate) fn remember_parsed(text: &str, data: &TableData) {
    let raw = raw_hash(text);
    if known_revision(&raw).is_none() {
        remember(raw, cell_rules::revision(data));
    }
}

/// Warm the next CAS check without reparsing the TOML text we just generated.
/// Normalize through TOML's typed value/deserializer first: omitted Options and
/// defaulted fields must hash as they will on disk, not as an assumed live clone.
/// Serialization of the file itself is unchanged. A normalization failure merely
/// leaves this content uncached, so the normal disk parser remains authoritative.
pub(crate) fn remember_serialized(text: &str, data: &TableData) {
    let raw = raw_hash(text);
    if known_revision(&raw).is_some() {
        return;
    }
    let Ok(normalized) = crate::table_storage::normalize(data) else {
        return;
    };
    remember(raw, cell_rules::revision(&normalized));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed_revision(text: &str) -> String {
        let data: TableData = toml::from_str(text).unwrap();
        let canonical = serde_json::to_value(data).unwrap();
        format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&canonical).unwrap())
        )
    }

    #[test]
    fn serialized_cache_matches_disk_normalization_and_float_boundaries() {
        for (index, value) in [
            0.0,
            -0.0,
            0.1,
            f64::MIN_POSITIVE,
            f64::from_bits(1),
            f64::MIN,
            f64::MAX,
            9007199254740992.0,
            1e-100,
            1e100,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NAN,
        ]
        .into_iter()
        .enumerate()
        {
            let mut data = cell_rules::canonical_revision_tests::full_table();
            data.description = format!("serialized-cache-boundary-{index}");
            data.schema.columns[0].curve_config = Some(crate::CurveConfig {
                start_value: value,
                end_value: -value,
            });
            data.schema.columns[1]
                .constraints
                .as_mut()
                .unwrap()
                .min_value = Some(value);
            let old_text = toml::to_string(&data).unwrap();
            let text = crate::table_storage::to_toml(&data).unwrap();
            let expected = parsed_revision(&text);
            assert_eq!(expected, parsed_revision(&old_text));
            remember_serialized(&text, &data);
            assert_eq!(known_revision(&raw_hash(&text)), Some(expected.clone()));
            assert_eq!(from_toml(&text).unwrap(), expected);
        }
    }

    #[test]
    fn cached_revisions_preserve_omitted_options_and_external_rewrites() {
        let mut data = cell_rules::canonical_revision_tests::full_table();
        data.description = "serialized-cache-omitted-options".into();
        data.schema.columns = vec![crate::ColumnSchema {
            data_name: "value".into(),
            ..Default::default()
        }];
        for record in &mut data.records {
            record.interface_values.clear();
        }
        let text = toml::to_string(&data).unwrap();
        let expected = parsed_revision(&text);
        remember_serialized(&text, &data);
        assert_eq!(known_revision(&raw_hash(&text)), Some(expected.clone()));
        let formatted = format!("# external format-only rewrite\n\n{text}\n");
        assert_ne!(raw_hash(&text), raw_hash(&formatted));
        assert_eq!(from_toml(&formatted).unwrap(), expected);
        data.records[0]
            .values
            .insert("value".into(), "externally changed".into());
        let changed = toml::to_string(&data).unwrap();
        let changed_revision = parsed_revision(&changed);
        assert_ne!(changed_revision, expected);
        assert_eq!(from_toml(&changed).unwrap(), changed_revision);
        let decoded: TableData = toml::from_str(&changed).unwrap();
        remember_parsed(&changed, &decoded);
        assert_eq!(known_revision(&raw_hash(&changed)), Some(changed_revision));
    }

    #[test]
    fn cache_never_accepts_invalid_storage_or_parse_failures() {
        let mut data = cell_rules::canonical_revision_tests::full_table();
        data.description = "serialized-cache-invalid-storage".into();
        data.records[0]
            .values
            .insert("unknown_column".into(), "untrusted".into());
        let text = toml::to_string(&data).unwrap();
        assert!(toml::from_str::<TableData>(&text).is_err());
        remember_serialized(&text, &data);
        assert!(known_revision(&raw_hash(&text)).is_none());
        assert!(from_toml(&text).is_err());
        assert!(known_revision(&raw_hash(&text)).is_none());
        let malformed = "[invalid cache parse test";
        assert!(from_toml(malformed).is_err());
        assert!(known_revision(&raw_hash(malformed)).is_none());
    }
}
