use devcel_core::*;
use std::path::PathBuf;
use tempfile::TempDir;
use uuid::Uuid;

// Helper to get interface UUID by name
fn get_interface_uuid(project: &Project, name: &str) -> Uuid {
    project
        .list_interfaces()
        .iter()
        .find(|i| i.name == name)
        .map(|i| i.uuid)
        .unwrap_or_else(|| panic!("Interface {} not found", name))
}

#[test]
fn test_interface_full_workflow() {
    // Create a temporary project
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    // Create an interface
    let mut create_cmd = CreateInterfaceCommand::new(
        "TestInterface".to_string(),
        Some("テスト用インターフェース".to_string()),
    );
    create_cmd.execute(&mut project).unwrap();

    // Verify that the interface was created
    let interface_uuid = get_interface_uuid(&project, "TestInterface");
    assert!(project.get_interface(&interface_uuid).is_some());

    // Add a column to the interface
    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "id".to_string(),
                    display_name: "ID".to_string(),
                    data_type: ValueType::String,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "".to_string(),
                    style: Default::default(),
                    memo_text: "一意識別子".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "name".to_string(),
                    display_name: "Name".to_string(),
                    data_type: ValueType::String,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "名無し".to_string(),
                    style: Default::default(),
                    memo_text: "名前".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Save the interface
    project
        .save_interface(project.get_interface(&interface_uuid).unwrap())
        .unwrap();

    // Create a table
    let table_path = PathBuf::from("TestTable.table.toml");
    let created_path = project.create_table(table_path.clone()).unwrap();

    // Load the table
    project.load_table(&created_path).unwrap();

    // Apply the interface to the table
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Verify that the table implements the interface
    let table = project.tables_data.get(&created_path).unwrap();
    assert!(table
        .data
        .interface_implementations
        .values()
        .any(|impl_info| impl_info.interface_uuid == interface_uuid));

    // Verify that columns were added
    assert!(table.has_column("id"));
    assert!(table.has_column("name"));

    // Check column details
    let id_column = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "id")
        .unwrap();
    assert_eq!(id_column.data_type, ValueType::String);

    let name_column = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "name")
        .unwrap();
    assert_eq!(name_column.default_value, "名無し");
}

#[test]
fn test_interface_version_history() {
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    // Create an interface
    let mut create_cmd = CreateInterfaceCommand::new("VersionTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "VersionTest");

    // Add the initial column
    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "version".to_string(),
                    display_name: "Version".to_string(),
                    data_type: ValueType::I32,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "1".to_string(),
                    style: Default::default(),
                    memo_text: "".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Create a version
    let changes = vec![InterfaceChange::AddColumn {
        column: ColumnSchema {
            read_only: false,
            uuid: Uuid::new_v4().to_string(),
            data_name: "created_at".to_string(),
            display_name: "Created At".to_string(),
            data_type: ValueType::String,
            tooltip: "".to_string(),
            tags: vec![],
            default_value: "".to_string(),
            style: Default::default(),
            memo_text: "作成日時".to_string(),
            reference_config: None,
            table_ref_config: None,
            curve_config: None,
            select_config: None,
            color_swatches: Vec::new(),
            interface_origin: None,
            interface_origin_name_fallback: None,
            required: None,
            constraints: None,
            input_validation: None,
            conditional_formatting: None,
            conditional_formatting_override: None,
            min_version: 0,
        },
    }];

    let mut update_cmd = UpdateInterfaceCommand::new(
        interface_uuid,
        changes,
        Some("テストユーザー".to_string()),
        Some("作成日時カラムを追加".to_string()),
    );
    update_cmd.execute(&mut project).unwrap();

    // Verify that history was recorded
    let interface = project.get_interface(&interface_uuid).unwrap();
    assert!(interface.history.len() >= 2);

    // Verify that columns were added
    assert_eq!(interface.columns.len(), 2);
    assert!(interface
        .columns
        .iter()
        .any(|c| c.data_name == "created_at"));
}

#[test]
fn test_interface_validation() {
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    // Create an interface
    let mut create_cmd = CreateInterfaceCommand::new("ValidationTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "ValidationTest");

    // Add a column
    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "required_field".to_string(),
                    display_name: "Required Field".to_string(),
                    data_type: ValueType::String,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "".to_string(),
                    style: Default::default(),
                    memo_text: "".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "optional_field".to_string(),
                    display_name: "Optional Field".to_string(),
                    data_type: ValueType::I32,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "0".to_string(),
                    style: Default::default(),
                    memo_text: "".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Create a table
    let table_path = PathBuf::from("ValidationTable.table.toml");
    let created_path = project.create_table(table_path).unwrap();
    project.load_table(&created_path).unwrap();

    // Test with an empty table without interfaces

    // Missing interface columns must reject application when automatic additions are disabled.
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, false);
    let error = apply_cmd
        .execute(&mut project)
        .expect_err("Applying an interface with missing columns must fail without auto-add");
    assert_eq!(
        serde_json::to_value(devcel_core::AppError::from(error)).unwrap()["diagnostics"][0]
            ["params"]["name"],
        "required_field"
    );

    let table = project.tables_data.get(&created_path).unwrap();
    assert!(!table.has_column("required_field"));
    assert!(!table
        .data
        .interface_implementations
        .contains_key(&interface_uuid));

    // Applying with auto_add_columns=true should succeed
    let mut apply_cmd_auto = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd_auto.execute(&mut project).unwrap();

    // Verify that required columns were added
    let table = project.tables_data.get(&created_path).unwrap();
    assert!(table.has_column("required_field"));
}

#[test]
fn test_interface_undo_redo() {
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    // Create-interface command
    let mut create_cmd =
        CreateInterfaceCommand::new("UndoTest".to_string(), Some("アンドゥテスト".to_string()));

    // Execute
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "UndoTest");
    assert!(project.get_interface(&interface_uuid).is_some());

    // Undo
    create_cmd.undo(&mut project).unwrap();
    // Verify it's gone. Since we can't get UUID easily if it's gone, check list or try to get by old UUID
    assert!(project.get_interface(&interface_uuid).is_none());
}

#[test]
fn test_interface_inheritance() {
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    // Create a parent interface
    let mut create_parent = CreateInterfaceCommand::new("ParentInterface".to_string(), None);
    create_parent.execute(&mut project).unwrap();
    let parent_uuid = get_interface_uuid(&project, "ParentInterface");

    // Add a column to the parent interface
    let parent = project.get_interface_mut(&parent_uuid).unwrap();
    parent
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "parent_col".to_string(),
                    display_name: "Parent Col".to_string(),
                    data_type: ValueType::String,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "".to_string(),
                    style: Default::default(),
                    memo_text: "".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Create a child interface
    let mut create_child = CreateInterfaceCommand::new("ChildInterface".to_string(), None);
    create_child.execute(&mut project).unwrap();
    let child_uuid = get_interface_uuid(&project, "ChildInterface");

    // Update the child to inherit from the parent
    let changes = vec![InterfaceChange::ModifyExtends {
        new_extends: vec![parent_uuid],
    }];

    let mut update_cmd = UpdateInterfaceCommand::new(
        child_uuid,
        changes,
        Some("Tester".to_string()),
        Some("Inherit from Parent".to_string()),
    );
    update_cmd.execute(&mut project).unwrap();

    // Verify by creating a table and applying the interface
    let table_path = PathBuf::from("InheritanceTable.table.toml");
    let created_path = project.create_table(table_path.clone()).unwrap();
    project.load_table(&created_path).unwrap();

    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), child_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    let table = project.tables_data.get(&created_path).unwrap();

    // Verify that the parent's columns were added
    assert!(table.has_column("parent_col"));

    // Add a local column to the child interface
    let child = project.get_interface_mut(&child_uuid).unwrap();
    child
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    read_only: false,
                    uuid: Uuid::new_v4().to_string(),
                    data_name: "child_col".to_string(),
                    display_name: "Child Col".to_string(),
                    data_type: ValueType::I32,
                    tooltip: "".to_string(),
                    tags: vec![],
                    default_value: "".to_string(),
                    style: Default::default(),
                    memo_text: "".to_string(),
                    reference_config: None,
                    table_ref_config: None,
                    curve_config: None,
                    select_config: None,
                    color_swatches: Vec::new(),
                    interface_origin: None,
                    interface_origin_name_fallback: None,
                    required: None,
                    constraints: None,
                    input_validation: None,
                    conditional_formatting: None,
                    conditional_formatting_override: None,
                    min_version: 0,
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Apply again to synchronize
    // ApplyInterfaceCommand only handles initial application, so use reconcile_table directly for updates
    // Alternatively, remove and then apply again

    let child_interface = project.get_interface(&child_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();

    // Synchronize using reconcile_table
    child_interface.reconcile_table(table, &registry).unwrap();

    let table = project.tables_data.get(&created_path).unwrap();
    assert!(table.has_column("parent_col"));
    assert!(table.has_column("child_col"));
}

#[test]
fn test_interface_merge_branches() {
    use std::collections::HashMap;

    // Build an interface with divergent history
    // (Use absorb_history to simulate concurrent edits in separate instances)
    let mut base = Interface::new("MergeTest".to_string(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "id".to_string(),
                display_name: "ID".to_string(),
                data_type: ValueType::I32,
                ..Default::default()
            },
        }],
        Some("base".to_string()),
        Some("idカラムを追加".to_string()),
    )
    .unwrap();
    let fork_point = base.current_version_id;

    // Our branch: add a name column
    let mut ours = base.clone();
    ours.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "name".to_string(),
                display_name: "Name".to_string(),
                data_type: ValueType::String,
                ..Default::default()
            },
        }],
        Some("ours".to_string()),
        None,
    )
    .unwrap();
    let ours_head = ours.current_version_id;

    // Their branch: add an hp column and change id's default
    let mut theirs = base.clone();
    theirs
        .create_new_version(
            vec![
                InterfaceChange::AddColumn {
                    column: ColumnSchema {
                        data_name: "hp".to_string(),
                        display_name: "HP".to_string(),
                        data_type: ValueType::I32,
                        ..Default::default()
                    },
                },
                InterfaceChange::ChangeDefault {
                    column_name: "id".to_string(),
                    new_default: Some("100".to_string()),
                },
            ],
            Some("theirs".to_string()),
            None,
        )
        .unwrap();
    let theirs_head = theirs.current_version_id;

    // Import their history, producing two heads
    let absorbed = ours.absorb_history(&theirs).unwrap();
    assert!(absorbed >= 1);
    let heads = ours.get_branch_heads();
    assert_eq!(heads.len(), 2, "Divergence should produce two heads");
    assert!(heads.contains(&ours_head) && heads.contains(&theirs_head));

    // Merge without conflicts
    let conflicts = ours
        .preview_merge_conflicts(ours_head, theirs_head)
        .unwrap();
    assert!(
        conflicts.is_empty(),
        "No conflicts should occur: {:?}",
        conflicts
    );

    let merge_id = ours
        .merge_branches(
            ours_head,
            theirs_head,
            &HashMap::new(),
            Some("merger".to_string()),
            None,
        )
        .unwrap();
    assert_eq!(ours.current_version_id, merge_id);
    assert_eq!(ours.get_branch_heads(), vec![merge_id]);

    // Merged state: id (default 100), name, hp
    assert_eq!(ours.columns.len(), 3);
    assert!(ours.columns.iter().any(|c| c.data_name == "name"));
    assert!(ours.columns.iter().any(|c| c.data_name == "hp"));
    let id_col = ours.columns.iter().find(|c| c.data_name == "id").unwrap();
    assert_eq!(id_col.default_value, "100");

    // rebuild_current_columns reconstructs the same state, validating the DAG path
    let mut rebuilt = ours.clone();
    rebuilt.rebuild_current_columns().unwrap();
    assert_eq!(rebuilt.columns.len(), 3);
    assert_eq!(
        rebuilt
            .columns
            .iter()
            .find(|c| c.data_name == "id")
            .unwrap()
            .default_value,
        "100"
    );

    // Fast-forward merge from fork_point to the target
    let mut ff = base.clone();
    ff.absorb_history(&theirs).unwrap();
    let ff_result = ff
        .merge_branches(fork_point, theirs_head, &HashMap::new(), None, None)
        .unwrap();
    assert_eq!(
        ff_result, theirs_head,
        "A fast-forward must not create a new version"
    );
    assert_eq!(ff.current_version_id, theirs_head);
}

#[test]
fn test_interface_merge_conflict_resolution() {
    use std::collections::HashMap;

    // Change the same column's default differently on each branch to cause a conflict
    let mut base = Interface::new("ConflictTest".to_string(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "level".to_string(),
                display_name: "Level".to_string(),
                data_type: ValueType::I32,
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();

    let mut ours = base.clone();
    ours.create_new_version(
        vec![InterfaceChange::ChangeDefault {
            column_name: "level".to_string(),
            new_default: Some("1".to_string()),
        }],
        None,
        None,
    )
    .unwrap();
    let ours_head = ours.current_version_id;

    let mut theirs = base.clone();
    theirs
        .create_new_version(
            vec![InterfaceChange::ChangeDefault {
                column_name: "level".to_string(),
                new_default: Some("99".to_string()),
            }],
            None,
            None,
        )
        .unwrap();
    let theirs_head = theirs.current_version_id;

    ours.absorb_history(&theirs).unwrap();

    // A conflict is detected
    let conflicts = ours
        .preview_merge_conflicts(ours_head, theirs_head)
        .unwrap();
    assert_eq!(conflicts.len(), 1);
    assert_eq!(conflicts[0].column_name, "level");

    // Merge fails without a specified resolution
    let result = ours.merge_branches(ours_head, theirs_head, &HashMap::new(), None, None);
    assert!(
        result.is_err(),
        "Unresolved conflicts should cause an error"
    );

    // Resolve with TakeTheirs and merge
    let mut resolutions = HashMap::new();
    resolutions.insert("level".to_string(), ResolutionType::TakeTheirs);
    let merge_id = ours
        .merge_branches(ours_head, theirs_head, &resolutions, None, None)
        .unwrap();

    let level_col = ours
        .columns
        .iter()
        .find(|c| c.data_name == "level")
        .unwrap();
    assert_eq!(
        level_col.default_value, "99",
        "TakeTheirs should adopt their value"
    );

    // Conflict resolution is recorded in the merge information
    let merge_version = ours.history.get(&merge_id).unwrap();
    let merge_info = merge_version.merge_info.as_ref().unwrap();
    assert_eq!(merge_info.second_parent_id, theirs_head);
    assert_eq!(merge_info.conflict_resolutions.len(), 1);
    assert_eq!(
        merge_info.conflict_resolutions[0].resolution_type,
        ResolutionType::TakeTheirs
    );
}

#[test]
fn test_interface_constraints_validation() {
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テストプロジェクト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("ConstraintTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "ConstraintTest");

    // Add a column with required, unique, and range constraints
    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".to_string(),
                    display_name: "Score".to_string(),
                    data_type: ValueType::I32,
                    required: Some(true),
                    constraints: Some(ColumnConstraints {
                        unique: Some(true),
                        min_value: Some(0.0),
                        max_value: Some(100.0),
                        pattern: None,
                    }),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    // Create a table and apply the interface
    let table_path = PathBuf::from("ConstraintTable.table.toml");
    let created_path = project.create_table(table_path).unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Add records that violate constraints
    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();

    let score_col_uuid = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "score")
        .unwrap()
        .uuid
        .clone();

    // Record 1: out-of-range value (150)
    let mut record1 = Record {
        label: "rec1".to_string(),
        ..Default::default()
    };
    record1
        .interface_values
        .insert(score_col_uuid.clone(), "150".to_string());
    table.data.records.push(record1);

    // Record 2: no value (required violation)
    let record2 = Record {
        label: "rec2".to_string(),
        ..Default::default()
    };
    table.data.records.push(record2);

    // Records 3 and 4: duplicate values (50)
    for label in ["rec3", "rec4"] {
        let mut record = Record {
            label: label.to_string(),
            ..Default::default()
        };
        record
            .interface_values
            .insert(score_col_uuid.clone(), "50".to_string());
        table.data.records.push(record);
    }

    let validation = table.validate_interface(&interface, &registry).unwrap();
    assert!(!validation.is_valid);

    let violation_types: Vec<&str> = validation
        .constraint_violations
        .iter()
        .map(|v| v.constraint_type.as_str())
        .collect();
    assert!(
        violation_types.contains(&"max_value"),
        "Out-of-range values should be detected: {:?}",
        violation_types
    );
    assert!(
        violation_types.contains(&"required"),
        "Required-value violations should be detected: {:?}",
        violation_types
    );
    assert!(
        violation_types.contains(&"unique"),
        "Uniqueness violations should be detected: {:?}",
        violation_types
    );
}

#[test]
fn test_sequential_change_validation() {
    // Sequential validation accepts adding a column and modifying it in the same change list
    let mut interface = Interface::new("SequentialTest".to_string(), None);
    let result = interface.create_new_version(
        vec![
            InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "score".to_string(),
                    display_name: "Score".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            },
            InterfaceChange::ChangeDefault {
                column_name: "score".to_string(),
                new_default: Some("10".to_string()),
            },
            InterfaceChange::RenameColumn {
                old_name: "score".to_string(),
                new_name: "point".to_string(),
            },
        ],
        None,
        None,
    );
    assert!(
        result.is_ok(),
        "Sequential validation should succeed: {:?}",
        result.err()
    );
    let col = interface
        .columns
        .iter()
        .find(|c| c.data_name == "point")
        .unwrap();
    assert_eq!(col.default_value, "10");

    // Changes to nonexistent columns are rejected without modifying state
    let before = interface.columns.len();
    let bad = interface.create_new_version(
        vec![InterfaceChange::RemoveColumn {
            column_name: "missing".to_string(),
        }],
        None,
        None,
    );
    assert!(bad.is_err());
    assert_eq!(interface.columns.len(), before);
}

#[test]
fn test_rename_column_preserves_table_values() {
    // Renaming an interface column preserves record values in implementing tables
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("RenameTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "RenameTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "hp".to_string(),
                    display_name: "hp".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("RenameTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Add a record and values (interface-origin columns use column UUID keys)
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let col_uuid = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "hp")
        .unwrap()
        .uuid
        .clone();
    let mut record = Record {
        label: "slime".to_string(),
        ..Default::default()
    };
    record
        .interface_values
        .insert(col_uuid.clone(), "42".to_string());
    table.data.records.push(record);

    // Rename the column and synchronize
    let mut update_cmd = UpdateInterfaceCommand::new(
        interface_uuid,
        vec![InterfaceChange::RenameColumn {
            old_name: "hp".to_string(),
            new_name: "health".to_string(),
        }],
        None,
        None,
    );
    update_cmd.execute(&mut project).unwrap();

    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let from_version = table
        .data
        .interface_implementations
        .get(&interface_uuid)
        .unwrap()
        .synced_version_id;
    interface
        .apply_to_table(table, from_version, &registry)
        .unwrap();

    // Verify that the name changes while the UUID and values are preserved
    let col = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "health")
        .expect("The renamed column should exist");
    assert_eq!(col.uuid, col_uuid, "The column UUID should be preserved");
    assert_eq!(
        table.data.records[0].interface_values.get(&col_uuid),
        Some(&"42".to_string()),
        "Record values should be preserved"
    );
}

#[test]
fn test_revert_to_version() {
    // Restoring content from a previous point appends a new version instead of rewinding HEAD
    let mut interface = Interface::new("RevertTest".to_string(), None);
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "a".to_string(),
                    display_name: "a".to_string(),
                    data_type: ValueType::String,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let v1 = interface.current_version_id;
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "b".to_string(),
                    display_name: "b".to_string(),
                    data_type: ValueType::String,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    assert_eq!(interface.columns.len(), 2);

    let history_len_before = interface.history.len();
    let revert_id = interface.revert_to_version(v1, None, None).unwrap();

    // A new version is appended, restoring v1 content (column a only)
    assert_eq!(interface.current_version_id, revert_id);
    assert_eq!(interface.history.len(), history_len_before + 1);
    assert_eq!(interface.columns.len(), 1);
    assert_eq!(interface.columns[0].data_name, "a");
    // There is still one head; no branch is created
    assert_eq!(interface.get_branch_heads().len(), 1);
}

#[test]
fn test_field_level_merge_auto_resolves_orthogonal_changes() {
    use std::collections::HashMap;

    // Changes to different fields of the same column on each side both apply without conflicts
    let mut base = Interface::new("FieldMergeTest".to_string(), None);
    base.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "level".to_string(),
                display_name: "level".to_string(),
                data_type: ValueType::I32,
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();

    let mut ours = base.clone();
    ours.create_new_version(
        vec![InterfaceChange::ChangeDefault {
            column_name: "level".to_string(),
            new_default: Some("5".to_string()),
        }],
        None,
        None,
    )
    .unwrap();
    let ours_head = ours.current_version_id;

    let mut theirs = base.clone();
    theirs
        .create_new_version(
            vec![InterfaceChange::ChangeRequired {
                column_name: "level".to_string(),
                required: true,
            }],
            None,
            None,
        )
        .unwrap();
    let theirs_head = theirs.current_version_id;

    ours.absorb_history(&theirs).unwrap();

    // No conflicts because the fields are independent
    let conflicts = ours
        .preview_merge_conflicts(ours_head, theirs_head)
        .unwrap();
    assert!(
        conflicts.is_empty(),
        "Independent fields should merge automatically: {:?}",
        conflicts
    );

    ours.merge_branches(ours_head, theirs_head, &HashMap::new(), None, None)
        .unwrap();
    let col = ours
        .columns
        .iter()
        .find(|c| c.data_name == "level")
        .unwrap();
    assert_eq!(
        col.default_value, "5",
        "Our default-value change should be applied"
    );
    assert_eq!(
        col.required,
        Some(true),
        "Their required-flag change should also be applied"
    );
}

#[test]
fn test_unknown_interface_column_uuid_is_rejected_without_repair() {
    // Synchronization rejects unregistered column UUIDs without repairing or changing the table
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("IdentityContract".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "IdentityContract");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "mp".to_string(),
                    display_name: "mp".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    let stable_uuid = interface
        .columns
        .iter()
        .find(|c| c.data_name == "mp")
        .unwrap()
        .uuid
        .clone();

    let created_path = project
        .create_table(PathBuf::from("IdentityTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Create an invalid column ID by changing the table column's UUID and storing values under that key
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let unknown_uuid = Uuid::new_v4().to_string();
    let col = table
        .data
        .schema
        .columns
        .iter_mut()
        .find(|c| c.data_name == "mp")
        .unwrap();
    col.uuid = unknown_uuid.clone();
    let mut record = Record {
        label: "hero".to_string(),
        ..Default::default()
    };
    record
        .interface_values
        .insert(unknown_uuid.clone(), "99".to_string());
    table.data.records.push(record);

    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let before = serde_json::to_value(&table.data).unwrap();
    assert_eq!(
        serde_json::to_value(devcel_core::AppError::from(
            interface.reconcile_table(table, &registry).unwrap_err()
        ))
        .unwrap()["diagnostics"][0]["code"],
        "error.interface.unknownColumnId"
    );
    assert_eq!(serde_json::to_value(&table.data).unwrap(), before);
    assert_ne!(unknown_uuid, stable_uuid);
}

#[test]
fn test_inheritance_change_detected_by_fingerprint() {
    // Effective fingerprints detect parent-interface changes and propagate them to tables
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_parent = CreateInterfaceCommand::new("FpParent".to_string(), None);
    create_parent.execute(&mut project).unwrap();
    let parent_uuid = get_interface_uuid(&project, "FpParent");

    let mut create_child = CreateInterfaceCommand::new("FpChild".to_string(), None);
    create_child.execute(&mut project).unwrap();
    let child_uuid = get_interface_uuid(&project, "FpChild");

    let mut extend_cmd = UpdateInterfaceCommand::new(
        child_uuid,
        vec![InterfaceChange::ModifyExtends {
            new_extends: vec![parent_uuid],
        }],
        None,
        None,
    );
    extend_cmd.execute(&mut project).unwrap();

    let created_path = project
        .create_table(PathBuf::from("FpTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), child_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // No synchronization needed immediately after application
    {
        let registry = project.interface_registry.clone();
        let child = project.get_interface(&child_uuid).unwrap();
        let table = project.tables_data.get(&created_path).unwrap();
        let impl_info = table
            .data
            .interface_implementations
            .get(&child_uuid)
            .unwrap();
        assert!(
            !child.table_needs_sync(impl_info, &registry),
            "No synchronization should be needed immediately after application"
        );
    }

    // Add a parent column: the child's version stays unchanged, but its fingerprint changes
    let mut parent_update = UpdateInterfaceCommand::new(
        parent_uuid,
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "inherited_col".to_string(),
                display_name: "inherited_col".to_string(),
                data_type: ValueType::String,
                ..Default::default()
            },
        }],
        None,
        None,
    );
    parent_update.execute(&mut project).unwrap();

    let registry = project.interface_registry.clone();
    let child = project.get_interface(&child_uuid).unwrap().clone();
    {
        let table = project.tables_data.get(&created_path).unwrap();
        let impl_info = table
            .data
            .interface_implementations
            .get(&child_uuid)
            .unwrap();
        assert!(
            child.table_needs_sync(impl_info, &registry),
            "The fingerprint should detect parent changes"
        );
    }

    // Synchronization adds the inherited column and updates the fingerprint
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let from_version = table
        .data
        .interface_implementations
        .get(&child_uuid)
        .unwrap()
        .synced_version_id;
    child
        .apply_to_table(table, from_version, &registry)
        .unwrap();

    assert!(
        table.has_column("inherited_col"),
        "The inherited column should be added"
    );
    let impl_info = table
        .data
        .interface_implementations
        .get(&child_uuid)
        .unwrap();
    assert!(
        !child.table_needs_sync(impl_info, &registry),
        "The table should be up to date after synchronization"
    );
}

#[test]
fn test_type_change_propagates_to_table() {
    // Interface type changes actually update columns in implementing tables
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("TypeSyncTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "TypeSyncTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "num".to_string(),
                    display_name: "num".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("TypeSyncTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Change the type from I32 to F64
    let mut update_cmd = UpdateInterfaceCommand::new(
        interface_uuid,
        vec![InterfaceChange::ModifyColumn {
            column_name: "num".to_string(),
            old_type: ValueType::I32,
            new_type: ValueType::F64,
        }],
        None,
        None,
    );
    update_cmd.execute(&mut project).unwrap();

    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let from_version = table
        .data
        .interface_implementations
        .get(&interface_uuid)
        .unwrap()
        .synced_version_id;
    let result = interface
        .apply_to_table(table, from_version, &registry)
        .unwrap();

    assert!(
        !result.type_changes.is_empty(),
        "The type change should be recorded"
    );
    let col = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "num")
        .unwrap();
    assert_eq!(
        col.data_type,
        ValueType::F64,
        "The table column's type should actually change"
    );

    // Validation reports no type mismatch
    let validation = table.validate_interface(&interface, &registry).unwrap();
    assert!(
        validation.type_mismatches.is_empty(),
        "The type mismatch should be resolved after synchronization"
    );
}

#[test]
fn test_reconcile_syncs_field_drift() {
    // Reconciliation fixes field differences (type/default), as well as additions and removals
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("DriftTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "DriftTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "speed".to_string(),
                    display_name: "speed".to_string(),
                    data_type: ValueType::I32,
                    default_value: "10".to_string(),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("DriftTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Deliberately alter the table to simulate past inconsistency
    {
        let table = project.tables_data.get_mut(&created_path).unwrap();
        let col = table
            .data
            .schema
            .columns
            .iter_mut()
            .find(|c| c.data_name == "speed")
            .unwrap();
        col.data_type = ValueType::String;
        col.default_value = "drifted".to_string();
    }

    // Reconciliation restores full consistency
    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    interface.reconcile_table(table, &registry).unwrap();

    let col = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "speed")
        .unwrap();
    assert_eq!(
        col.data_type,
        ValueType::I32,
        "The type difference should be resolved"
    );
    assert_eq!(
        col.default_value, "10",
        "The default-value difference should be resolved"
    );
}

#[test]
fn test_remove_interface_deletes_values_no_resurrection() {
    // Detaching an interface deletes its values; reapplying it does not restore them
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("RemoveTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "RemoveTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "gold".to_string(),
                    display_name: "gold".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("RemoveTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Enter values
    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let col_uuid = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "gold")
        .unwrap()
        .uuid
        .clone();
    let mut record = Record::default();
    record
        .interface_values
        .insert(col_uuid.clone(), "500".to_string());
    table.data.records.push(record);

    // Detach the interface, deleting its values
    interface.remove_from_table(table).unwrap();
    assert!(!table.has_column("gold"));
    assert!(
        !table.data.records[0]
            .interface_values
            .contains_key(&col_uuid),
        "Values for detached columns should be deleted"
    );

    // Reapplying does not resurrect deleted values, even with stable UUIDs
    let registry = project.interface_registry.clone();
    table.apply_interface(&interface, &registry, true).unwrap();
    assert!(table.has_column("gold"));
    assert!(
        !table.data.records[0]
            .interface_values
            .contains_key(&col_uuid),
        "Reapplication must not restore old values"
    );
}

#[test]
fn test_formula_routing_for_interface_columns() {
    // Formula storage and reference resolution work for interface-origin columns
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("FormulaIfTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "FormulaIfTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "base".to_string(),
                    display_name: "base".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "total".to_string(),
                    display_name: "total".to_string(),
                    data_type: ValueType::I32,
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("FormulaIfTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    // Add a record and static values in interface-origin columns
    let table = project.tables_data.get_mut(&created_path).unwrap();
    let base_uuid = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "base")
        .unwrap()
        .uuid
        .clone();
    let total_uuid = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "total")
        .unwrap()
        .uuid
        .clone();
    let mut record = Record {
        label: "rec".to_string(),
        ..Default::default()
    };
    record
        .interface_values
        .insert(base_uuid.clone(), "21".to_string());
    let record_uuid = record.uuid.clone();
    table.data.records.push(record);

    // set_record_value_with_formula writes interface-origin columns
    // to the correct map (interface_values, keyed by column UUID)
    table
        .data
        .set_record_value_with_formula(&record_uuid, "total", "=base * 2")
        .unwrap();
    assert_eq!(
        table.data.records[0].interface_values.get(&total_uuid),
        Some(&"=base * 2".to_string()),
        "Formulas should be saved in interface_values, keyed by column UUID"
    );
    assert!(
        !table.data.records[0].values.contains_key("total"),
        "Nothing should be written to name-keyed values"
    );

    // get_record_value can read interface-origin columns
    assert_eq!(
        table.data.get_record_value(&record_uuid, "base"),
        Some("21".to_string())
    );

    // The formula engine resolves references to interface-origin columns
    let mut engine = devcel_core::formula_engine::FormulaEngine::new();
    let record_ref = &table.data.records[0];
    match engine.evaluate("=base * 2", "total", record_ref, &table.data.schema) {
        devcel_core::types::FormulaResult::Value(v) => assert_eq!(v, "42"),
        devcel_core::types::FormulaResult::Error(e) => {
            panic!("Formula evaluation failed: {:?}", e)
        }
    }

    // Formula cells are excluded from constraint validation to avoid false positives
    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::ChangeConstraints {
                column_name: "total".to_string(),
                new_constraints: Some(devcel_core::ColumnConstraints {
                    min_value: Some(0.0),
                    max_value: Some(10.0), // The result 42 is out of range, but the formula string is excluded from validation
                    ..Default::default()
                }),
            }],
            None,
            None,
        )
        .unwrap();
    let interface = project.get_interface(&interface_uuid).unwrap().clone();
    let registry = project.interface_registry.clone();
    let table = project.tables_data.get_mut(&created_path).unwrap();
    interface.reconcile_table(table, &registry).unwrap();
    let validation = table.validate_interface(&interface, &registry).unwrap();
    assert!(
        validation
            .constraint_violations
            .iter()
            .all(|v| v.column_name != "total"),
        "Formula cells should not be reported as constraint violations: {:?}",
        validation.constraint_violations
    );
}

#[test]
fn test_record_canonical_cell_methods() {
    // Canonical Record methods correctly route ordinary and interface-origin columns
    let mut normal = ColumnSchema {
        data_name: "hp".to_string(),
        ..Default::default()
    };
    normal.interface_origin = None;

    let iface = ColumnSchema {
        data_name: "mp".to_string(),
        interface_origin: Some("iface-uuid".to_string()),
        ..Default::default()
    };

    let mut record = Record::default();

    // Ordinary columns -> values (column-name keys)
    record.set_cell_value(&normal, "100".to_string());
    assert_eq!(record.values.get("hp"), Some(&"100".to_string()));
    assert!(record.interface_values.is_empty());
    assert_eq!(record.get_cell_value(&normal), Some(&"100".to_string()));

    // Interface-origin columns -> interface_values (column-UUID keys)
    record.set_cell_value(&iface, "50".to_string());
    assert_eq!(
        record.interface_values.get(&iface.uuid),
        Some(&"50".to_string())
    );
    assert!(!record.values.contains_key("mp"));
    assert_eq!(record.get_cell_value(&iface), Some(&"50".to_string()));

    // Deletion also affects the correct map
    record.remove_cell_value(&iface);
    assert!(record.get_cell_value(&iface).is_none());
    record.remove_cell_value(&normal);
    assert!(record.get_cell_value(&normal).is_none());

    // A name-keyed value never aliases an interface column.
    let mut name_keyed = Record::default();
    name_keyed
        .values
        .insert("mp".to_string(), "unbound".to_string());
    assert_eq!(name_keyed.get_cell_value(&iface), None);
}

#[test]
fn test_reference_config_flows_through_interface() {
    // Reference columns defined in interfaces preserve their reference_config
    // after being applied to a table
    let temp_dir = TempDir::new().unwrap();
    let mut project = Project::create_project(
        "TestProject",
        temp_dir.path().to_str().unwrap(),
        "テスト",
        "#000000",
    )
    .unwrap();

    let mut create_cmd = CreateInterfaceCommand::new("RefIfTest".to_string(), None);
    create_cmd.execute(&mut project).unwrap();
    let interface_uuid = get_interface_uuid(&project, "RefIfTest");

    let interface = project.get_interface_mut(&interface_uuid).unwrap();
    interface
        .create_new_version(
            vec![InterfaceChange::AddColumn {
                column: ColumnSchema {
                    data_name: "owner".to_string(),
                    display_name: "owner".to_string(),
                    data_type: ValueType::Reference,
                    reference_config: Some(devcel_core::ReferenceConfig {
                        target_table_uuid: "target-table-uuid".to_string(),
                        display_column_uuid: None,
                    }),
                    ..Default::default()
                },
            }],
            None,
            None,
        )
        .unwrap();

    let created_path = project
        .create_table(PathBuf::from("RefIfTable.table.toml"))
        .unwrap();
    project.load_table(&created_path).unwrap();
    let mut apply_cmd = ApplyInterfaceCommand::new(created_path.clone(), interface_uuid, true);
    apply_cmd.execute(&mut project).unwrap();

    let table = project.tables_data.get(&created_path).unwrap();
    let col = table
        .data
        .schema
        .columns
        .iter()
        .find(|c| c.data_name == "owner")
        .expect("The reference column should be applied");
    assert_eq!(col.data_type, ValueType::Reference);
    let config = col
        .reference_config
        .as_ref()
        .expect("reference_config should be preserved");
    assert_eq!(config.target_table_uuid, "target-table-uuid");
}

#[test]
fn implementation_serialization_preserves_sync_identity_and_fingerprint() {
    let interface_uuid = uuid::Uuid::from_u128(1);
    let synced_version_id = uuid::Uuid::from_u128(2);
    let implementation = devcel_core::InterfaceImplementation {
        interface_uuid,
        synced_version_id,
        last_sync_date: chrono::DateTime::UNIX_EPOCH,
        effective_fingerprint: Some("effective-version".into()),
        required_column_uuids: None,
    };
    let expected = serde_json::json!({
        "interface_uuid": interface_uuid,
        "synced_version_id": synced_version_id,
        "last_sync_date": "1970-01-01T00:00:00Z",
        "effective_fingerprint": "effective-version"
    });
    assert_eq!(serde_json::to_value(&implementation).unwrap(), expected);
    let serialized = toml::to_string(&implementation).unwrap();
    let round_trip: devcel_core::InterfaceImplementation = toml::from_str(&serialized).unwrap();
    assert_eq!(serde_json::to_value(round_trip).unwrap(), expected);
}
