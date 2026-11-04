use devcel_core::{
    cell_rules,
    table_mutation::{self, TableMutation},
    *,
};
use serde_json::json;

fn fixture() -> (tempfile::TempDir, Project, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Versions", dir.path().to_str().unwrap(), "", "#ffffff").unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    project.load_table(&path).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns.push(ColumnSchema {
        data_name: "amount".into(),
        display_name: "Amount".into(),
        ..Default::default()
    });
    table.data.records.push(Record::new());
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    (dir, project, path)
}
fn request(data: &TableData, value: &str) -> TableMutation {
    serde_json::from_value(json!({"table_uuid":data.uuid,"expected_revision":cell_rules::revision(data),"column_versions":[{"column_uuid":data.schema.columns[0].uuid,"min_version":value}]})).unwrap()
}
#[test]
fn column_version_roundtrip_revision_atomic_validation_undo_redo_reopen() {
    let (_dir, mut project, path) = fixture();
    let original = project.tables_data[&path].data.clone();
    let stale = request(&original, "1");
    let update = request(&original, "2");
    let result = table_mutation::apply(&mut project, update, None).unwrap();
    assert_eq!(result.table.schema.columns[0].min_version, 2);
    assert_ne!(
        cell_rules::revision(&original),
        cell_rules::revision(&result.table)
    );
    assert!(table_mutation::apply(&mut project, stale, None).is_err());
    for value in ["-1", "1.5", "1e2", "4294967296", "", " 2", "00000000000"] {
        let snapshot = project.tables_data[&path].data.clone();
        let disk = std::fs::read(&path).unwrap();
        let history = project.tables_data[&path].undo_history.len();
        assert!(
            table_mutation::apply(&mut project, request(&snapshot, value), None).is_err(),
            "{value}"
        );
        assert_eq!(
            cell_rules::revision(&snapshot),
            cell_rules::revision(&project.tables_data[&path].data)
        );
        assert_eq!(disk, std::fs::read(&path).unwrap());
        assert_eq!(history, project.tables_data[&path].undo_history.len());
    }
    let id = original.uuid;
    project.undo_command(&id).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].min_version,
        0
    );
    project.redo_command(&id).unwrap();
    assert_eq!(
        project.tables_data[&path].data.schema.columns[0].min_version,
        2
    );
    let mut reopened = Project::open_project(project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&path).unwrap();
    assert_eq!(
        reopened.tables_data[&path].data.schema.columns[0].min_version,
        2
    );
}
#[test]
fn omitted_column_version_defaults_to_zero_and_inherited_column_cannot_be_overridden() {
    let (_dir, mut project, path) = fixture();
    let data = project.tables_data[&path].data.clone();
    let missing_version = toml::to_string(&data).unwrap();
    assert!(!missing_version.contains("min_version = 0"));
    let restored = toml::from_str::<TableData>(&missing_version).unwrap();
    assert_eq!(restored.schema.columns[0].min_version, 0);
    assert_eq!(cell_rules::revision(&data), cell_rules::revision(&restored));
    let column = &mut project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .schema
        .columns[0];
    column.interface_origin = Some(uuid::Uuid::new_v4().to_string());
    let before = project.tables_data[&path].data.clone();
    assert!(table_mutation::apply(&mut project, request(&before, "3"), None).is_err());
    assert_eq!(
        cell_rules::revision(&before),
        cell_rules::revision(&project.tables_data[&path].data)
    );
}
#[test]
fn interface_version_inherits_reconciles_reverts_and_merges_as_a_field() {
    let mut base = Interface::new("Base".into(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "amount".into(),
                min_version: 1,
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();
    let old = base.current_version_id;
    let mut ours = base.clone();
    let mut theirs = base.clone();
    ours.create_new_version(
        vec![InterfaceChange::ChangeMinVersion {
            column_name: "amount".into(),
            min_version: 2,
        }],
        None,
        None,
    )
    .unwrap();
    theirs
        .create_new_version(
            vec![InterfaceChange::ChangeMinVersion {
                column_name: "amount".into(),
                min_version: 3,
            }],
            None,
            None,
        )
        .unwrap();
    let our_id = ours.current_version_id;
    let their_id = theirs.current_version_id;
    ours.absorb_history(&theirs).unwrap();
    let conflicts = ours.preview_merge_conflicts(our_id, their_id).unwrap();
    assert!(conflicts
        .iter()
        .any(|c| c.field_conflicts.iter().any(|f| f.field == "min_version")));
    let mut resolutions = std::collections::HashMap::new();
    resolutions.insert("amount".to_string(), ResolutionType::TakeTheirs);
    ours.merge_branches(our_id, their_id, &resolutions, None, None)
        .unwrap();
    assert_eq!(ours.columns[0].min_version, 3);
    ours.rebuild_current_columns().unwrap();
    assert_eq!(ours.columns[0].min_version, 3);
    let changes = ours.preview_revert(old).unwrap();
    assert!(changes
        .iter()
        .any(|c| matches!(c, InterfaceChange::ChangeMinVersion { min_version: 1, .. })));
    ours.create_new_version(changes, None, None).unwrap();
    assert_eq!(ours.columns[0].min_version, 1);
    let mut registry = InterfaceRegistry::new();
    registry.add_interface(ours.clone()).unwrap();
    let mut child = Interface::new("Child".into(), None);
    child.extends.push(ours.uuid);
    let effective = child.get_effective_columns(&registry).unwrap();
    assert_eq!(effective[0].min_version, 1);
}

#[test]
fn interface_change_synchronizes_and_reconcile_removes_local_version_drift() {
    let (_dir, mut project, path) = fixture();
    let mut create = CreateInterfaceCommand::new("Versioned".into(), None);
    create.execute(&mut project).unwrap();
    let id = project
        .list_interfaces()
        .iter()
        .find(|i| i.name == "Versioned")
        .unwrap()
        .uuid;
    let mut add = UpdateInterfaceCommand::new(
        id,
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "inherited".into(),
                min_version: 1,
                ..Default::default()
            },
        }],
        None,
        None,
    );
    add.execute(&mut project).unwrap();
    ApplyInterfaceCommand::new(path.clone(), id, true)
        .execute(&mut project)
        .unwrap();
    let definition = project.get_interface(&id).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&path).unwrap();
    definition.reconcile_table(table, &registry).unwrap();
    let col = table
        .data
        .schema
        .columns
        .iter_mut()
        .find(|c| c.data_name == "inherited")
        .unwrap();
    assert_eq!(col.min_version, 1);
    col.min_version = 999;
    definition.reconcile_table(table, &registry).unwrap();
    assert_eq!(
        table
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == "inherited")
            .unwrap()
            .min_version,
        1
    );
    let mut change = UpdateInterfaceCommand::new(
        id,
        vec![InterfaceChange::ChangeMinVersion {
            column_name: "inherited".into(),
            min_version: 3,
        }],
        None,
        None,
    );
    change.execute(&mut project).unwrap();
    let definition = project.get_interface(&id).unwrap().clone();
    let registry = project.interface_registry.clone();
    definition
        .reconcile_table(project.tables_data.get_mut(&path).unwrap(), &registry)
        .unwrap();
    assert_eq!(
        project.tables_data[&path]
            .data
            .schema
            .columns
            .iter()
            .find(|c| c.data_name == "inherited")
            .unwrap()
            .min_version,
        3
    );
    change.undo(&mut project).unwrap();
    assert_eq!(
        project.get_interface(&id).unwrap().columns[0].min_version,
        1
    );
}
