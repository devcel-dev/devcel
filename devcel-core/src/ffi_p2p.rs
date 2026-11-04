//! Handle-based P2P authoring ABI. Calls for one handle must be serialized.
//! Returned strings use `crate::ffi::devcel_free_string`; structs borrow no buffers.

use crate::msgpack_client::MsgPackClient;
use crate::msgpack_server::MsgPackServer;
use crate::p2p_manager::{ConnectionMode, P2PManager};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use tokio::runtime::Runtime;

/// FFI-safe P2P connection info
#[repr(C)]
pub struct FFI_P2PConnectionInfo {
    pub mode: i32, // 0 = Server, 1 = Client
    pub address: *mut c_char,
    pub server_address: *mut c_char,
}

/// FFI-safe service info
#[repr(C)]
pub struct FFI_ServiceInfo {
    pub app_type: *mut c_char,
    pub project_path: *mut c_char,
    pub project_uuid: *mut c_char,
    pub address: *mut c_char,
    pub last_seen_timestamp: i64,
    pub is_active: bool,
}

/// P2P Manager wrapper for FFI
pub struct FfiP2pManager {
    manager: P2PManager,
    runtime: Runtime,
}

/// Create a new P2P manager
#[no_mangle]
pub extern "C" fn p2p_manager_new() -> *mut FfiP2pManager {
    let manager = match P2PManager::try_new() {
        Ok(manager) => manager,
        Err(_) => return ptr::null_mut(),
    };
    match Runtime::new() {
        Ok(runtime) => {
            let ffi_manager = FfiP2pManager { manager, runtime };
            Box::into_raw(Box::new(ffi_manager))
        }
        Err(_) => ptr::null_mut(),
    }
}

/// Free a P2P manager
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_manager_free(manager: *mut FfiP2pManager) {
    if !manager.is_null() {
        unsafe {
            let mut manager = Box::from_raw(manager);
            let _ = manager.runtime.block_on(manager.manager.disconnect());
        }
    }
}

/// Open a project in P2P mode
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_open_project(
    manager: *mut FfiP2pManager,
    project_path: *const c_char,
    app_type: *const c_char,
    preferred_port: u16,
    out_info: *mut FFI_P2PConnectionInfo,
) -> i32 {
    if out_info.is_null() {
        return -1;
    }
    unsafe {
        *out_info = FFI_P2PConnectionInfo {
            mode: -1,
            address: ptr::null_mut(),
            server_address: ptr::null_mut(),
        };
    }
    if manager.is_null() || project_path.is_null() || app_type.is_null() {
        return -1;
    }

    unsafe {
        let manager = &mut *manager;

        // Convert C strings to Rust strings
        let project_path = match CStr::from_ptr(project_path).to_str() {
            Ok(s) => s,
            Err(_) => return -2,
        };

        let app_type = match CStr::from_ptr(app_type).to_str() {
            Ok(s) => s,
            Err(_) => return -2,
        };

        // Reject invalid new sources before touching the active session.
        // Parsing is read-only; the validated project is used if we become server.
        let candidate = match crate::Project::open_project(project_path) {
            Ok(project) => project,
            Err(_) => return -3,
        };

        // Run async operation
        let result = manager.runtime.block_on(async {
            // Set up client and server implementations
            // Reopening a handle must release the previous listener/registry entry.
            if manager.manager.is_connected().await {
                manager.manager.disconnect().await?;
            }
            // This handle owns its project, unlike Studio's externally shared
            // project. Do not reuse a previous project's state on a second open.
            {
                let project_ref = manager.manager.project_ref();
                let mut project = project_ref.lock().await;
                if let Some(current) = project.as_mut() {
                    current.close_project()?;
                }
                *project = Some(candidate);
            }
            let mut client = MsgPackClient::new();
            client.set_operation_handler(std::sync::Arc::new(
                crate::operation_handler::LocalOperationHandler::new(manager.manager.project_ref()),
            ));
            manager.manager.set_client_impl(Box::new(client)).await;

            // The server uses the same project reference as the manager
            // (A separate Arc would make the server expose an empty project)
            let project_arc = manager.manager.project_ref();
            manager
                .manager
                .set_server_impl(Box::new(MsgPackServer::new(project_arc)));

            manager
                .manager
                .open_project_p2p(project_path, app_type, preferred_port)
                .await
        });

        match result {
            Ok(mode) => {
                // Fill output structure
                match mode {
                    ConnectionMode::Server { listening_addr } => {
                        (*out_info).mode = 0;
                        (*out_info).address = CString::new(listening_addr.to_string())
                            .map(|s| s.into_raw())
                            .unwrap_or(ptr::null_mut());
                        (*out_info).server_address = ptr::null_mut();
                    }
                    ConnectionMode::Client { server_addr } => {
                        (*out_info).mode = 1;
                        (*out_info).address = ptr::null_mut();
                        (*out_info).server_address = CString::new(server_addr.to_string())
                            .map(|s| s.into_raw())
                            .unwrap_or(ptr::null_mut());
                    }
                }
                0 // Success
            }
            Err(_) => -3,
        }
    }
}

/// Find active server for a project
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_find_active_server(
    manager: *mut FfiP2pManager,
    project_path: *const c_char,
    out_info: *mut FFI_ServiceInfo,
) -> i32 {
    if out_info.is_null() {
        return -1;
    }
    unsafe {
        *out_info = FFI_ServiceInfo {
            app_type: ptr::null_mut(),
            project_path: ptr::null_mut(),
            project_uuid: ptr::null_mut(),
            address: ptr::null_mut(),
            last_seen_timestamp: 0,
            is_active: false,
        };
    }
    if manager.is_null() || project_path.is_null() {
        return -1;
    }

    unsafe {
        let manager = &mut *manager;

        let project_path = match CStr::from_ptr(project_path).to_str() {
            Ok(s) => s,
            Err(_) => return -2,
        };

        let Some(service) = manager
            .manager
            .find_active_servers(project_path)
            .into_iter()
            .find(|s| {
                std::net::TcpStream::connect_timeout(
                    &s.address,
                    std::time::Duration::from_millis(250),
                )
                .is_ok()
            })
        else {
            return -4;
        };
        let fields = [
            service.app_type,
            service.project_path,
            service.project_uuid,
            service.address.to_string(),
        ];
        let strings = match fields
            .into_iter()
            .map(CString::new)
            .collect::<Result<Vec<_>, _>>()
        {
            Ok(strings) => strings,
            Err(_) => return -2,
        };
        let mut strings = strings.into_iter();
        (*out_info).app_type = strings.next().unwrap().into_raw();
        (*out_info).project_path = strings.next().unwrap().into_raw();
        (*out_info).project_uuid = strings.next().unwrap().into_raw();
        (*out_info).address = strings.next().unwrap().into_raw();
        (*out_info).last_seen_timestamp = service
            .last_seen
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().min(i64::MAX as u64) as i64)
            .unwrap_or(0);
        (*out_info).is_active = true;
        0
    }
}

/// Promote from client to server
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_promote_to_server(manager: *mut FfiP2pManager) -> i32 {
    if manager.is_null() {
        return -1;
    }

    unsafe {
        let manager = &mut *manager;

        let result = manager
            .runtime
            .block_on(async { manager.manager.promote_to_server().await });

        match result {
            Ok(_) => 0,
            Err(_) => -3,
        }
    }
}

/// Disconnect from P2P
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_disconnect(manager: *mut FfiP2pManager) -> i32 {
    if manager.is_null() {
        return -1;
    }

    unsafe {
        let manager = &mut *manager;
        if !manager.runtime.block_on(manager.manager.is_connected()) {
            return 0;
        }
        match manager.runtime.block_on(manager.manager.disconnect()) {
            Ok(()) => 0,
            Err(_) => -3,
        }
    }
}

/// Check if connected
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_is_connected(manager: *mut FfiP2pManager) -> bool {
    if manager.is_null() {
        return false;
    }

    unsafe {
        let manager = &*manager;
        manager.runtime.block_on(manager.manager.is_connected())
    }
}

/// Get connection mode (0 = Server, 1 = Client, -1 = Not connected)
///
/// # Safety
/// Non-null pointers must be valid for this call. Manager handles must be live
/// and must not be used concurrently. Free returned strings with `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_get_connection_mode(manager: *mut FfiP2pManager) -> i32 {
    if manager.is_null() {
        return -1;
    }

    unsafe {
        let manager = &*manager;
        match manager
            .runtime
            .block_on(manager.manager.get_connection_mode())
        {
            Some(ConnectionMode::Server { .. }) => 0,
            Some(ConnectionMode::Client { .. }) => 1,
            None => -1,
        }
    }
}

/// Execute a canonical operation against this P2P session's project.
/// Client mode forwards requests to the elected server; server mode publishes
/// the resulting committed snapshot to all peers.
///
/// # Safety
/// `manager` must be a live P2P manager pointer with no concurrent calls, and
/// `json` must point to a null-terminated UTF-8 string. Free the result once with
/// `devcel_free_string`.
#[no_mangle]
pub unsafe extern "C" fn p2p_execute_json(
    manager: *mut FfiP2pManager,
    json: *const c_char,
) -> *mut c_char {
    if manager.is_null() || json.is_null() {
        return ptr::null_mut();
    }
    let response = match CStr::from_ptr(json).to_str() {
        Ok(text) => match serde_json::from_str::<crate::operations::DevcelOperation>(text) {
            Ok(operation) => {
                let manager = &*manager;
                manager.runtime.block_on(async {
                    if !manager.manager.is_connected().await {
                        return crate::operations::DevcelResponse::Error(
                            "P2P session is not connected".into(),
                        );
                    }
                    manager.manager.execute_operation(operation).await
                })
            }
            Err(error) => crate::operations::DevcelResponse::Error(
                (format!("Invalid operation JSON: {error}")).into(),
            ),
        },
        Err(error) => crate::operations::DevcelResponse::Error(
            (format!("Invalid operation UTF-8: {error}")).into(),
        ),
    };
    crate::ffi::response_json(&response)
}
