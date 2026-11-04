// SPDX-License-Identifier: GPL-3.0-only
// Copyright (c) 2024 Devcel Studio Contributors
// See devcel-studio/LICENSE in the complete source distribution.

use toml08 as toml;

use super::*;
use devcel_core::theme_schema::*;
#[test]
fn standard_themes_have_one_typed_complete_record_per_theme() {
    let table: devcel_core::TableData = toml::from_str(
        &std::fs::read_to_string(seed_root().join("Tables/Themes.table.toml")).unwrap(),
    )
    .unwrap();
    assert_eq!(table.schema.columns.len(), 24);
    assert_eq!(table.records.len(), 2);
    let dark = table
        .schema
        .columns
        .iter()
        .find(|c| c.uuid == DARK_FIELD_UUID)
        .unwrap();
    assert_eq!(dark.data_type, devcel_core::ValueType::Boolean);
    assert_eq!(dark.required, Some(true));
    for (_, field, id) in COLOR_FIELDS {
        let column = table.schema.columns.iter().find(|c| c.uuid == id).unwrap();
        assert_eq!(column.data_name, field);
        assert_eq!(column.data_type, devcel_core::ValueType::Color32);
        assert_eq!(column.required, Some(true));
        for row in &table.records {
            assert_eq!(
                devcel_core::color::Color32::parse(&row.values[field])
                    .unwrap()
                    .channels()[3],
                255
            );
        }
    }
    for row in &table.records {
        assert_eq!(
            row.values["is_dark"],
            (row.values["key"] == "dark").to_string()
        );
    }
}
