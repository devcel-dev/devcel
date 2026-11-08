//! Version checks for persistent table and interface TOML documents.
use serde::{Deserialize, Deserializer, Serializer};

/// Current table and interface TOML schema version. An absent marker is legacy v1.
pub const CURRENT_SCHEMA_VERSION: u32 = 1;

pub(crate) fn default_schema_version() -> u32 {
    CURRENT_SCHEMA_VERSION
}

pub(crate) fn deserialize_schema_version<'de, D>(deserializer: D) -> Result<u32, D::Error>
where
    D: Deserializer<'de>,
{
    let version = u32::deserialize(deserializer)?;
    if version != CURRENT_SCHEMA_VERSION {
        return Err(serde::de::Error::custom(format!(
            "unsupported Devcel authoring schema version {version}; this version supports {}",
            CURRENT_SCHEMA_VERSION
        )));
    }
    Ok(version)
}

pub(crate) fn serialize_schema_version<S>(version: &u32, serializer: S) -> Result<S::Ok, S::Error>
where
    S: Serializer,
{
    if *version != CURRENT_SCHEMA_VERSION {
        return Err(serde::ser::Error::custom(format!(
            "unsupported Devcel authoring schema version {version}; refusing to write"
        )));
    }
    serializer.serialize_u32(*version)
}
