//! Compile-fixture regressions for portable names and arbitrary string payloads.
use devcel_core::{
    codegen::{self, CodegenTarget},
    ColumnSchema, Project, ValueType,
};
use std::path::PathBuf;

fn project(columns: &[&str]) -> (tempfile::TempDir, Project) {
    let dir = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "IdentifierSafety",
        dir.path().to_str().unwrap(),
        "",
        "#123456",
    )
    .unwrap();
    let path = project.create_table("Names.table.toml".into()).unwrap();
    let table = project.tables_data.get_mut(&path).unwrap();
    table.data.schema.columns = columns
        .iter()
        .map(|name| ColumnSchema {
            data_name: (*name).into(),
            display_name: (*name).into(),
            data_type: ValueType::String,
            ..Default::default()
        })
        .collect();
    std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    table.is_dirty = false;
    (dir, project)
}

#[test]
fn emit_keyword_and_string_safety_compile_fixtures() {
    let (_dir, mut project) = project(&[
        "while",
        "for",
        "enum",
        "alignas",
        "concept",
        "requires",
        "class",
        "class_",
        "fooBar",
        "foo_bar",
        "t_",
        "row_",
        "generation_",
    ]);
    for (target, extension) in [
        (CodegenTarget::Cpp, "h"),
        (CodegenTarget::CSharp, "cs"),
        (CodegenTarget::TypeScript, "ts"),
    ] {
        let code = codegen::generate_code(&mut project, target, Some("IdentifierSafety")).unwrap();
        if let Some(directory) = std::env::var_os("DEVCEL_CODEGEN_SAFETY_OUT") {
            let directory = PathBuf::from(directory);
            std::fs::create_dir_all(&directory).unwrap();
            std::fs::write(directory.join(format!("keywords.{extension}")), code).unwrap();
        }
    }
}

fn write_fixture(name: &str, extension: &str, code: &str) {
    if let Some(directory) = std::env::var_os("DEVCEL_CODEGEN_SAFETY_OUT") {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(format!("{name}.{extension}")), code).unwrap();
    }
}

#[test]
fn arbitrary_tags_and_select_strings_survive_language_escaping() {
    use devcel_core::{
        json_export,
        types::{SelectConfig, SelectOption},
    };
    let (_dir, mut project) = project(&["selection"]);
    let values = vec![
        "rpg/enemies",
        "quote\"value",
        "back\\slash",
        "line\nbreak",
        "日本語",
        "emoji😀",
        "line\u{2028}separator",
        "next\u{0085}line",
        "a-b",
        "a_b",
    ];
    let table = project.tables_data.values_mut().next().unwrap();
    let column = &mut table.data.schema.columns[0];
    column.data_type = ValueType::Select;
    column.default_value = values[0].into();
    column.tags = values.iter().map(|v| v.to_string()).collect();
    column.select_config = Some(SelectConfig {
        options: values
            .iter()
            .map(|value| SelectOption {
                value: (*value).into(),
                label: (*value).into(),
            })
            .collect(),
    });
    let metadata = json_export::export_table_metadata_as_json(&table.data).unwrap();
    let parsed: serde_json::Value = serde_json::from_str(&metadata).unwrap();
    assert_eq!(parsed["columns"][0]["tags"], serde_json::json!(values));
    let default_namespace = "StringSafety";
    for (target, extension) in [
        (CodegenTarget::Cpp, "h"),
        (CodegenTarget::CSharp, "cs"),
        (CodegenTarget::TypeScript, "ts"),
    ] {
        let code = codegen::generate_code(&mut project, target, Some(default_namespace)).unwrap();
        assert!(
            code.contains("日本語"),
            "Unicode payload must not be ASCII-restricted"
        );
        assert!(code.contains("rpg/enemies"));
        assert!(
            !code.contains("line\nbreak"),
            "String newlines must be escaped"
        );
        write_fixture("strings", extension, &code);
    }
}

#[test]
fn project_display_name_cannot_escape_generated_comment() {
    let (_dir, mut project) = project(&["ordinary"]);
    project.project_data.project_name =
        "Name\n#error injected\rclass broken\u{0085}NEL\u{2028}LS\u{2029}PS".into();
    for (target, extension) in [
        (CodegenTarget::Cpp, "h"),
        (CodegenTarget::CSharp, "cs"),
        (CodegenTarget::TypeScript, "ts"),
    ] {
        let code = codegen::generate_code(&mut project, target, Some("CommentSafety")).unwrap();
        let comment = code
            .lines()
            .find(|line| line.starts_with("// project:"))
            .unwrap();
        assert!(comment.contains("#error injected"));
        assert!(comment.contains("class broken"));
        assert!(comment.contains("PS"));
        assert!(!comment.contains(['\r', '\u{2028}', '\u{2029}']));
        if target != CodegenTarget::TypeScript {
            assert!(!comment.contains('\u{0085}'));
        }
        assert!(!code.lines().any(|line| line.starts_with("#error")));
        write_fixture("comments", extension, &code);
    }
}

#[test]
fn cpp_rejects_reserved_helper_spelling_without_restricting_other_targets() {
    use devcel_core::types::{SelectConfig, SelectOption};
    let (_dir, mut project) = project(&["class"]);
    let column = &mut project
        .tables_data
        .values_mut()
        .next()
        .unwrap()
        .data
        .schema
        .columns[0];
    column.data_type = ValueType::Select;
    column.default_value = "choice".into();
    column.select_config = Some(SelectConfig {
        options: vec![SelectOption {
            value: "choice".into(),
            label: "Choice".into(),
        }],
    });
    assert!(
        codegen::generate_code(&mut project, CodegenTarget::Cpp, None).is_err(),
        "class__value is reserved to C++ implementations"
    );
    assert!(codegen::generate_code(&mut project, CodegenTarget::CSharp, None).is_ok());
    assert!(codegen::generate_code(&mut project, CodegenTarget::TypeScript, None).is_ok());
}

#[test]
fn cpp_project_comment_cannot_splice_the_next_source_line() {
    let (_dir, mut project) = project(&["ordinary"]);
    for name in ["trailing\\", "trailing\\ ", "trailing\\\n"] {
        project.project_data.project_name = name.into();
        let code =
            codegen::generate_code(&mut project, CodegenTarget::Cpp, Some("SpliceSafety")).unwrap();
        let comment = code
            .lines()
            .find(|line| line.starts_with("// project:"))
            .unwrap();
        assert!(!comment.trim_end().ends_with('\\'));
        assert!(comment.contains("\\u005C"));
        write_fixture("splice", "h", &code);
    }
}

#[test]
fn cpp_final_table_type_and_owner_member_names_are_validated() {
    let (_dir, mut project) = project(&["ordinary"]);
    let path = project.tables_data.keys().next().unwrap().clone();
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .metadata
        .data_name = "_".into();
    assert!(
        codegen::generate_code(&mut project, CodegenTarget::Cpp, None).is_err(),
        "_Table is an implementation-reserved C++ type"
    );
    assert!(codegen::generate_code(&mut project, CodegenTarget::CSharp, None).is_ok());
    assert!(codegen::generate_code(&mut project, CodegenTarget::TypeScript, None).is_ok());
    project
        .tables_data
        .get_mut(&path)
        .unwrap()
        .data
        .metadata
        .data_name = "while".into();
    assert!(
        codegen::generate_code_with_class_name(
            &mut project,
            CodegenTarget::Cpp,
            None,
            Some("while_")
        )
        .is_err(),
        "Escaped table member must not collide with owner constructor name"
    );
}

#[test]
fn csharp_live_key_handle_and_framework_names_are_guarded() {
    let (_dir, mut p) = project(&["value"]);
    for name in [
        "NamesKey",
        "Array",
        "StringComparer",
        "Dictionary",
        "HashSet",
        "IEnumerator",
        "DevcelTableHandle",
    ] {
        assert!(
            codegen::generate_code_with_class_name(
                &mut p,
                CodegenTarget::CSharp,
                Some("SafeNames"),
                Some(name)
            )
            .is_err(),
            "{name}"
        );
    }
    let (_dir, mut p) = project(&["names_handle"]);
    assert!(codegen::generate_code(&mut p, CodegenTarget::CSharp, Some("SafeNames")).is_err());
}

#[test]
fn cpp_interface_concepts_require_the_actual_return_types() {
    use devcel_core::{Interface, InterfaceChange, Record};
    let (_dir, mut p) = project(&["hp"]);
    let mut i = Interface::new("Stats".into(), None);
    i.create_new_version(
        vec![InterfaceChange::AddColumn {
            column: ColumnSchema {
                data_name: "hp".into(),
                display_name: "HP".into(),
                data_type: ValueType::I32,
                default_value: "0".into(),
                ..Default::default()
            },
        }],
        None,
        None,
    )
    .unwrap();
    p.interface_registry
        .add_interface_with_path("Stats.interface.toml".into(), i.clone())
        .unwrap();
    i.save_to_file(&p.path.parent().unwrap().join("Tables/Stats.interface.toml"))
        .unwrap();
    let path = p.create_table("Good.table.toml".into()).unwrap();
    p.load_table(&path).unwrap();
    let table = p.tables_data.get_mut(&path).unwrap();
    table
        .apply_interface(&i, &p.interface_registry, true)
        .unwrap();
    table.data.records.push(Record::new());
    table.is_dirty = true;
    p.save_project().unwrap();
    let code = codegen::generate_code(&mut p, CodegenTarget::Cpp, Some("ConceptSafety")).unwrap();
    assert!(code.contains("requires std::is_same_v<decltype(t.hp()), int32_t>"));
    write_fixture("interface_types", "h", &code);
}
