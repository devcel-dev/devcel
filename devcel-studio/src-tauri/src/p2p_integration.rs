use crate::AppError;
use async_trait::async_trait;
use devcel_core::msgpack_client::MsgPackClient;
use devcel_core::msgpack_server::MsgPackServer;
use devcel_core::operation_handler::{LocalOperationHandler, OperationHandler};
use devcel_core::operations::{DevcelOperation, DevcelResponse};
use devcel_core::p2p_manager::{ConnectionMode, P2PManager};
use std::sync::Arc;
use tauri::{Emitter, State};
use tokio::sync::Mutex as AsyncMutex;

/// P2P state management
pub struct P2PState {
    pub manager: Arc<AsyncMutex<P2PManager>>,
}

impl P2PState {
    pub fn new() -> Self {
        Self {
            manager: Arc::new(AsyncMutex::new(P2PManager::new())),
        }
    }
}

/// Handler that applies P2P operations to the local project and emits a
/// "p2p-data-changed" event to the frontend when data changes
/// (Used for both client broadcast reception and server processing of client operations)
struct P2PSyncHandler {
    inner: LocalOperationHandler,
    app_handle: tauri::AppHandle,
    project_session: String,
}

impl P2PSyncHandler {
    async fn is_current_session(&self) -> bool {
        self.inner
            .project
            .lock()
            .await
            .as_ref()
            .is_some_and(|project| project.get_instance_id() == self.project_session)
    }
}

#[async_trait]
impl OperationHandler for P2PSyncHandler {
    async fn apply_server_snapshot(&self, snapshot: serde_json::Value) -> DevcelResponse {
        if !self.is_current_session().await {
            return DevcelResponse::Error(AppError::code("error.staleData", serde_json::json!({})));
        }
        let before_tags = self
            .inner
            .project
            .lock()
            .await
            .as_ref()
            .map(|project| project.project_data.tag_presets.clone());
        let response = self.inner.apply_server_snapshot(snapshot).await;
        if matches!(&response, DevcelResponse::Ok(_)) && self.is_current_session().await {
            let after_tags = self
                .inner
                .project
                .lock()
                .await
                .as_ref()
                .map(|project| project.project_data.tag_presets.clone());
            if before_tags != after_tags {
                let _ = self.app_handle.emit(
                    "project-tags-changed",
                    serde_json::json!({ "project_session": self.project_session }),
                );
            }
            let _ = self.app_handle.emit(
                "p2p-data-changed",
                serde_json::json!({
                    "operation": "SyncProjectState", "table_uuid": null,
                    "project_session": self.project_session,
                }),
            );
        }
        response
    }

    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        if !self.is_current_session().await {
            return DevcelResponse::Error(AppError::code("error.staleData", serde_json::json!({})));
        }
        let is_mutation = !operation.is_read_only();

        // Extract the operation name and table UUID for event notification
        // (DevcelOperation uses adjacent tags: {"op": "OpName", "data": {fields...}})
        let notify_payload = if is_mutation {
            let op_value = serde_json::to_value(&operation).unwrap_or_default();
            let op_name = op_value
                .get("op")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let table_uuid = op_value
                .get("data")
                .and_then(|d| d.get("table_uuid"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            Some(serde_json::json!({
                "operation": op_name,
                "table_uuid": table_uuid,
                "project_session": self.project_session,
            }))
        } else {
            None
        };

        let reload_tags = matches!(operation, DevcelOperation::ReloadProjectTags);
        let response = self.inner.handle_operation(operation).await;
        if reload_tags
            && matches!(&response, DevcelResponse::Ok(value) if value.get("changed").and_then(|v| v.as_bool()) == Some(true))
            && self.is_current_session().await
        {
            let _ = self.app_handle.emit(
                "project-tags-changed",
                serde_json::json!({ "project_session": self.project_session }),
            );
        }

        // Notify the frontend only after successful mutations
        if let (Some(payload), DevcelResponse::Ok(_)) = (notify_payload, &response) {
            if self.is_current_session().await {
                let _ = self.app_handle.emit("p2p-data-changed", payload);
            }
        }

        response
    }
}

/// Open a project in P2P mode
#[tauri::command]
pub async fn open_project_p2p(
    project_path: String,
    state: State<'_, P2PState>,
    project_state: State<'_, crate::state::ProjectState>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    crate::settings_mode::reject_reserved_project_path(
        &app_handle,
        std::path::Path::new(&project_path),
    )?;
    // First open the project synchronously inside spawn_blocking
    // Note: We don't pass project_state into spawn_blocking to avoid lifetime issues
    let project = tokio::task::spawn_blocking({
        let project_path = project_path.clone();
        move || devcel_core::Project::open_project(&project_path)
    })
    .await
    .map_err(AppError::from)?
    .map_err(AppError::from)?;

    // A failed save must leave the current session and connection available.
    // Validate/open the destination first, then persist before disconnecting.
    {
        let mut previous = project_state.project.lock().await;
        if let Some(previous) = previous.as_mut() {
            previous.close_project().map_err(AppError::from)?;
        }
    }
    // Disconnect any existing P2P session first
    // (Prevents old sessions and registry entries from remaining when opening a different project)
    {
        let mut manager = state.manager.lock().await;
        if manager.is_connected().await {
            println!("[P2P] Closing existing P2P session before opening new project...");
            manager.disconnect().await?;
        }
    }

    // Capture the origin before moving the Project. Asynchronous notifications
    // must never acquire a newer session's identity after a project switch.
    let project_session = project.get_instance_id().to_owned();

    // Extract the required Arcs from ProjectState together
    // Async commands access shared handles directly without acquiring the outer std Mutex
    let (project_arc, change_notifier, save_queue) = {
        let state_guard = &*project_state;
        (
            state_guard.project.clone(),
            state_guard.change_notifier.clone(),
            state_guard.save_queue.clone(),
        )
    };

    // Update the unified project reference
    // Note: set_project_sync uses RUNTIME.block_on internally,
    // so calling it from an asynchronous context (an async Tauri command)
    // panics with "Cannot start a runtime from within a runtime"
    let had_project = {
        let mut guard = project_arc.lock().await;
        let had = guard.is_some();
        if let Some(previous) = guard.as_mut() {
            previous.close_project().map_err(AppError::from)?;
        }
        *guard = Some(project);
        had
    };

    // Notify that the project opened, matching set_project behavior
    {
        let notifier_guard = change_notifier.lock().await;
        if let Some(tx) = notifier_guard.as_ref() {
            let event = if had_project {
                crate::state::ProjectChangeEvent::ProjectModified
            } else {
                crate::state::ProjectChangeEvent::ProjectOpened {
                    path: project_path.clone(),
                }
            };
            let _ = tx.send(event).await;
        }
    }

    let mut manager = state.manager.lock().await;

    // Share the GUI's project reference with P2PManager
    // (Otherwise received changes would not affect the project displayed on screen)
    manager.set_project_ref(project_arc.clone());

    // Handler that applies P2P operations locally while notifying the frontend
    let sync_handler = Arc::new(P2PSyncHandler {
        inner: LocalOperationHandler::new(project_arc.clone()),
        app_handle: app_handle.clone(),
        project_session: project_session.clone(),
    });

    // Configure the MessagePack client and server
    // (Use the notifying handler for both broadcasts and client operations)
    let mut client = MsgPackClient::new();
    client.set_operation_handler(sync_handler.clone());
    manager.set_client_impl(Box::new(client)).await;

    let mut server = MsgPackServer::new(project_arc.clone());
    server.set_operation_handler(sync_handler);
    manager.set_server_impl(Box::new(server));

    // Add event listener for P2P state changes
    #[cfg(not(target_os = "android"))]
    {
        let handle = app_handle.clone();
        let listener = Arc::new(crate::p2p_event_listener::TauriP2PEventListener::new(
            handle,
        ));
        manager.add_listener(listener).await;
    }

    // Open the project in P2P mode
    // Use port 0 to let the system choose based on project path
    let mode = manager
        .open_project_p2p(&project_path, "devcel-studio", 0)
        .await?;

    // Register the save listener that propagates local edits to P2P
    // It fires after the table's disk write completes,
    // so receivers can safely reread the file immediately
    {
        if let Some(save_queue) = save_queue {
            let manager_arc = state.manager.clone();
            let project_for_listener = project_arc.clone();
            let app_for_listener = app_handle.clone();
            let listener_session = project_session.clone();
            let listener: devcel_core::file_save_queue::SaveListener =
                Arc::new(move |path: &std::path::Path| {
                    let path = path.to_path_buf();
                    let manager_arc = manager_arc.clone();
                    let project_arc = project_for_listener.clone();
                    let app = app_for_listener.clone();
                    let project_session = listener_session.clone();
                    tauri::async_runtime::spawn(async move {
                        // Resolve the table UUID from the saved file
                        // (Project registry saves use their own metadata refresh operation)
                        let is_project_file = {
                            let guard = project_arc.lock().await;
                            guard.as_ref().is_some_and(|p| {
                                p.get_instance_id() == project_session && p.path == path
                            })
                        };
                        if is_project_file {
                            let manager = manager_arc.lock().await;
                            if project_arc
                                .lock()
                                .await
                                .as_ref()
                                .is_some_and(|p| p.get_instance_id() == project_session)
                            {
                                manager
                                    .propagate_local_change(DevcelOperation::ReloadProjectTags)
                                    .await;
                            }
                            return;
                        }
                        let table_uuid = {
                            let guard = project_arc.lock().await;
                            guard
                                .as_ref()
                                .filter(|p| p.get_instance_id() == project_session)
                                .and_then(|p| p.tables_data.get(&path).map(|t| t.data.uuid.clone()))
                        };
                        if let Some(table_uuid) = table_uuid {
                            let _ = app.emit(
                                "p2p-data-changed",
                                serde_json::json!({
                                    "operation": "TableSaved", "table_uuid": table_uuid,
                                    "project_session": project_session,
                                }),
                            );
                            let manager = manager_arc.lock().await;
                            if project_arc
                                .lock()
                                .await
                                .as_ref()
                                .is_none_or(|p| p.get_instance_id() != project_session)
                            {
                                return;
                            }
                            manager
                                .propagate_local_change(DevcelOperation::ReloadTable { table_uuid })
                                .await;
                        }
                    });
                });
            save_queue.set_save_listener(Some(listener));
        }
    }

    // Interfaces save synchronously and do not pass through the table queue.
    // Bind both propagation and invalidation to the originating project session.
    {
        let manager_arc = state.manager.clone();
        let handle = app_handle.clone();
        let project_for_listener = project_arc.clone();
        let listener_session = project_session.clone();
        let listener: devcel_core::file_save_queue::SaveListener = Arc::new(move |_path| {
            let manager = manager_arc.clone();
            let handle = handle.clone();
            let project_arc = project_for_listener.clone();
            let project_session = listener_session.clone();
            tauri::async_runtime::spawn(async move {
                let manager = manager.lock().await;
                if project_arc
                    .lock()
                    .await
                    .as_ref()
                    .is_none_or(|p| p.get_instance_id() != project_session)
                {
                    return;
                }
                manager
                    .propagate_local_change(DevcelOperation::ReloadInterfaces)
                    .await;
                let _ = handle.emit(
                    "p2p-data-changed",
                    serde_json::json!({
                        "operation": "ReloadInterfaces",
                        "project_session": project_session,
                    }),
                );
            });
        });
        if let Some(project) = project_arc.lock().await.as_mut() {
            if project.get_instance_id() == project_session {
                project.set_interface_change_listener(Some(listener));
            }
        }
    }

    // Set up server disconnection monitoring for clients
    // Monitor in a loop rather than once, to handle further disconnections after failover
    if matches!(mode, ConnectionMode::Client { .. }) {
        if let Some(mut rx) = manager.get_server_disconnection_receiver().await {
            let manager_for_spawn = state.manager.clone();
            tokio::spawn(async move {
                while rx.recv().await.is_some() {
                    println!("Server disconnected, starting failover...");
                    let result = {
                        let mut manager = manager_for_spawn.lock().await;
                        manager.handle_disconnection().await
                    };
                    match result {
                        Ok(_) => println!("Failover completed successfully"),
                        Err(e) => eprintln!("Failover failed: {e}"),
                    }
                }
            });
        }
    }

    // Notify P2P mode change
    {
        let notifier_guard = change_notifier.lock().await;
        if let Some(tx) = notifier_guard.as_ref() {
            let mode_str = match &mode {
                ConnectionMode::Server { .. } => "server",
                ConnectionMode::Client { .. } => "client",
            };
            let _ = tx
                .send(crate::state::ProjectChangeEvent::P2PModeChanged {
                    mode: mode_str.to_string(),
                })
                .await;
        }
    }

    match mode {
        ConnectionMode::Server { listening_addr } => {
            // Started as a server
            println!("Started as P2P server on {listening_addr}");
            Ok(format!(
                r#"{{"mode": "server", "address": "{listening_addr}"}}"#
            ))
        }
        ConnectionMode::Client { server_addr } => {
            // Connected as a client
            println!("Connected to P2P server at {server_addr}");
            Ok(format!(
                r#"{{"mode": "client", "server": "{server_addr}"}}"#
            ))
        }
    }
}

/// Get P2P connection status
#[tauri::command]
pub async fn get_p2p_status(state: State<'_, P2PState>) -> Result<String, AppError> {
    let manager = state.manager.lock().await;

    if let Some(mode) = manager.get_connection_mode().await {
        match mode {
            ConnectionMode::Server { listening_addr } => {
                let connected_clients = manager.connected_client_count().await;
                Ok(format!(
                    r#"{{"connected": true, "mode": "server", "address": "{listening_addr}", "connectedClients": {connected_clients}}}"#
                ))
            }
            ConnectionMode::Client { server_addr } => Ok(format!(
                r#"{{"connected": true, "mode": "client", "server": "{server_addr}"}}"#
            )),
        }
    } else {
        Ok(r#"{"connected": false}"#.to_string())
    }
}

/// Disconnect the P2P connection
#[tauri::command]
pub async fn disconnect_p2p(state: State<'_, P2PState>) -> Result<String, AppError> {
    let mut manager = state.manager.lock().await;

    manager.disconnect().await?;
    Ok("ok".to_string())
}

/// Find active servers
#[tauri::command]
pub async fn find_active_servers(
    project_path: String,
    state: State<'_, P2PState>,
) -> Result<String, AppError> {
    let manager = state.manager.lock().await;

    // Find active servers in the registry
    let active_servers = manager.find_active_servers(&project_path);

    // Convert to JSON format
    let servers_json: Vec<serde_json::Value> = active_servers
        .into_iter()
        .map(|server| {
            serde_json::json!({
                "app_type": server.app_type,
                "project_path": server.project_path,
                "project_uuid": server.project_uuid,
                "address": server.address.to_string(),
                "last_seen": server.last_seen.duration_since(std::time::SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
                "status": match server.status {
                    devcel_core::discovery::ServiceStatus::Active => "active",
                    devcel_core::discovery::ServiceStatus::Client(_) => "client",
                    devcel_core::discovery::ServiceStatus::Inactive => "inactive",
                },
                "connection_order": server.connection_order,
            })
        })
        .collect();

    Ok(serde_json::to_string(&servers_json).unwrap_or_else(|_| "[]".to_string()))
}

/// Switch roles from client to server
#[tauri::command]
pub fn promote_to_server(state: State<'_, P2PState>) -> Result<String, AppError> {
    // Use tokio runtime to run async code in sync function
    let rt = tokio::runtime::Runtime::new().map_err(AppError::from)?;

    rt.block_on(async {
        let mut manager = state.manager.lock().await;
        // Promote to server
        manager.promote_to_server().await?;
        Ok("ok".to_string())
    })
}
