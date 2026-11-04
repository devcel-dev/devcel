//! Exact filenames reserved for Devcel's internal atomic-save artifacts.
//! Do not hide arbitrary dotfiles, `.tmp` files, or directories from project users.
use std::path::Path;

pub(crate) const SAVE_TEMP_PREFIX: &str = ".devcel-write-";
pub(crate) const SAVE_TEMP_SUFFIX: &str = ".tmp";
pub(crate) const SAVE_TEMP_RANDOM_BYTES: usize = 16;

/// Called only for file entries, never for directories. Recognize legacy
/// sidecars without recreating or unlinking them; current locks live in Temp.
pub(crate) fn is_internal_save_artifact(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    if let Some(target) = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".devcel-write.lock"))
    {
        if [".table.toml", ".interface.toml"].iter().any(|suffix| {
            target
                .strip_suffix(*suffix)
                .is_some_and(|stem| !stem.is_empty())
        }) {
            return true;
        }
    }
    name.strip_prefix(SAVE_TEMP_PREFIX)
        .and_then(|name| name.strip_suffix(SAVE_TEMP_SUFFIX))
        .is_some_and(|random| {
            random.len() == SAVE_TEMP_RANDOM_BYTES
                && random.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
}
