use devcel_core::{DevcelError, Project, Record, Result, TableData, ValueType};
use serde_json::json;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
fn seed_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../app-settings")
}
mod app_catalog;
mod app_settings_migration;
mod plugin_resources;
mod theme_schema;

#[test]
fn embedded_seed_manifest_covers_owned_sources_without_byte_changes() {
    fn visit(root: &Path, dir: &Path, out: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            assert!(!path.is_symlink());
            if path.is_dir() {
                visit(root, &path, out)
            } else if matches!(
                path.extension().and_then(|v| v.to_str()),
                Some("toml" | "json")
            ) {
                out.insert(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .replace('\\', "/"),
                    fs::read(path).unwrap(),
                );
            }
        }
    }
    let root = seed_root();
    let mut expected = BTreeMap::new();
    visit(&root, &root, &mut expected);
    let actual = crate::settings_seed::source_files()
        .iter()
        .map(|(name, text)| (name.to_string(), text.as_bytes().to_vec()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(actual, expected);
}
