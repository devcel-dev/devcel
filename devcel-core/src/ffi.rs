//! Shared allocation ownership for the authoring C ABI.
//!
//! Editing is exposed only through canonical operations in `ffi_unified` and
//! `ffi_p2p`. Returned JSON and P2P-info strings all use this allocator.

use crate::operations::DevcelResponse;
use std::ffi::{c_char, CString};
use std::ptr;

pub(crate) fn response_json(response: &DevcelResponse) -> *mut c_char {
    serde_json::to_string(response)
        .ok()
        .and_then(|json| CString::new(json).ok())
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

/// Free a string returned by any Devcel authoring C ABI function.
///
/// # Safety
/// `string` must be null or an unchanged pointer returned by this library and
/// must not have been freed previously.
#[no_mangle]
pub unsafe extern "C" fn devcel_free_string(string: *mut c_char) {
    if !string.is_null() {
        drop(CString::from_raw(string));
    }
}

/// Free MessagePack bytes returned by `devcel_execute`.
///
/// # Safety
/// `data` and `len` must be the exact pair returned by `devcel_execute`, and must
/// not have been freed previously. `len` is a native-width `size_t`.
#[no_mangle]
pub unsafe extern "C" fn devcel_free(data: *mut u8, len: usize) {
    if !data.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(data, len)));
    }
}
