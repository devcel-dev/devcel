// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2024 Devcel Studio Contributors
// See devcel-studio/LICENSE in the complete source distribution.

use toml08 as toml;

use super::*;
use devcel_core::plugin_resources::*;
use serde_json::Value;
fn source() -> Project {
    devcel_core::localization::load(&seed_root().join("studio.devcelproj.toml")).unwrap()
}
fn fixture(owner: &str) -> ResourceTables {
    use devcel_core::interface::{Interface, InterfaceChange, InterfaceRegistry};
    let original: TableData = toml::from_str(
        &std::fs::read_to_string(
            seed_root().join("Tables/Plugins/csv-exporter/settings.table.toml"),
        )
        .unwrap(),
    )
    .unwrap();
    let mut contract = Interface::new(contract_name(owner, "preferences"), None);
    let changes = original
        .schema
        .columns
        .iter()
        .map(|old| {
            let mut c = old.clone();
            c.uuid = uuid::Uuid::new_v4().to_string();
            c.interface_origin = None;
            c.interface_origin_name_fallback = None;
            InterfaceChange::AddColumn { column: c }
        })
        .collect();
    contract.create_new_version(changes, None, None).unwrap();
    let mut interfaces = InterfaceRegistry::new();
    interfaces.add_interface(contract.clone()).unwrap();
    let mut data = original.clone();
    data.uuid = uuid::Uuid::new_v4().to_string();
    data.metadata.data_name = table_name(owner, "preferences");
    data.schema.columns.clear();
    data.records.clear();
    data.interface_implementations.clear();
    data.metadata.interface_order.clear();
    let mut table = devcel_core::Table {
        path: std::path::PathBuf::new(),
        data,
        is_dirty: false,
        undo_history: vec![],
        redo_history: vec![],
    };
    table.apply_interface(&contract, &interfaces, true).unwrap();
    for old in &original.records {
        let mut row = devcel_core::Record::new();
        for (column, previous) in table
            .data
            .schema
            .columns
            .iter()
            .zip(&original.schema.columns)
        {
            row.set_cell_value(column, old.get_cell_value(previous).unwrap().clone());
        }
        table.data.records.push(row);
    }
    ResourceTables {
        owner: owner.into(),
        previous_tables: vec![],
        tables: vec![ResourceTable {
            id: "preferences".into(),
            kind: ResourceKind::Settings,
            cardinality: ResourceCardinality::Singleton,
            table: table.data,
            contract,
        }],
    }
}
fn set(table: &mut TableData, row: usize, name: &str, value: &str) {
    let column = table
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == name)
        .unwrap();
    table.records[row].set_cell_value(column, value.into());
}
fn binding_list(project: &Project) -> Vec<RegistryBinding> {
    registry_bindings(
        &registry(project).unwrap().unwrap().data,
        &project.tables_data,
        &project.interface_registry,
    )
    .unwrap()
}
#[test]
fn bundled_csv_uses_the_same_declarative_validator_and_compiler() {
    let root = seed_root().join("Tables/Plugins/csv-exporter");
    let manifest: ResourceManifest =
        serde_json::from_slice(&std::fs::read(root.join("resources.json")).unwrap()).unwrap();
    let files = [
        "settings.table.toml",
        "translations.table.toml",
        "settings.interface.toml",
        "translations.interface.toml",
    ]
    .into_iter()
    .map(|name| (name.into(), std::fs::read(root.join(name)).unwrap()))
    .collect();
    let resources = validate_resources("csv-exporter", &manifest, &files).unwrap();
    assert_eq!(resources.tables.len(), 2);
    let mut project = source();
    let custom = project
        .tables_data
        .values_mut()
        .find(|table| table.data.uuid == "f9bfa470-b406-565b-918d-4e1f7bdb1b09")
        .unwrap();
    custom.data.display_name = "My authored CSV title".into();
    let compiled = crate::settings_seed::compile_runtime(&project).unwrap();
    assert_eq!(
        compiled.plugin_labels["f9bfa470-b406-565b-918d-4e1f7bdb1b09"].source,
        "CSV出力設定"
    );
    assert_eq!(
        compiled.plugin_settings["csv-exporter"]["settings"]["defaultDelimiter"],
        ","
    );
    assert!(compiled.plugin_translations["csv-exporter"]["ja"].contains_key("name"));
}
#[test]
fn project_delete_preserves_registered_table_for_loaded_and_lazy_projects() {
    let temp = tempfile::tempdir().unwrap();
    let entry = crate::settings_seed::seed_project(temp.path()).unwrap();
    let mut project = devcel_core::localization::load(&entry).unwrap();
    let target = binding_list(&project)[0].table_uuid.clone();
    let path = project
        .tables_data
        .iter()
        .find(|(_, t)| t.data.uuid == target)
        .unwrap()
        .0
        .clone();
    let bytes = std::fs::read(&path).unwrap();
    let error = project.delete_table(path.clone()).unwrap_err();
    assert!(
        format!("{error:?}").contains("error.referencedRowDelete"),
        "{error:?}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
    let mut lazy = Project::open_project(&entry.to_string_lossy()).unwrap();
    assert!(lazy.tables_data.is_empty());
    let error = lazy.delete_table(path.clone()).unwrap_err();
    assert!(
        format!("{error:?}").contains("error.referencedRowDelete"),
        "{error:?}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), bytes);
}

#[test]
fn registered_resource_blocks_delete_even_with_defaulted_reference() {
    let mut project = source();
    let binding = binding_list(&project).remove(0);
    let registration = project
        .tables_data
        .values_mut()
        .find(|t| t.data.uuid == binding.registration_uuid)
        .unwrap();
    let column = registration
        .data
        .schema
        .columns
        .iter_mut()
        .find(|c| c.data_name == "target")
        .unwrap();
    column.default_value = binding.table_uuid.clone();
    registration.data.records[0].remove_cell_value(column);
    let root = &registry(&project).unwrap().unwrap().data;
    for id in [&binding.table_uuid, &binding.registration_uuid] {
        assert!(require_unregistered_table(
            root,
            id,
            &project.tables_data,
            &project.interface_registry
        )
        .is_err());
    }
    assert!(require_unregistered_table(
        root,
        "unregistered",
        &project.tables_data,
        &project.interface_registry
    )
    .is_ok());
}

#[test]
fn optional_scalars_and_required_strings_validate_effective_cells() {
    let mut resources = fixture("org.values");
    let table = &mut resources.tables[0].table;
    let column = &mut table.schema.columns[0];

    column.data_type = ValueType::I32;
    column.default_value.clear();
    column.required = Some(false);
    table.records[0].set_cell_value(column, "".into());
    validate_table(
        "org.values",
        "preferences",
        ResourceKind::Settings,
        ResourceCardinality::Singleton,
        table,
        None,
    )
    .unwrap();
    assert_eq!(
        scalar(&table.schema.columns[0], "", "org.values", "preferences").unwrap(),
        Value::Null
    );
    assert!(scalar(
        &table.schema.columns[0],
        "null",
        "org.values",
        "preferences"
    )
    .is_err());
    table.schema.columns[0].required = Some(true);
    assert!(validate_table(
        "org.values",
        "preferences",
        ResourceKind::Settings,
        ResourceCardinality::Singleton,
        table,
        None
    )
    .is_err());
    table.records[0].set_cell_value(&table.schema.columns[0], "42".into());
    validate_table(
        "org.values",
        "preferences",
        ResourceKind::Settings,
        ResourceCardinality::Singleton,
        table,
        None,
    )
    .unwrap();
    table.schema.columns[0].data_type = ValueType::String;
    assert!(scalar(&table.schema.columns[0], " ", "org.values", "preferences").is_err());
    table.schema.columns[0].required = Some(false);
    assert_eq!(
        scalar(&table.schema.columns[0], "", "org.values", "preferences").unwrap(),
        json!("")
    );
}

#[test]
fn registry_discriminants_reject_free_text_and_tampered_choices() {
    for name in ["kind", "cardinality"] {
        for corruption in 0..3 {
            let mut project = source();
            let id = binding_list(&project)[0].registration_uuid.clone();
            let table = &mut project
                .tables_data
                .values_mut()
                .find(|t| t.data.uuid == id)
                .unwrap()
                .data;
            let column = table
                .schema
                .columns
                .iter_mut()
                .find(|c| c.data_name == name)
                .unwrap();
            match corruption {
                0 => column.data_type = ValueType::String,
                1 => column.select_config.as_mut().unwrap().options[0].value = "arbitrary".into(),
                _ => table.records[0].set_cell_value(column, "arbitrary".into()),
            }
            assert!(registry_bindings(
                &registry(&project).unwrap().unwrap().data,
                &project.tables_data,
                &project.interface_registry
            )
            .is_err());
        }
    }
}

#[test]
fn registry_defaults_have_identical_ownership_in_compile_and_merge() {
    let mut project = source();
    let resources = fixture("org.effective");
    merge_resources(&mut project, &resources).unwrap();
    let id = binding_list(&project)
        .into_iter()
        .find(|b| b.owner == "org.effective")
        .unwrap()
        .registration_uuid;
    let table = &mut project
        .tables_data
        .values_mut()
        .find(|t| t.data.uuid == id)
        .unwrap()
        .data;
    for column in &mut table.schema.columns {
        column.default_value = table.records[0].get_cell_value(column).unwrap().clone();
        table.records[0].remove_cell_value(column);
    }
    let before = serde_json::to_value(&*table).unwrap();
    let catalog = crate::settings_seed::compile_runtime(&project).unwrap();
    assert!(catalog.plugin_settings["org.effective"].contains_key("preferences"));
    merge_resources(&mut project, &resources).unwrap();
    let after = &project
        .tables_data
        .values()
        .find(|t| t.data.uuid == id)
        .unwrap()
        .data;
    assert_eq!(serde_json::to_value(after).unwrap(), before);
    let mut conflicting = resources.clone();
    conflicting.tables[0].table.uuid = uuid::Uuid::new_v4().to_string();
    assert!(merge_resources(&mut project, &conflicting).is_err());
    let after = &project
        .tables_data
        .values()
        .find(|t| t.data.uuid == id)
        .unwrap()
        .data;
    assert_eq!(serde_json::to_value(after).unwrap(), before);
}

#[test]
fn merge_rejects_unloaded_or_missing_registry_without_mutation() {
    let resources = fixture("org.alpha");
    let entry = seed_root().join("studio.devcelproj.toml");
    let mut unloaded = Project::open_project(&entry.to_string_lossy()).unwrap();
    assert!(unloaded.tables_data.is_empty());
    assert!(merge_resources(&mut unloaded, &resources).is_err());
    assert!(unloaded.tables_data.is_empty());

    let mut loaded = source();
    loaded
        .tables_data
        .retain(|_, t| t.data.metadata.data_name != REGISTRY_NAME);
    let before = loaded
        .tables_data
        .iter()
        .map(|(path, table)| (path.clone(), toml::to_string(&table.data).unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert!(merge_resources(&mut loaded, &resources).is_err());
    assert_eq!(
        before,
        loaded
            .tables_data
            .iter()
            .map(|(path, table)| (path.clone(), toml::to_string(&table.data).unwrap()))
            .collect()
    );
}

#[test]
fn independent_plugins_merge_idempotently_and_updates_keep_authored_values() {
    let mut project = source();
    let first = fixture("org.alpha");
    let second = fixture("org.beta");
    merge_resources(&mut project, &first).unwrap();
    merge_resources(&mut project, &second).unwrap();
    let id = &first.tables[0].table.uuid;
    let authored = project
        .tables_data
        .values_mut()
        .find(|t| &t.data.uuid == id)
        .unwrap();
    set(&mut authored.data, 0, "defaultDelimiter", ";");
    let before = project.tables_data.len();
    merge_resources(&mut project, &first).unwrap();
    assert_eq!(before, project.tables_data.len());
    let compiled = crate::settings_seed::compile_runtime(&project).unwrap();
    assert_eq!(
        compiled.plugin_settings["org.alpha"]["preferences"]["defaultDelimiter"],
        ";"
    );
    assert_eq!(
        compiled.plugin_settings["org.beta"]["preferences"]["defaultDelimiter"],
        ","
    );
    let mut bad = first.clone();
    bad.tables[0].table.schema.columns[0].data_type = ValueType::Boolean;
    let snapshot = project
        .tables_data
        .iter()
        .map(|(p, t)| (p.clone(), toml::to_string(&t.data).unwrap()))
        .collect::<BTreeMap<_, _>>();
    let contracts_before = project
        .interface_registry
        .get_all_interfaces_with_paths()
        .into_iter()
        .map(|(path, contract)| (path.clone(), toml::to_string(contract).unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert!(merge_resources(&mut project, &bad).is_err());
    let contracts_after = project
        .interface_registry
        .get_all_interfaces_with_paths()
        .into_iter()
        .map(|(path, contract)| (path.clone(), toml::to_string(contract).unwrap()))
        .collect::<BTreeMap<_, _>>();
    assert_eq!(contracts_before, contracts_after);
    assert_eq!(
        snapshot,
        project
            .tables_data
            .iter()
            .map(|(p, t)| (p.clone(), toml::to_string(&t.data).unwrap()))
            .collect()
    );
}
#[test]
fn rejects_traversal_undeclared_missing_paths_identity_and_owner_collisions() {
    let resource = fixture("fixture");
    let text = toml::to_string(&resource.tables[0].table)
        .unwrap()
        .into_bytes();
    let files = [
        ("settings.table.toml".into(), text),
        (
            "settings.interface.toml".into(),
            toml::to_string(&resource.tables[0].contract)
                .unwrap()
                .into_bytes(),
        ),
    ]
    .into_iter()
    .collect();
    let mut manifest = ResourceManifest {
        settings_tables: vec![ResourceDeclaration {
            id: "preferences".into(),
            path: "settings.table.toml".into(),
            contract: "settings.interface.toml".into(),
            cardinality: ResourceCardinality::Singleton,
        }],
        translation_tables: vec![],
    };
    validate_resources("fixture", &manifest, &files).unwrap();
    for path in [
        "../settings.table.toml",
        "/settings.table.toml",
        "nested/../settings.table.toml",
        "missing.table.toml",
        "C:\\settings.table.toml",
    ] {
        manifest.settings_tables[0].path = path.into();
        assert!(validate_resources("fixture", &manifest, &files).is_err());
    }
    manifest.settings_tables[0].path = "settings.table.toml".into();
    assert!(validate_resources("another-owner", &manifest, &files).is_err());
    manifest
        .settings_tables
        .push(manifest.settings_tables[0].clone());
    assert!(validate_resources("fixture", &manifest, &files).is_err());
    let mut project = source();
    let mut collision = resource;
    collision.tables[0].table.schema.columns[0].uuid = project
        .tables_data
        .values()
        .find(|t| t.data.metadata.data_name == "UserSettings")
        .unwrap()
        .data
        .schema
        .columns[0]
        .uuid
        .clone();
    assert!(merge_resources(&mut project, &collision).is_err());
}
#[test]
fn translation_keys_are_owned_and_collision_or_missing_fallback_rejects_whole_bundle() {
    let mut project = source();
    let registry = project
        .tables_data
        .values_mut()
        .find(|t| t.data.metadata.data_name == REGISTRY_NAME)
        .unwrap();
    let mut duplicate = registry.data.records[1].clone();
    duplicate.uuid = uuid::Uuid::new_v4().to_string();
    registry.data.records.push(duplicate);
    assert!(crate::settings_seed::compile_runtime(&project).is_err());
    let mut table: TableData = toml::from_str(
        &std::fs::read_to_string(
            seed_root().join("Tables/Plugins/csv-exporter/translations.table.toml"),
        )
        .unwrap(),
    )
    .unwrap();
    let original = table.records[0].clone();
    table.records.push(original);
    assert!(validate_table(
        "csv-exporter",
        "translations",
        ResourceKind::Translations,
        ResourceCardinality::Rows,
        &table,
        None
    )
    .is_err());
    let locale = table
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "locale")
        .unwrap();
    table
        .records
        .retain(|r| r.get_cell_value(locale).unwrap() != "en");
    assert!(validate_table(
        "csv-exporter",
        "translations",
        ResourceKind::Translations,
        ResourceCardinality::Rows,
        &table,
        None
    )
    .is_err());
}
#[test]
fn declared_multirow_tables_preserve_edits_deletions_and_new_defaults() {
    let mut project = source();
    let mut resources = fixture("lists");
    resources.tables[0].cardinality = ResourceCardinality::Rows;
    let mut second = resources.tables[0].table.records[0].clone();
    second.uuid = uuid::Uuid::new_v4().to_string();
    resources.tables[0].table.records.push(second);
    merge_resources(&mut project, &resources).unwrap();
    let before = resources.tables.clone();
    let stored = project
        .tables_data
        .values_mut()
        .find(|table| table.data.uuid == resources.tables[0].table.uuid)
        .unwrap();
    stored.data.records.remove(0);
    set(&mut stored.data, 0, "defaultDelimiter", ";");
    let mut added = resources.tables[0].table.records[0].clone();
    added.uuid = uuid::Uuid::new_v4().to_string();
    resources.tables[0].table.records.push(added);
    resources.previous_tables = before;
    merge_resources(&mut project, &resources).unwrap();
    let compiled = crate::settings_seed::compile_runtime(&project).unwrap();
    let rows = compiled.plugin_settings["lists"]["preferences"]
        .as_array()
        .unwrap();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["values"]["defaultDelimiter"], ";");
    assert_ne!(rows[0]["id"], resources.tables[0].table.records[0].uuid);
}
#[test]
fn referenced_contract_deletion_preserves_files_in_loaded_and_lazy_projects() {
    let temp = tempfile::tempdir().unwrap();
    let entry = crate::settings_seed::seed_project(temp.path()).unwrap();
    let loaded = devcel_core::localization::load(&entry).unwrap();
    let binding = binding_list(&loaded).remove(0);
    let relative = std::path::PathBuf::from(
        loaded
            .interface_registry
            .get_interface_path(&binding.contract_uuid)
            .unwrap(),
    );
    let full = entry.parent().unwrap().join("Tables").join(&relative);
    let original = std::fs::read(&full).unwrap();
    for lazy in [false, true] {
        let mut project = if lazy {
            Project::open_project(&entry.to_string_lossy()).unwrap()
        } else {
            devcel_core::localization::load(&entry).unwrap()
        };
        assert!(project.remove_interface(&binding.contract_uuid).is_err());
        assert_eq!(std::fs::read(&full).unwrap(), original);
        assert!(project.delete_interface(relative.clone()).is_err());
        assert_eq!(std::fs::read(&full).unwrap(), original);
        assert!(project
            .delete_directory(relative.parent().unwrap().to_path_buf())
            .is_err());
        assert_eq!(std::fs::read(&full).unwrap(), original);
    }
}
#[test]
fn same_package_can_share_a_meaningful_contract_without_duplicate_fields() {
    let mut project = source();
    let mut resources = fixture("org.shared");
    let mut extra = resources.tables[0].clone();
    extra.id = "secondary".into();
    extra.table.metadata.data_name = table_name("org.shared", &extra.id);
    extra.table.uuid = uuid::Uuid::new_v4().to_string();
    extra.table.records[0].uuid = uuid::Uuid::new_v4().to_string();
    resources.tables.push(extra);
    validate_resource_ids(&resources).unwrap();
    merge_resources(&mut project, &resources).unwrap();
    let bindings = binding_list(&project);
    let ours: Vec<_> = bindings
        .iter()
        .filter(|b| b.owner == "org.shared")
        .collect();
    assert_eq!(ours.len(), 2);
    assert_eq!(ours[0].contract_uuid, ours[1].contract_uuid);
    let catalog = crate::settings_seed::compile_runtime(&project).unwrap();
    assert_eq!(
        catalog.plugin_settings["org.shared"]["secondary"]["defaultDelimiter"],
        ","
    );
}

#[test]
fn published_package_example_contains_valid_declared_contracts() {
    let root =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples/plugin-owned-tables");
    let manifest: serde_json::Value =
        serde_json::from_slice(&std::fs::read(root.join("plugin.json")).unwrap()).unwrap();
    let declarations: ResourceManifest =
        serde_json::from_value(manifest["resources"].clone()).unwrap();
    let files = [
        "preferences.table.toml",
        "translations.table.toml",
        "preferences.interface.toml",
        "translations.interface.toml",
    ]
    .into_iter()
    .map(|name| (name.into(), std::fs::read(root.join(name)).unwrap()))
    .collect();
    let resources = validate_resources("report-tools", &declarations, &files).unwrap();
    assert_eq!(resources.tables.len(), 2);
    let mut project = source();
    merge_resources(&mut project, &resources).unwrap();
    assert!(crate::settings_seed::compile_runtime(&project)
        .unwrap()
        .plugin_settings
        .contains_key("report-tools"));
}
