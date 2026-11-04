//! Native Studio manual regression project; never alters an existing directory.
use devcel_core::*;
fn main() {
    let parent = std::env::args().nth(1).expect("output parent directory");
    let mut project = Project::create_project(
        "ColumnVersions",
        &parent,
        "列と行のバージョン検証",
        "#6366f1",
    )
    .unwrap();
    for (name, rows, columns) in [("Items", 4, 5), ("LargeGrid", 2000, 80)] {
        let path = project
            .create_table(format!("{name}.table.toml").into())
            .unwrap();
        project.load_table(&path).unwrap();
        let table = project.tables_data.get_mut(&path).unwrap();
        for i in 0..columns {
            let (key, label, kind) = if name == "Items" {
                match i {
                    0 => ("name".into(), "名前".into(), ValueType::String),
                    1 => ("base".into(), "基本価格".into(), ValueType::F64),
                    2 => ("price".into(), "価格".into(), ValueType::F64),
                    3 => ("rate".into(), "補正率".into(), ValueType::F64),
                    _ => ("note".into(), "備考".into(), ValueType::String),
                }
            } else {
                (format!("field{i}"), format!("列{i}"), ValueType::F64)
            };
            table.data.schema.columns.push(ColumnSchema {
                data_name: key,
                display_name: label,
                data_type: kind,
                min_version: if i == 3 { 3 } else { 0 },
                ..Default::default()
            });
        }
        for i in 0..rows {
            let mut row = Record::new();
            row.min_version = match i % 4 {
                0 | 1 => 0,
                n => n as u32,
            };
            row.label = format!("行{}", i + 1);
            for column in &table.data.schema.columns {
                let value = match column.data_name.as_str() {
                    "name" => ["薬草", "ポーション", "エーテル", "エリクサー"][i].into(),
                    "base" => (100 * (i + 1)).to_string(),
                    "price" => "=base*rate".into(),
                    "rate" => "1.2".into(),
                    "note" => "編集できるセル".into(),
                    _ => i.to_string(),
                };
                row.set_cell_value(column, value);
            }
            table.data.records.push(row);
        }
        std::fs::write(&path, toml::to_string(&table.data).unwrap()).unwrap();
    }
    println!("{}", project.path.display());
}
