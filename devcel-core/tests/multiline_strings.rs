//! Multiline String integration checks from saved files through game export/runtime consumption.
//! cargo test -p devcel-core --test multiline_strings
//! Set DEVCEL_MULTILINE_FIXTURE_OUT to retain actual exports for Godot/C#.
use devcel_core::{
    cell_rules,
    codegen::{build_model, generate_code, CodegenTarget},
    formula_context::ProjectFormulaContext,
    json_export::{
        export_runtime_bundle_to_file_with_validation, export_runtime_bundle_with_validation,
        ExportMode, ExportTable,
    },
    table_mutation::{self, CellPatch, TableMutation},
    ColumnSchema, Interface, InterfaceChange, Project, Record, TableData, ValueType,
};
use devcel_runtime::{ffi::*, Snapshot};
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs,
    path::{Path, PathBuf},
};

fn cases() -> Vec<(&'static str, String)> {
    vec![
        ("empty", String::new()),
        ("lf", "一行目\n二行目".into()),
        ("crlf", "一行目\r\n二行目".into()),
        ("cr", "一行目\r二行目".into()),
        ("blank_lines", "\n\n先頭と末尾の空行\n\n終わり\n\n".into()),
        ("only_newlines", "\r\n\n\r".into()),
        ("tab_quote", "\t\"二重引用符\"\n\t\t\"\"\"\t終端\t".into()),
        ("literal_backslash_n", r"一行目\n二行目".into()),
        ("literal_escapes", "\\r\\n\\t\\\"\n実際の改行".into()),
        (
            "unicode",
            "日本語とemoji 🦀🧪👨‍👩‍👧‍👦\n結合文字 e\u{301} と全角空白　".into(),
        ),
        ("mixed", "最初\r\n\t\"引用\"\r途中\n\n末尾\\n 🧪\n".into()),
        ("whitespace", "  \t\n\t  \r\n  ".into()),
        ("long", "長文 🧪\t\"引用\"\r\n空行\n\n".repeat(512)),
    ]
}

fn column(name: &str, default: &str) -> ColumnSchema {
    ColumnSchema {
        data_name: name.into(),
        display_name: name.into(),
        data_type: ValueType::String,
        default_value: default.into(),
        ..Default::default()
    }
}

// Formula strings use Excel-style doubled quotes. Backslashes stay literal;
// actual LF/CRLF/CR are deliberately embedded in the expression source.
fn formula(value: &str) -> String {
    format!("=CONCAT(\"{}\", \"\")", value.replace('"', "\"\""))
}

struct Fixture {
    _directory: tempfile::TempDir,
    project: Project,
    paths: Vec<PathBuf>,
    expected: BTreeMap<String, String>,
}

fn fixture() -> Fixture {
    let directory = tempfile::tempdir().unwrap();
    let mut project = Project::create_project(
        "MultilineStrings",
        directory.path().to_str().unwrap(),
        "複数行Stringをそのまま保存する統合検証",
        "#123456",
    )
    .unwrap();
    let mut paths = Vec::new();
    let mut expected = BTreeMap::new();
    for (index, (name, value)) in cases().into_iter().enumerate() {
        let expression = formula(&value);
        let mut interface = Interface::new(format!("Text{index}"), None);
        interface
            .create_new_version(
                [
                    column("interface_plain", ""),
                    column("interface_default", &value),
                    column("interface_formula", ""),
                    column("interface_default_formula", &expression),
                ]
                .into_iter()
                .map(|column| InterfaceChange::AddColumn { column })
                .collect(),
                None,
                None,
            )
            .unwrap();
        project
            .interface_registry
            .add_interface(interface.clone())
            .unwrap();
        project.save_interface(&interface).unwrap();
        let path = project
            .create_table(format!("{name}.table.toml").into())
            .unwrap();
        project.load_table(&path).unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        table.data.metadata.data_name = name.into();
        table
            .apply_interface(&interface, &project.interface_registry, true)
            .unwrap();
        table.data.schema.columns.extend([
            column("plain", ""),
            column("inherited_default", &value),
            column("formula", ""),
            column("default_formula", &expression),
        ]);
        // Absent input and an explicit Default mode both use the column default.
        for explicit_default_modes in [false, true] {
            let mut record = Record::new();
            for column in &table.data.schema.columns {
                let raw = match column.data_name.as_str() {
                    "plain" | "interface_plain" => Some(&value),
                    "formula" | "interface_formula" => Some(&expression),
                    _ => None,
                };
                if let Some(raw) = raw {
                    record.set_cell_value(column, raw.clone());
                } else if explicit_default_modes {
                    record.remove_cell_value(column);
                }
            }
            table.data.records.push(record);
        }
        table.is_dirty = true;
        paths.push(path);
        expected.insert(name.into(), value);
    }
    project.save_project().unwrap();
    Fixture {
        _directory: directory,
        project,
        paths,
        expected,
    }
}

fn assert_authoring(data: &TableData, expected: &str) {
    for column in &data.schema.columns {
        let is_default = column.data_name.contains("default");
        let is_formula = column.data_name.contains("formula");
        let expression = formula(expected);
        assert_eq!(
            column.default_value,
            if is_default {
                if is_formula {
                    &expression
                } else {
                    expected
                }
            } else {
                ""
            }
        );
        for record in &data.records {
            let actual = record.get_cell_value(column).map(String::as_str);
            if is_default {
                assert_eq!(actual, None);
            } else {
                assert_eq!(
                    actual,
                    if is_formula {
                        Some(expression.as_str())
                    } else if expected.is_empty() {
                        None
                    } else {
                        Some(expected)
                    }
                );
            }
        }
    }
}

fn assert_json_and_runtime(json: &str, path: &Path, expected: &BTreeMap<String, String>) {
    let parsed: serde_json::Value = serde_json::from_str(json).unwrap();
    let snapshot = Snapshot::from_json(json).unwrap();
    assert_eq!(snapshot.tables.len(), expected.len());
    let input = CString::new(json).unwrap();
    // Exercise the exact length-delimited UTF-8 ABI consumed by generated C#.
    let db = unsafe { devcel_rt_open_from_json(input.as_ptr()) };
    assert!(!db.is_null());
    let file_path = CString::new(path.to_str().unwrap()).unwrap();
    let file_db = unsafe { devcel_rt_open(file_path.as_ptr()) };
    assert!(!file_db.is_null());
    for (name, value) in expected {
        let table = snapshot.table(snapshot.table_index(name).unwrap()).unwrap();
        let table_json = parsed["tables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|table| table["name"] == name.as_str())
            .unwrap();
        let table_name = CString::new(name.as_str()).unwrap();
        let table_index = unsafe { devcel_rt_table_index(db, table_name.as_ptr()) };
        assert!(table_index >= 0);
        assert_eq!(table.columns.len(), 8);
        assert_eq!(table.row_count, 2);
        for column in &table.columns {
            let column_name = CString::new(column.name.as_str()).unwrap();
            let column_index =
                unsafe { devcel_rt_column_index(db, table_index, column_name.as_ptr()) };
            assert!(column_index >= 0);
            for row in 0..table.row_count {
                let stored = table_json["records"][row]["values"].get(&column.name);
                let column_json = table_json["columns"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|item| item["name"] == column.name)
                    .unwrap();
                let effective = stored.unwrap_or(&column_json["default_value"]);
                assert_eq!(effective.as_str(), Some(value.as_str()));
                assert_eq!(
                    column.str_at(row),
                    Some(value.as_str()),
                    "{name}/{}",
                    column.name
                );
                for handle in [db, file_db] {
                    let mut len = -1;
                    let bytes = unsafe {
                        devcel_rt_get_str(handle, table_index, row as i32, column_index, &mut len)
                    };
                    assert!(!bytes.is_null());
                    assert_eq!(len as usize, value.len(), "UTF-8 byte length: {name}");
                    let actual = unsafe { std::slice::from_raw_parts(bytes, len as usize) };
                    assert_eq!(actual, value.as_bytes(), "C ABI: {name}/{}", column.name);
                }
            }
        }
    }
    unsafe { devcel_rt_close(db) };
    unsafe { devcel_rt_close(file_db) };
}

#[test]
fn saved_multiline_strings_survive_defaults_formulas_exports_and_runtime() {
    let mut fixture = fixture();
    let source_revisions: Vec<_> = fixture
        .paths
        .iter()
        .map(|path| cell_rules::revision(&fixture.project.tables_data[path].data))
        .collect();
    let source_files: Vec<_> = fixture
        .paths
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect();
    let mut reopened = Project::open_project(fixture.project.path.to_str().unwrap()).unwrap();
    assert_eq!(reopened.list_interfaces().len(), fixture.expected.len());
    for ((path, revision), file) in fixture
        .paths
        .iter()
        .zip(&source_revisions)
        .zip(&source_files)
    {
        reopened.load_table(path).unwrap();
        let data = &reopened.tables_data[path].data;
        let value = &fixture.expected[&data.metadata.data_name];
        assert_authoring(data, value);
        for id in &data.metadata.interface_order {
            let interface = reopened.get_interface(id).unwrap();
            for column in &interface.columns {
                let applied = data
                    .schema
                    .columns
                    .iter()
                    .find(|applied| applied.data_name == column.data_name)
                    .unwrap();
                assert_eq!(
                    column.default_value, applied.default_value,
                    "interface file default"
                );
            }
        }
        assert_eq!(&cell_rules::revision(data), revision);
        assert_eq!(&fs::read(path).unwrap(), file);
        let context = ProjectFormulaContext::new(&reopened, None).unwrap();
        let presentation = context.presentation(data);
        assert_eq!(presentation.issue_count, 0);
        assert!(presentation.definition_issues.is_empty());
        for record in &data.records {
            for column in data
                .schema
                .columns
                .iter()
                .filter(|column| column.data_name.contains("formula"))
            {
                let cell = &presentation.cells[&record.uuid][&column.uuid];
                assert_eq!(cell.display_value, *value);
                // Presentation exposes effective authoring input for copy/edit;
                // raw storage remains absent on default-backed cells above.
                assert_eq!(cell.raw_value, formula(value));
                assert_eq!(cell.formula_error, None);
            }
        }
        // Table-only export is independently used by editor/CLI consumers.
        for mode in [ExportMode::Full, ExportMode::Minimal] {
            let exported = ExportTable::from_table_data(&mut data.clone(), mode).unwrap();
            assert_eq!(exported.columns.len(), 8);
            for row in exported.records {
                for column in &exported.columns {
                    let effective = row
                        .values
                        .get(&column.name)
                        .or(column.default_value.as_ref());
                    assert_eq!(effective, Some(value));
                }
            }
        }
    }
    fixture.project = reopened;
    let temporary_output = tempfile::tempdir().unwrap();
    let output = std::env::var_os("DEVCEL_MULTILINE_FIXTURE_OUT")
        .map(PathBuf::from)
        .unwrap_or_else(|| temporary_output.path().into());
    fs::create_dir_all(&output).unwrap();
    fs::create_dir_all(output.join("expected")).unwrap();
    for (name, value) in &fixture.expected {
        fs::write(output.join("expected").join(format!("{name}.txt")), value).unwrap();
    }
    fs::write(
        output.join("expected.json"),
        serde_json::to_vec_pretty(&fixture.expected).unwrap(),
    )
    .unwrap();
    for (name, mode) in [("full", ExportMode::Full), ("minimal", ExportMode::Minimal)] {
        let bundle =
            export_runtime_bundle_with_validation(&mut fixture.project, mode, None, false).unwrap();
        let json = serde_json::to_string_pretty(&bundle).unwrap();
        let destination = output.join(format!("{name}.json"));
        fs::write(&destination, &json).unwrap();
        assert_json_and_runtime(&json, &destination, &fixture.expected);
        // Force streaming export to discover and load actual persisted files.
        let mut cold = Project::open_project(fixture.project.path.to_str().unwrap()).unwrap();
        assert!(cold.tables_data.is_empty());
        let destination = output.join(format!("{name}-stream.json"));
        let summary = export_runtime_bundle_to_file_with_validation(
            &mut cold,
            mode,
            None,
            false,
            &destination,
        )
        .unwrap();
        assert!(
            cold.tables_data.is_empty(),
            "Streaming should not retain loaded tables"
        );
        assert_eq!(summary.manifest.content_hash, bundle.manifest.content_hash);
        let streamed = fs::read_to_string(&destination).unwrap();
        assert_json_and_runtime(&streamed, &destination, &fixture.expected);
        let streamed: serde_json::Value = serde_json::from_str(&streamed).unwrap();
        assert_eq!(
            streamed["tables"],
            serde_json::to_value(&bundle.tables).unwrap()
        );
    }
    for ((path, revision), file) in fixture
        .paths
        .iter()
        .zip(&source_revisions)
        .zip(&source_files)
    {
        assert_eq!(
            &cell_rules::revision(&fixture.project.tables_data[path].data),
            revision
        );
        assert_eq!(&fs::read(path).unwrap(), file);
    }
    write_csharp_harness(&mut fixture.project, &output);
    // A literal backslash followed by n must never turn into a line feed.
    assert_ne!(
        fixture.expected["lf"],
        fixture.expected["literal_backslash_n"]
    );
}

fn write_csharp_harness(project: &mut Project, output: &Path) {
    let source = generate_code(project, CodegenTarget::CSharp, Some("MultilineCheck")).unwrap();
    assert!(source.contains("IntPtr ptr = devcel_rt_get_str(db, table, row, col, out int len);"));
    assert!(source.contains("return Marshal.PtrToStringUTF8(ptr, len) ?? string.Empty;"));
    let model = build_model(project).unwrap();
    let mut program = String::from(
        "using System;\nusing System.IO;\nusing MultilineCheck;\nclass Program {\n\
         static void Check(string actual, string expected, string label) {\n\
         if (!string.Equals(actual, expected, StringComparison.Ordinal)) throw new Exception(label);\n}\n\
         static void Main(string[] args) {\nint checks = 0;\n\
         foreach (var file in new[] { \"full.json\", \"minimal.json\", \"full-stream.json\", \"minimal-stream.json\" }) {\n\
         foreach (bool fromJson in new[] { false, true }) {\n\
         using var db = fromJson ? DevcelDatabase.FromJson(File.ReadAllText(Path.Combine(args[0], file))) : DevcelDatabase.Open(Path.Combine(args[0], file));\n",
    );
    for table in model.tables {
        for row in 0..2 {
            for column in table.columns.iter() {
                program.push_str(&format!(
                    "Check(db.{}[{row}].{}, File.ReadAllText(Path.Combine(args[0], \"expected\", \"{}.txt\")), \"{}/{}\"); checks++;\n",
                    table.type_base, column.accessor, table.data_name, table.data_name, column.key,
                ));
            }
        }
    }
    program.push_str("}}\nConsole.WriteLine(\"DEVCEL_CSHARP_MULTILINE passed=\" + checks);\n}}\n");
    fs::write(output.join("Generated.cs"), source).unwrap();
    fs::write(output.join("Program.cs"), program).unwrap();
    fs::write(
        output.join("Check.csproj"),
        r#"<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <LangVersion>8.0</LangVersion>
    <Nullable>enable</Nullable>
    <ImplicitUsings>disable</ImplicitUsings>
    <TreatWarningsAsErrors>true</TreatWarningsAsErrors>
  </PropertyGroup>
</Project>
"#,
    )
    .unwrap();
    fs::write(
        output.join("NuGet.Config"),
        "<configuration><packageSources><clear /></packageSources></configuration>\n",
    )
    .unwrap();
}

fn edit_request(data: &TableData, value: &str) -> TableMutation {
    TableMutation {
        table_uuid: data.uuid.clone(),
        expected_revision: cell_rules::revision(data),
        cells: data
            .schema
            .columns
            .iter()
            .filter(|column| matches!(column.data_name.as_str(), "plain" | "interface_plain"))
            .map(|column| CellPatch {
                record_uuid: data.records[0].uuid.clone(),
                column_uuid: column.uuid.clone(),
                value: value.into(),
            })
            .collect(),
        versions: Vec::new(),
        column_versions: Vec::new(),
        create_records: Vec::new(),
        delete_record_uuids: Vec::new(),
        acknowledgement: None,
    }
}

fn assert_cells_and_disk(project: &Project, path: &Path, expected: &str) {
    let saved: TableData = toml::from_str(&fs::read_to_string(path).unwrap()).unwrap();
    let live = &project.tables_data[path].data;
    assert_eq!(cell_rules::revision(live), cell_rules::revision(&saved));
    for data in [live, &saved] {
        for column in data
            .schema
            .columns
            .iter()
            .filter(|column| matches!(column.data_name.as_str(), "plain" | "interface_plain"))
        {
            assert_eq!(
                data.records[0].get_cell_value(column).map(String::as_str),
                if expected.is_empty() {
                    None
                } else {
                    Some(expected)
                }
            );
        }
    }
}

#[test]
fn multiline_native_mutation_is_one_atomic_history_entry_and_roundtrips_wire() {
    let mut fixture = fixture();
    let path = fixture.paths[1].clone(); // Start with a nonempty LF input.
    let table_uuid = fixture.project.tables_data[&path].data.uuid.clone();
    let mut previous = fixture.expected["lf"].clone();
    for (name, value) in cases() {
        let before = &fixture.project.tables_data[&path];
        let revision = cell_rules::revision(&before.data);
        let history = before.undo_history.len();
        let request = edit_request(&before.data, &value);
        let json = serde_json::to_vec(&request).unwrap();
        let request: TableMutation = serde_json::from_slice(&json).unwrap();
        let messagepack = rmp_serde::to_vec_named(&request).unwrap();
        let request: TableMutation = rmp_serde::from_slice(&messagepack).unwrap();
        assert!(request.cells.iter().all(|cell| cell.value == value));
        let stale = request.clone();
        table_mutation::apply(&mut fixture.project, request, None).unwrap();
        assert_cells_and_disk(&fixture.project, &path, &value);
        assert_eq!(
            fixture.project.tables_data[&path].undo_history.len(),
            history + 1,
            "{name}"
        );
        assert!(table_mutation::apply(&mut fixture.project, stale, None).is_err());
        assert_eq!(
            fixture.project.tables_data[&path].undo_history.len(),
            history + 1
        );
        fixture.project.undo_command(&table_uuid).unwrap();
        assert_cells_and_disk(&fixture.project, &path, &previous);
        assert_eq!(
            cell_rules::revision(&fixture.project.tables_data[&path].data),
            revision
        );
        fixture.project.redo_command(&table_uuid).unwrap();
        assert_cells_and_disk(&fixture.project, &path, &value);
        previous = value;
    }
    let mut reopened = Project::open_project(fixture.project.path.to_str().unwrap()).unwrap();
    reopened.load_table(&path).unwrap();
    assert_cells_and_disk(&reopened, &path, &previous);
}
