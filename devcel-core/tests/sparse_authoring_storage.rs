use devcel_core::{cell_rules, ColumnSchema, Interface, Project, Record, TableData};
use serde_json::{json, Value};

#[test]
fn record_empty_fields_are_omitted_and_restore_in_toml_and_json() {
    let row = Record::new();
    let value = serde_json::to_value(&row).unwrap();
    for key in [
        "min_version",
        "parent_uuid",
        "label",
        "tags",
        "interface_values",
        "memo_texts",
    ] {
        assert!(value.get(key).is_none(), "{key}");
    }
    assert!(value.get("values").is_some());
    for decoded in [
        serde_json::from_value::<Record>(value).unwrap(),
        toml::from_str::<Record>(&toml::to_string(&row).unwrap()).unwrap(),
    ] {
        assert_eq!(decoded.min_version, 0);
        assert!(
            decoded.parent_uuid.is_empty() && decoded.label.is_empty() && decoded.tags.is_empty()
        );
        assert!(decoded.interface_values.is_empty() && decoded.memo_texts.is_empty());
    }
}
#[test]
fn nonempty_whitespace_nil_and_orphan_interface_values_are_not_discarded() {
    let mut row = Record::new();
    row.min_version = 3;
    row.parent_uuid = uuid::Uuid::nil().to_string();
    row.label = " ".into();
    row.tags = vec!["tag".into()];
    row.interface_values
        .insert("not-an-installed-interface".into(), "".into());
    row.memo_texts.insert("column".into(), "memo".into());
    let expected = serde_json::to_value(&row).unwrap();
    for actual in [
        serde_json::from_str::<Record>(&serde_json::to_string(&row).unwrap()).unwrap(),
        toml::from_str::<Record>(&toml::to_string(&row).unwrap()).unwrap(),
    ] {
        assert_eq!(serde_json::to_value(actual).unwrap(), expected);
    }
    assert_eq!(expected["parent_uuid"], uuid::Uuid::nil().to_string());
}
#[test]
fn interface_columns_share_sparse_defaults_and_preserve_authored_values() {
    let mut interface = Interface::new("Sparse".into(), None);
    let mut column = ColumnSchema {
        data_name: "value".into(),
        ..Default::default()
    };
    interface.columns.push(column.clone());
    let empty = serde_json::to_value(&interface).unwrap();
    for key in [
        "min_version",
        "display_name",
        "tooltip",
        "memo_text",
        "tags",
    ] {
        assert!(empty["columns"][0].get(key).is_none(), "{key}");
    }
    for decoded in [
        serde_json::from_value::<Interface>(empty).unwrap(),
        toml::from_str::<Interface>(&toml::to_string(&interface).unwrap()).unwrap(),
    ] {
        assert_eq!(decoded.columns[0].min_version, 0);
        assert_eq!(decoded.columns[0].display_name, "");
        assert!(decoded.columns[0].tags.is_empty());
    }
    column.min_version = 2;
    column.display_name = "value".into();
    column.tooltip = " ".into();
    column.memo_text = "note".into();
    column.tags = vec!["tag".into()];
    let wire = serde_json::to_value(&column).unwrap();
    assert_eq!(wire["display_name"], "value");
    assert_eq!(wire["tooltip"], " ");
    assert_eq!(
        serde_json::to_value(
            toml::from_str::<ColumnSchema>(&toml::to_string(&column).unwrap()).unwrap()
        )
        .unwrap(),
        wire
    );
}
#[test]
fn missing_and_explicit_defaults_have_equal_revision_and_root_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut project =
        Project::create_project("Sparse", dir.path().to_str().unwrap(), "", "#123456").unwrap();
    let path = project.create_table("Values.table.toml".into()).unwrap();
    let table = &mut project.tables_data.get_mut(&path).unwrap().data;
    table.schema.columns.push(ColumnSchema {
        data_name: "value".into(),
        ..Default::default()
    });
    table.records.push(Record::new());
    let sparse = serde_json::to_value(&*table).unwrap();
    assert!(sparse["metadata"].get("parent_uuid").is_none());
    let mut explicit = sparse.clone();
    explicit["metadata"]["parent_uuid"] = json!("");
    for (key, value) in [
        ("min_version", json!(0)),
        ("parent_uuid", json!("")),
        ("label", json!("")),
        ("tags", json!([])),
        ("interface_values", json!({})),
        ("memo_texts", json!({})),
    ] {
        explicit["records"][0][key] = value;
    }
    for (key, value) in [
        ("min_version", json!(0)),
        ("display_name", json!("")),
        ("tooltip", json!("")),
        ("memo_text", json!("")),
        ("tags", json!([])),
    ] {
        explicit["schema"]["columns"][0][key] = value;
    }
    let a = TableData::from_json_value(sparse).unwrap();
    let b = TableData::from_json_value(explicit).unwrap();
    assert_eq!(cell_rules::revision(&a), cell_rules::revision(&b));
    project.tables_data.get_mut(&path).unwrap().is_dirty = true;
    project.save_project().unwrap();
    let source = std::fs::read_to_string(&path).unwrap();
    let stored: toml::Value = toml::from_str(&source).unwrap();
    assert!(stored["metadata"].get("parent_uuid").is_none());
    assert!(stored["records"][0].get("parent_uuid").is_none());
    assert!(!source.contains("\n\n\n"));
    assert!(source.starts_with("uuid = "));
    assert!(source.find("\ndisplay_name = ").unwrap() < source.find("\ndescription = ").unwrap());
    let saved: Value = serde_json::to_value(TableData::from_toml(&source).unwrap()).unwrap();
    assert_eq!(saved, serde_json::to_value(a).unwrap());
}
