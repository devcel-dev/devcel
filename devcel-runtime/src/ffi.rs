//! C ABI FFI, thinly wrapped by generated C# (Unity) and C++ (Unreal) bindings.
//!
//! All value reads use snapshot indices and aim for zero allocations.
//!
//! # String pointer lifetime contract
//! Pointers returned by `devcel_rt_get_str` / `devcel_rt_content_hash` remain valid
//! **until the next `devcel_rt_reload_if_changed` or `devcel_rt_close` on the same handle**.
//! Hot reload replaces the internal snapshot and invalidates previously returned pointers,
//! so callers must copy (marshal) values immediately when needed.

use crate::database::Database;
use std::ffi::{c_char, CStr};

/// Opaque database handle, treated as void* by C callers.
pub type DatabaseHandle = Database;

/// Convert a C string to &str; return None for null or invalid UTF-8.
///
/// # Safety
/// `ptr` must point to a valid null-terminated C string or be null.
unsafe fn cstr<'a>(ptr: *const c_char) -> Option<&'a str> {
    if ptr.is_null() {
        return None;
    }
    CStr::from_ptr(ptr).to_str().ok()
}

/// Open a bundle JSON file; return null on failure.
///
/// # Safety
/// `path` must point to a valid null-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_open(path: *const c_char) -> *mut DatabaseHandle {
    let Some(path) = cstr(path) else {
        return std::ptr::null_mut();
    };
    match Database::open(path) {
        Ok(db) => Box::into_raw(Box::new(db)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Open from a bundle JSON string without a backing file; return null on failure.
///
/// # Safety
/// `json` must point to a valid null-terminated C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_open_from_json(json: *const c_char) -> *mut DatabaseHandle {
    let Some(json) = cstr(json) else {
        return std::ptr::null_mut();
    };
    match Database::from_json(json) {
        Ok(db) => Box::into_raw(Box::new(db)),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Free the handle; ignore null.
///
/// # Safety
/// `db` must be a pointer returned by `devcel_rt_open*` and must not be freed twice.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_close(db: *mut DatabaseHandle) {
    if !db.is_null() {
        drop(Box::from_raw(db));
    }
}

/// Reload if the file changed.
/// Returns 1 if replaced, 0 if unchanged, or -1 on error.
///
/// # Safety
/// `db` must point to a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_reload_if_changed(db: *const DatabaseHandle) -> i32 {
    let Some(db) = db.as_ref() else {
        return -1;
    };
    match db.reload_if_changed() {
        Ok(true) => 1,
        Ok(false) => 0,
        Err(_) => -1,
    }
}

/// Return the current snapshot's content_hash as UTF-8 bytes without a null terminator.
/// Write its length to `out_len`. Lifetime follows the module-level contract.
///
/// # Safety
/// `db` must be a valid handle and `out_len` a writable pointer.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_content_hash(
    db: *const DatabaseHandle,
    out_len: *mut i32,
) -> *const u8 {
    let Some(db) = db.as_ref() else {
        return std::ptr::null();
    };
    let snap = db.load();
    let hash = snap.content_hash();
    if !out_len.is_null() {
        *out_len = hash.len() as i32;
    }
    // The local Arc, snap, is dropped, but ArcSwap retains the current snapshot,
    // so the pointer remains valid until the next reload.
    hash.as_ptr()
}

/// Number of tables.
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_table_count(db: *const DatabaseHandle) -> i32 {
    match db.as_ref() {
        Some(db) => db.load().tables.len() as i32,
        None => -1,
    }
}

/// Resolve table name to table index; return -1 if not found.
///
/// # Safety
/// `db` must be a valid handle and `name` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_table_index(
    db: *const DatabaseHandle,
    name: *const c_char,
) -> i32 {
    let (Some(db), Some(name)) = (db.as_ref(), cstr(name)) else {
        return -1;
    };
    db.load().table_index(name).map(|i| i as i32).unwrap_or(-1)
}

/// Table row count; return -1 for an out-of-range table.
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_row_count(db: *const DatabaseHandle, table: i32) -> i32 {
    let Some(db) = db.as_ref() else {
        return -1;
    };
    let snap = db.load();
    match usize::try_from(table).ok().and_then(|t| snap.table(t)) {
        Some(t) => t.row_count as i32,
        None => -1,
    }
}

/// Resolve column name to column index; return -1 if not found.
///
/// # Safety
/// `db` must be a valid handle and `name` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_column_index(
    db: *const DatabaseHandle,
    table: i32,
    name: *const c_char,
) -> i32 {
    let (Some(db), Some(name)) = (db.as_ref(), cstr(name)) else {
        return -1;
    };
    let snap = db.load();
    match usize::try_from(table).ok().and_then(|t| snap.table(t)) {
        Some(t) => t.column_index(name).map(|i| i as i32).unwrap_or(-1),
        None => -1,
    }
}

/// Resolve record UUID to row index; return -1 if not found.
///
/// # Safety
/// `db` must be a valid handle and `uuid` a valid C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_row_by_uuid(
    db: *const DatabaseHandle,
    table: i32,
    uuid: *const c_char,
) -> i32 {
    let (Some(db), Some(uuid)) = (db.as_ref(), cstr(uuid)) else {
        return -1;
    };
    let snap = db.load();
    match usize::try_from(table).ok().and_then(|t| snap.table(t)) {
        Some(t) => t.row_by_id(uuid).map(|i| i as i32).unwrap_or(-1),
        None => -1,
    }
}

/// Shared helper to retrieve a cell's [`crate::snapshot::ColumnSnapshot`].
#[inline]
unsafe fn cell(
    db: *const DatabaseHandle,
    table: i32,
    col: i32,
) -> Option<(std::sync::Arc<crate::snapshot::Snapshot>, usize, usize)> {
    let db = db.as_ref()?;
    let snap = db.load();
    let t = usize::try_from(table).ok()?;
    let c = usize::try_from(col).ok()?;
    snap.table(t)?.column(c)?; // Bounds check
    Some((snap, t, c))
}

/// Get an i32 cell (0 for out-of-range indices or a type mismatch).
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_i32(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
) -> i32 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0;
    };
    snap.table(t).unwrap().column(c).unwrap().i64_at(r) as i32
}

/// Get an i64 cell (0 for out-of-range indices or a type mismatch).
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_i64(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
) -> i64 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0;
    };
    snap.table(t).unwrap().column(c).unwrap().i64_at(r)
}

/// Get an f32 cell (0.0 for out-of-range indices or a type mismatch).
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_f32(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
) -> f32 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0.0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0.0;
    };
    snap.table(t).unwrap().column(c).unwrap().f64_at(r) as f32
}

/// Get an f64 cell (0.0 for out-of-range indices or a type mismatch).
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_f64(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
) -> f64 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0.0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0.0;
    };
    snap.table(t).unwrap().column(c).unwrap().f64_at(r)
}

/// Get a bool cell (true=1, false=0; 0 for out-of-range indices).
///
/// # Safety
/// `db` must be a valid handle.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_bool(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
) -> i32 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0;
    };
    i32::from(snap.table(t).unwrap().column(c).unwrap().bool_at(r))
}

/// Get a string cell as a UTF-8 byte pointer and write its length to `out_len`.
/// Return null and len=0 for nontext types or out-of-range indices. Lifetime follows the module-level contract.
///
/// # Safety
/// `db` must be a valid handle and `out_len` a writable pointer.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_str(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
    out_len: *mut i32,
) -> *const u8 {
    if !out_len.is_null() {
        *out_len = 0;
    }
    let Some((snap, t, c)) = cell(db, table, col) else {
        return std::ptr::null();
    };
    let Ok(r) = usize::try_from(row) else {
        return std::ptr::null();
    };
    match snap.table(t).unwrap().column(c).unwrap().str_at(r) {
        Some(s) => {
            if !out_len.is_null() {
                *out_len = s.len() as i32;
            }
            // The local Arc, snap, is dropped, but ArcSwap retains the current snapshot,
            // so the pointer remains valid until the next reload.
            s.as_ptr()
        }
        None => std::ptr::null(),
    }
}

/// Sample a Curve cell. Out-of-range/type mismatch and NaN return 0; infinities clamp to endpoints.
/// Use the curve parsed at load time, with no per-call allocations.
///
/// # Safety
/// `db` must be a valid handle or null.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_sample_curve(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
    x: f64,
) -> f64 {
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0.0;
    };
    let Ok(r) = usize::try_from(row) else {
        return 0.0;
    };
    snap.table(t)
        .unwrap()
        .column(c)
        .unwrap()
        .curve_at(r)
        .map(|curve| curve.sample(x))
        .unwrap_or(0.0)
}

/// Resolve TableRef by table UUID and validate both bundle and caller interface constraints.
/// Return -1 for empty/invalid cells, unresolved references, or type/interface mismatches. Empty required_interface adds no constraint.
///
/// # Safety
/// `db` must be a valid handle or null; `required_interface` must be a valid C string.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_resolve_table_ref(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
    required_interface: *const c_char,
) -> i32 {
    let (Some(db), Some(required)) = (db.as_ref(), cstr(required_interface)) else {
        return -1;
    };
    let (Ok(t), Ok(r), Ok(c)) = (
        usize::try_from(table),
        usize::try_from(row),
        usize::try_from(col),
    ) else {
        return -1;
    };
    db.load()
        .resolve_table_ref(t, r, c, required)
        .map(|i| i as i32)
        .unwrap_or(-1)
}

/// Current runtime ABI. Generated consumers must verify this before opening a bundle.
#[no_mangle]
pub extern "C" fn devcel_rt_api_version() -> u32 {
    crate::API_VERSION
}

/// Copies one typed RGBA cell into caller-owned memory. Returns 1 on success, 0 on
/// invalid index, wrong type or null output. Failure does not modify the output.
///
/// # Safety
/// `db` must be a live handle or null; `out` must be writable for one Color32 or null.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_color32(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
    out: *mut crate::Color32,
) -> i32 {
    if out.is_null() {
        return 0;
    }
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0;
    };
    let Ok(row) = usize::try_from(row) else {
        return 0;
    };
    let Some(value) = snap.table(t).unwrap().column(c).unwrap().color32_at(row) else {
        return 0;
    };
    out.write(value);
    1
}

/// Copies one typed RGBA cell into caller-owned memory. Returns 1 on success, 0 on
/// invalid index, wrong type or null output. Failure does not modify the output.
///
/// # Safety
/// `db` must be a live handle or null; `out` must be writable for one ColorFloat or null.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_get_color_float(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    col: i32,
    out: *mut crate::ColorFloat,
) -> i32 {
    if out.is_null() {
        return 0;
    }
    let Some((snap, t, c)) = cell(db, table, col) else {
        return 0;
    };
    let Ok(row) = usize::try_from(row) else {
        return 0;
    };
    let Some(value) = snap
        .table(t)
        .unwrap()
        .column(c)
        .unwrap()
        .color_float_at(row)
    else {
        return 0;
    };
    out.write(value);
    1
}

/// Resolve a serialized record reference's table identity, never its display/data name.
/// Empty required_interface adds no membership constraint. Returns -1 when unresolved.
///
/// # Safety
/// `db` must be a live handle or null. String pointers must be valid C strings or null.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_record_reference_table(
    db: *const DatabaseHandle,
    table_uuid: *const c_char,
    required_interface: *const c_char,
) -> i32 {
    let (Some(db), Some(id), Some(required)) =
        (db.as_ref(), cstr(table_uuid), cstr(required_interface))
    else {
        return -1;
    };
    let snapshot = db.load();
    let Some(index) = snapshot.table_by_uuid(id) else {
        return -1;
    };
    let Some(table) = snapshot.table(index) else {
        return -1;
    };
    if !required.is_empty() && !table.interfaces.contains(required) {
        return -1;
    }
    index as i32
}

/// Read a stable row ID. The returned UTF-8 bytes remain valid until reload/close.
/// Generated callers hold the database read gate through the managed copy.
///
/// # Safety
/// `db` must be live or null; `out_len` must be writable or null.
#[no_mangle]
pub unsafe extern "C" fn devcel_rt_row_uuid(
    db: *const DatabaseHandle,
    table: i32,
    row: i32,
    out_len: *mut i32,
) -> *const u8 {
    if !out_len.is_null() {
        *out_len = 0;
    }
    let Some(db) = db.as_ref() else {
        return std::ptr::null();
    };
    let (Ok(t), Ok(r)) = (usize::try_from(table), usize::try_from(row)) else {
        return std::ptr::null();
    };
    let snapshot = db.load();
    let Some(id) = snapshot.table(t).and_then(|table| table.row_ids.get(r)) else {
        return std::ptr::null();
    };
    if !out_len.is_null() {
        *out_len = id.len() as i32;
    }
    id.as_ptr()
}
