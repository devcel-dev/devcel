//! # devcel-runtime
//!
//! Lightweight runtime for reading exported Devcel master data on the game side
//! (DLL consumers), with **type-safe, low-overhead, read-only** access.
//!
//! - Does not depend on devcel-core or include its editing, tokio, or P2P features;
//!   shares only the bundle JSON **format contract**.
//! - Parses bundle JSON once to build an optimized snapshot (string pool, typed
//!   arrays, and UUID indices). Subsequent value reads are O(1) and allocation-free.
//! - [`Database`] holds the current snapshot in [`arc_swap::ArcSwap`] and performs
//!   hot reload through `reload_if_changed`, comparing `content_hash` values.
//! - Generated C# (Unity) and C++ (Unreal) bindings wrap the C ABI FFI ([`ffi`]).

/// Current read-only native ABI; generated SDKs verify it before opening data.
pub const API_VERSION: u32 = 1;

pub mod bundle;
pub mod color;
pub mod curve;
pub mod database;
pub mod ffi;
pub mod snapshot;

pub use bundle::{Bundle, Manifest, RtValueType, ScalarKind, SUPPORTED_SCHEMA_VERSION};
pub use color::{Color32, ColorFloat};
pub use database::Database;
pub use snapshot::{ColumnData, ColumnSnapshot, Snapshot, TableSnapshot};

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal bundle JSON for tests.
    fn sample_json(content_hash: &str) -> String {
        format!(
            r#"{{
              "manifest": {{
                "schema_version": 1,
                "content_version": 5,
                "content_hash": "{content_hash}",
                "data_revision": 1,
                "generated_at": "2026-01-01T00:00:00Z",
                "mode": "full"
              }},
              "project_name": "demo",
              "tables": [
                {{
                  "name": "monsters",
                  "uuid": "11111111-1111-4111-8111-111111111111",
                  "columns": [
                    {{ "name": "hp", "data_type": "I32" }},
                    {{ "name": "name", "data_type": "String" }},
                    {{ "name": "speed", "data_type": "F32" }},
                    {{ "name": "boss", "data_type": "Boolean" }}
                  ],
                  "records": [
                    {{ "id": "u1", "values": {{ "hp": "100", "name": "slime", "speed": "1.5", "boss": "false" }} }},
                    {{ "id": "u2", "values": {{ "hp": "999", "name": "dragon", "speed": "3.25", "boss": "true" }} }}
                  ]
                }}
              ]
            }}"#
        )
    }

    #[test]
    fn builds_snapshot_and_indexes() {
        let snap = Snapshot::from_json(&sample_json("abc")).unwrap();
        assert_eq!(snap.content_hash(), "abc");
        let ti = snap.table_index("monsters").unwrap();
        let t = snap.table(ti).unwrap();
        assert_eq!(t.row_count, 2);

        let hp = t.column_index("hp").unwrap();
        let name = t.column_index("name").unwrap();
        let speed = t.column_index("speed").unwrap();
        let boss = t.column_index("boss").unwrap();

        // UUID index
        let r2 = t.row_by_id("u2").unwrap();
        assert_eq!(r2, 1);

        assert_eq!(t.column(hp).unwrap().i64_at(r2), 999);
        assert_eq!(t.column(name).unwrap().str_at(r2), Some("dragon"));
        assert!((t.column(speed).unwrap().f64_at(r2) - 3.25).abs() < 1e-9);
        assert!(t.column(boss).unwrap().bool_at(r2));

        let r1 = t.row_by_id("u1").unwrap();
        assert!(!t.column(boss).unwrap().bool_at(r1));
    }

    #[test]
    fn missing_lookups_return_none() {
        let snap = Snapshot::from_json(&sample_json("abc")).unwrap();
        assert!(snap.table_index("nope").is_none());
        let t = snap.table(snap.table_index("monsters").unwrap()).unwrap();
        assert!(t.column_index("nope").is_none());
        assert!(t.row_by_id("nope").is_none());
    }

    #[test]
    fn rejects_future_schema_version() {
        let json = r#"{"manifest":{"schema_version":999,"content_hash":"x","data_revision":0,"generated_at":"2026-10-01T00:00:00Z","mode":"full"},"project_name":"d","tables":[]}"#;
        assert!(Snapshot::from_json(json).is_err());
    }

    #[test]
    fn ffi_smoke_test() {
        use crate::ffi::*;
        use std::ffi::CString;

        let json = CString::new(sample_json("ffi_hash")).unwrap();
        let db = unsafe { devcel_rt_open_from_json(json.as_ptr()) };
        assert!(!db.is_null());

        unsafe {
            assert_eq!(devcel_rt_table_count(db), 1);

            let tname = CString::new("monsters").unwrap();
            let ti = devcel_rt_table_index(db, tname.as_ptr());
            assert_eq!(ti, 0);
            assert_eq!(devcel_rt_row_count(db, ti), 2);

            let hp = devcel_rt_column_index(db, ti, CString::new("hp").unwrap().as_ptr());
            let name = devcel_rt_column_index(db, ti, CString::new("name").unwrap().as_ptr());
            let speed = devcel_rt_column_index(db, ti, CString::new("speed").unwrap().as_ptr());
            let boss = devcel_rt_column_index(db, ti, CString::new("boss").unwrap().as_ptr());

            let row = devcel_rt_row_by_uuid(db, ti, CString::new("u2").unwrap().as_ptr());
            assert_eq!(row, 1);

            assert_eq!(devcel_rt_get_i32(db, ti, row, hp), 999);
            assert_eq!(devcel_rt_get_i64(db, ti, row, hp), 999);
            assert!((devcel_rt_get_f32(db, ti, row, speed) - 3.25).abs() < 1e-6);
            assert_eq!(devcel_rt_get_bool(db, ti, row, boss), 1);

            // String access: convert ptr + len to a slice and verify
            let mut len: i32 = 0;
            let ptr = devcel_rt_get_str(db, ti, row, name, &mut len);
            assert!(!ptr.is_null());
            let bytes = std::slice::from_raw_parts(ptr, len as usize);
            assert_eq!(std::str::from_utf8(bytes).unwrap(), "dragon");

            // content_hash
            let mut hlen: i32 = 0;
            let hptr = devcel_rt_content_hash(db, &mut hlen);
            let hbytes = std::slice::from_raw_parts(hptr, hlen as usize);
            assert_eq!(std::str::from_utf8(hbytes).unwrap(), "ffi_hash");

            // Out-of-range access safely returns 0/-1
            assert_eq!(devcel_rt_get_i32(db, ti, 999, hp), 0);
            assert_eq!(
                devcel_rt_table_index(db, CString::new("nope").unwrap().as_ptr()),
                -1
            );

            devcel_rt_close(db);
        }
    }

    #[test]
    fn database_reload_detects_change() {
        let dir = std::env::temp_dir().join(format!("devcel_rt_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("bundle.json");

        std::fs::write(&path, sample_json("hash_v1")).unwrap();
        let db = Database::open(&path).unwrap();
        assert_eq!(db.content_hash(), "hash_v1");

        // Same content: no change
        assert!(!db.reload_if_changed().unwrap());

        // Replace when content_hash changes
        std::fs::write(&path, sample_json("hash_v2")).unwrap();
        assert!(db.reload_if_changed().unwrap());
        assert_eq!(db.content_hash(), "hash_v2");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
