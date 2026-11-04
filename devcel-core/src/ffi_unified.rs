//! Canonical operation-based authoring ABI. JSON and MessagePack use one session.

use crate::operation_handler::{LocalOperationHandler, OperationHandler};
use crate::operations::{DevcelOperation, DevcelResponse};
use crate::Project;
use std::ffi::{c_char, CStr};
use std::ptr;
use std::sync::{Arc, Mutex as SessionMutex};
use tokio::runtime::Runtime;
use tokio::sync::Mutex;

struct AuthoringSession {
    runtime: Runtime,
    project: Arc<Mutex<Option<Project>>>,
}

// Serialize calls and cleanup: no operation may outlive its runtime/session.
static SESSION: SessionMutex<Option<AuthoringSession>> = SessionMutex::new(None);

/// Initialize the shared authoring session. Repeated calls are idempotent.
#[no_mangle]
pub extern "C" fn devcel_init() {
    let Ok(mut session) = SESSION.lock() else {
        return;
    };
    if session.is_none() {
        match Runtime::new() {
            Ok(runtime) => {
                *session = Some(AuthoringSession {
                    runtime,
                    project: Arc::new(Mutex::new(None)),
                });
            }
            Err(error) => eprintln!("Cannot initialize Devcel authoring runtime: {error}"),
        }
    }
}

/// Close the shared project and release the authoring session.
#[no_mangle]
pub extern "C" fn devcel_cleanup() {
    let Ok(mut guard) = SESSION.lock() else {
        return;
    };
    if let Some(session) = guard.take() {
        session.runtime.block_on(async {
            *session.project.lock().await = None;
        });
        session.runtime.shutdown_background();
    }
}

fn execute(operation: DevcelOperation) -> DevcelResponse {
    let Ok(session) = SESSION.lock() else {
        return DevcelResponse::Error("Authoring session lock is poisoned".into());
    };
    let Some(session) = session.as_ref() else {
        return DevcelResponse::Error("Devcel authoring runtime is not initialized".into());
    };
    session.runtime.block_on(async {
        LocalOperationHandler::new(session.project.clone())
            .handle_operation(operation)
            .await
    })
}

/// Execute a canonical operation encoded as MessagePack and return MessagePack.
///
/// # Safety
/// - `data` points to `data_len` readable bytes.
/// - `out_len` points to writable `size_t` storage (native pointer width).
/// - Free the returned exact pointer/length pair once using `devcel_free`.
#[no_mangle]
pub unsafe extern "C" fn devcel_execute(
    data: *const u8,
    data_len: usize,
    out_len: *mut usize,
) -> *mut u8 {
    if out_len.is_null() {
        return ptr::null_mut();
    }
    *out_len = 0;
    if data.is_null() || data_len > isize::MAX as usize {
        return ptr::null_mut();
    }
    let input = std::slice::from_raw_parts(data, data_len);
    let response = match rmp_serde::from_slice::<DevcelOperation>(input) {
        Ok(operation) => execute(operation),
        Err(error) => {
            DevcelResponse::Error((format!("Invalid operation MessagePack: {error}")).into())
        }
    };
    let Ok(output) = rmp_serde::to_vec_named(&response) else {
        return ptr::null_mut();
    };
    *out_len = output.len();
    Box::into_raw(output.into_boxed_slice()) as *mut u8
}

/// Execute a canonical operation encoded as UTF-8 JSON and return response JSON.
///
/// # Safety
/// `json` is a valid null-terminated UTF-8 string. Free the result once using
/// `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn devcel_execute_json(json: *const c_char) -> *mut c_char {
    if json.is_null() {
        return ptr::null_mut();
    }
    let response = match CStr::from_ptr(json).to_str() {
        Ok(text) => match serde_json::from_str::<DevcelOperation>(text) {
            Ok(operation) => execute(operation),
            Err(error) => {
                DevcelResponse::Error((format!("Invalid operation JSON: {error}")).into())
            }
        },
        Err(error) => DevcelResponse::Error((format!("Invalid operation UTF-8: {error}")).into()),
    };
    crate::ffi::response_json(&response)
}
