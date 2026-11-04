// Learn about Tauri commands: https://tauri.app/develop/calling-rust/
// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

use tauri::{Emitter, Manager};

// P2P feature module
#[cfg(feature = "p2p")]
mod p2p_event_listener;
#[cfg(feature = "p2p")]
mod p2p_integration;

// Change detection commands
pub mod app_settings;
mod app_settings_store;
mod app_updater;
mod bulk_row_commands;
mod bundled_cli;
mod catalog_transport;
mod change_detection_commands;
mod color_preview;
mod color_swatch_settings;
mod column_type_dialog_commands;
mod command_dispatcher;
mod formula_source_watcher;
mod interface_presentation;
pub mod locale_settings;
mod plugin_catalog;
mod plugin_packages;
mod rule_commands;
mod settings_mode;
mod settings_profile;
mod settings_resources_store;
mod settings_seed;
mod settings_transactions;
mod window_geometry;
use bulk_row_commands::*;
use column_type_dialog_commands::*;
use rule_commands::*;

// The save queue system has moved to devcel-core
// mod save_queue;

// Import from devcel-core instead of local project module
use devcel_core::{
    commands::{check_reference_integrity, get_reference_options},
    json_export::{
        export_project_metadata_as_json, export_table_as_json_in_project_with_validation,
        export_table_metadata_as_json, ExportMode,
    },
    validate_data_name,
    AddColumnCommand,
    AddRecordCommand,
    AddRecordTagCommand,
    DevcelError,
    // Interface-related code
    InsertColumnCommand,
    InsertRecordCommand,
    InterfaceChange,
    MoveColumnCommand,
    Project,
    ProjectEntry,
    ReferenceConfig,
    ReferenceIntegrityCheck,
    ReferenceOption,
    RemoveColumnCommand,
    RemoveRecordCommand,
    RemoveRecordTagCommand,
    RenameColumnCommand,
    RenameTableDataNameCommand,
    RenameTableDisplayNameCommand,
    SetColumnColorCommand,
    SetColumnDefaultValueCommand,
    SetColumnMemoTextCommand,
    SetColumnTooltipCommand,
    SetRecordLabelCommand,
    SetRecordMemoTextCommand,
    SetRecordMinVersionCommand,
    SetRecordParentUuidCommand,
    SetRecordValueCommand,
    TableReference,
    UpdateInterfaceCommand,
    ValueType,
};
use once_cell::sync::Lazy;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

/// Global Tokio runtime for improved performance
static RUNTIME: Lazy<tokio::runtime::Runtime> = Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .expect("Failed to create runtime")
});

pub use devcel_core::AppError;

/// Compare while holding the project lock, before reading or changing its data.
/// Every project-bound caller supplies the identity captured when its work began.
pub(crate) fn ensure_project_session(project: &Project, expected: &str) -> Result<(), AppError> {
    project
        .ensure_tag_transactions_ready()
        .map_err(AppError::from)?;
    if expected != project.get_instance_id() {
        return Err(AppError::code(
            "grid.loading.sessionChanged",
            serde_json::json!({}),
        ));
    }
    Ok(())
}

/// Structure managing application-wide state
/// Wrapped in a Mutex for thread-safe access
pub mod state {
    use super::*;
    use std::sync::Arc;
    use tokio::sync::Mutex as AsyncMutex;

    #[derive(Clone)]
    pub struct ProjectState {
        /// Unified project reference supporting both asynchronous and synchronous access
        pub project: Arc<AsyncMutex<Option<Project>>>,
        /// Project change notification channel
        pub change_notifier: Arc<AsyncMutex<Option<tokio::sync::mpsc::Sender<ProjectChangeEvent>>>>,
        /// Save queue manager
        pub save_queue: Option<Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
    }

    #[derive(Debug, Clone)]
    pub enum ProjectChangeEvent {
        ProjectOpened { path: String },
        ProjectClosed,
        ProjectModified,
        P2PModeChanged { mode: String },
    }

    impl Default for ProjectState {
        fn default() -> Self {
            Self::new()
        }
    }

    impl ProjectState {
        /// Create a ProjectState instance
        pub fn new() -> Self {
            // Create the save queue manager
            let save_queue = Arc::new(
                devcel_core::file_save_queue::FileBasedSaveQueueManager::new(
                    RUNTIME.handle().clone(),
                ),
            );

            Self {
                project: Arc::new(AsyncMutex::new(None)),
                change_notifier: Arc::new(AsyncMutex::new(None)),
                save_queue: Some(save_queue),
            }
        }

        /// Set the project and notify listeners
        pub async fn set_project(&self, project: Option<Project>) -> Result<(), AppError> {
            let mut project_guard = self.project.lock().await;
            let had_project = project_guard.is_some();
            let project_path = project.as_ref().map(|p| p.path.clone());
            *project_guard = project;
            drop(project_guard);

            // Notify listeners of the change
            if let Some(tx) = self.change_notifier.lock().await.as_ref() {
                let event = match (had_project, project_path) {
                    (false, Some(path)) => ProjectChangeEvent::ProjectOpened {
                        path: path.to_string_lossy().to_string(),
                    },
                    (true, None) => ProjectChangeEvent::ProjectClosed,
                    (true, Some(_)) => ProjectChangeEvent::ProjectModified,
                    _ => return Ok(()),
                };
                let _ = tx.send(event).await;
            }

            Ok(())
        }

        /// Synchronously obtain a mutable project reference and run an operation
        pub fn with_project_mut<F, R>(&self, f: F) -> Result<R, AppError>
        where
            F: FnOnce(&mut Option<Project>) -> Result<R, AppError>,
        {
            // Use the global runtime for better performance
            RUNTIME.block_on(async {
                let mut project_guard = self.project.lock().await;
                if let Some(project) = project_guard.as_ref() {
                    project.ensure_tag_transactions_ready()?;
                }
                f(&mut project_guard)
            })
        }

        /// Synchronously obtain a mutable project reference and save queue, then run an operation
        pub fn with_project_mut_save<F, R>(&self, f: F) -> Result<R, AppError>
        where
            F: FnOnce(
                &mut Option<Project>,
                Option<&Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
            ) -> Result<R, AppError>,
        {
            // Use the global runtime for better performance
            RUNTIME.block_on(async {
                let mut project_guard = self.project.lock().await;
                if let Some(project) = project_guard.as_ref() {
                    project.ensure_tag_transactions_ready()?;
                }
                f(&mut project_guard, self.save_queue.as_ref())
            })
        }

        /// Synchronously obtain a read-only project reference and run an operation
        pub fn with_project<F, R>(&self, f: F) -> Result<R, AppError>
        where
            F: FnOnce(&Option<Project>) -> Result<R, AppError>,
        {
            // Use the global runtime for better performance
            RUNTIME.block_on(async {
                let project_guard = self.project.lock().await;
                f(&project_guard)
            })
        }

        /// Obtain a mutable project reference and run an operation with a timeout
        pub fn with_project_mut_timeout<F, R>(&self, timeout_ms: u64, f: F) -> Result<R, AppError>
        where
            F: FnOnce(&mut Option<Project>) -> Result<R, AppError>,
        {
            RUNTIME.block_on(async {
                match tokio::time::timeout(Duration::from_millis(timeout_ms), self.project.lock())
                    .await
                {
                    Ok(mut guard) => f(&mut guard),
                    Err(_) => Err(AppError::owned("Lock acquisition timeout")),
                }
            })
        }

        /// Obtain a read-only project reference and run an operation with a timeout
        pub fn with_project_timeout<F, R>(&self, timeout_ms: u64, f: F) -> Result<R, AppError>
        where
            F: FnOnce(&Option<Project>) -> Result<R, AppError>,
        {
            RUNTIME.block_on(async {
                match tokio::time::timeout(Duration::from_millis(timeout_ms), self.project.lock())
                    .await
                {
                    Ok(guard) => f(&guard),
                    Err(_) => Err(AppError::owned("Lock acquisition timeout")),
                }
            })
        }

        /// Synchronously check whether a project exists
        pub fn has_project_sync(&self) -> bool {
            RUNTIME.block_on(async { self.project.lock().await.is_some() })
        }

        /// Synchronously set the project for Tauri commands
        pub fn set_project_sync(&self, project: Option<Project>) -> Result<(), AppError> {
            RUNTIME.block_on(async { self.set_project(project).await })
        }

        /// Check whether a project is open
        pub async fn has_project(&self) -> bool {
            self.project.lock().await.is_some()
        }

        /// Set the change notification listener
        pub async fn set_change_notifier(&self, tx: tokio::sync::mpsc::Sender<ProjectChangeEvent>) {
            *self.change_notifier.lock().await = Some(tx);
        }
    }
}

use state::ProjectState;

/// Command to check whether a project is open
#[tauri::command]
fn has_project(state: tauri::State<Mutex<ProjectState>>) -> bool {
    let state = state.lock().unwrap();
    state.has_project_sync()
}

/// Command to get the current project's name
#[tauri::command]
fn get_project_name(state: tauri::State<Mutex<ProjectState>>) -> String {
    let state = state.lock().unwrap();
    state
        .with_project_mut(|project_opt| match project_opt {
            Some(project) => Ok(project.get_project_name()),
            None => Ok("".to_string()),
        })
        .unwrap_or_else(|_| "".to_string())
}

/// Command to get the current project's description
#[tauri::command]
fn get_project_description(state: tauri::State<Mutex<ProjectState>>) -> String {
    let state = state.lock().unwrap();
    state
        .with_project_mut(|project_opt| match project_opt {
            Some(project) => Ok(project.get_project_description()),
            None => Ok("".to_string()),
        })
        .unwrap_or_else(|_| "".to_string())
}

/// Command to get the current project's file path
#[tauri::command]
fn get_project_path(state: tauri::State<Mutex<ProjectState>>) -> String {
    let state = state.lock().unwrap();
    state
        .with_project_mut(|project_opt| match project_opt {
            Some(project) => Ok(project.get_project_path()),
            None => Ok("".to_string()),
        })
        .unwrap_or_else(|_| "".to_string())
}

/// Read the identity and metadata atomically so a project switch cannot mix them.
#[tauri::command]
fn get_project_session(
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Option<serde_json::Value>, AppError> {
    state.lock().unwrap().with_project(|project| {
        Ok(project.as_ref().map(|project| {
            serde_json::json!({
                "id": project.get_instance_id(),
                "path": project.get_project_path(),
                "name": project.get_project_name(),
                "description": project.get_project_description(),
                "header_color": project.get_project_header_color(),
            })
        }))
    })
}

/// Command to get the current project's header color
#[tauri::command]
fn get_project_header_color(state: tauri::State<Mutex<ProjectState>>) -> String {
    let state = state.lock().unwrap();
    state
        .with_project_mut(|project_opt| match project_opt {
            Some(project) => Ok(project.get_project_header_color()),
            None => Ok("".to_string()),
        })
        .unwrap_or_else(|_| "".to_string())
}

/// Command to create a project
/// Close an existing open project first
#[tauri::command]
fn create_project(
    name: &str,
    path: &str,
    description: &str,
    header_color: &str,
    state: tauri::State<Mutex<ProjectState>>,
    app: tauri::AppHandle,
) -> Result<String, AppError> {
    settings_mode::reject_reserved_project_path(&app, &std::path::Path::new(path).join(name))?;
    let state = state.lock().unwrap();

    // Close the existing project, if any
    // Close existing project if one exists
    state.with_project_mut(|project_opt| {
        if let Some(project) = project_opt {
            project.close_project().map_err(AppError::from)?;
        }
        Ok(())
    })?;

    // Create a project
    // Create new project
    match Project::create_project(name, path, description, header_color) {
        Ok(project) => {
            // Update unified project reference
            match state.set_project_sync(Some(project)) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(AppError::from(e)),
    }
}

/// Command to open an existing project
/// Close an existing open project first
#[tauri::command]
fn open_project(
    path: &str,
    state: tauri::State<Mutex<ProjectState>>,
    app_handle: tauri::AppHandle,
) -> Result<String, AppError> {
    settings_mode::reject_reserved_project_path(&app_handle, std::path::Path::new(path))?;
    let state_guard = state.lock().unwrap();

    // Close the existing project, if any
    // Close existing project if one exists
    state_guard.with_project_mut(|project_opt| {
        if let Some(project) = project_opt {
            project.close_project().map_err(AppError::from)?;
        }
        Ok(())
    })?;

    // Open the project
    // Open project
    match Project::open_project(path) {
        Ok(project) => {
            // Update unified project reference
            match state_guard.set_project_sync(Some(project)) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(e),
            }
        }
        Err(e) => Err(AppError::from(e)),
    }
}

/// Command to delete the current project
/// Permanently delete the project file and directory
#[tauri::command]
fn delete_project(state: tauri::State<Mutex<ProjectState>>) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            let result = project.delete_project();
            match result {
                Ok(_) => {
                    *project_opt = None;
                    Ok("ok".to_string())
                }
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Command to rename the current project
#[tauri::command]
fn rename_project(
    new_name: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            let result = project.rename_project(new_name);
            match result {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Command to save the current project
/// Write all changes to disk
#[tauri::command]
fn save_project(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            // Notify P2P after direct saves, including Undo/Redo, complete.
            // Ordinary edits are already queued and have their dirty flag cleared, so do not notify twice.
            let saved_paths: Vec<_> = project
                .tables_data
                .iter()
                .filter(|(_, table)| table.is_dirty)
                .map(|(path, _)| path.clone())
                .collect();
            let result = if let Some(queue) = save_queue {
                queue.save_directly(|| {
                    let result = project.save_project();
                    // save_project clears dirty flags only for successfully saved tables.
                    // Protect tables already saved even if a later table fails.
                    let completed_paths = saved_paths
                        .into_iter()
                        .filter(|path| {
                            project
                                .tables_data
                                .get(path)
                                .is_some_and(|table| !table.is_dirty)
                        })
                        .collect();
                    (result, completed_paths)
                })
            } else {
                project.save_project()
            };
            match result {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Command to close the current project
/// Remove it from memory and clear state
#[tauri::command]
fn close_project(state: tauri::State<Mutex<ProjectState>>) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => match project.close_project() {
            Ok(_) => {
                *project_opt = None;
                Ok("ok".to_string())
            }
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn create_table(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<CreatedFile, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| {
        let Some(project) = project_opt else {
            return Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ));
        };
        ensure_project_session(project, &expected_project_session)?;
        let path = validate_create_path(path, FileType::Table)?;
        let created_path = project
            .create_table(PathBuf::from(path))
            .map_err(AppError::from)?;
        let table_uuid = project
            .tables_data
            .get(&created_path)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?
            .data
            .uuid
            .clone();
        initialize_table_contents(project, &table_uuid, save_queue)?;
        created_file(project, &created_path, FileType::Table, Some(table_uuid))
    })
}

/// Resolve UUID and delete under one project lock; no stale frontend path lookup.
#[tauri::command]
fn delete_plugin_table(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    state.lock().unwrap().with_project_mut(|project| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let table = project
            .get_table_catalog()?
            .into_iter()
            .find(|table| table.uuid == table_uuid)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        project
            .delete_table(PathBuf::from(table.path))
            .map_err(AppError::from)
    })?;
    let _ = app_handle.emit(
        "formula-sources-changed",
        serde_json::json!({ "project_session": expected_project_session }),
    );
    Ok(())
}

fn initialize_table_contents(
    project: &mut devcel_core::Project,
    table_uuid: &str,
    save_queue: Option<&std::sync::Arc<devcel_core::file_save_queue::FileBasedSaveQueueManager>>,
) -> Result<(), AppError> {
    let table_uuid = table_uuid.to_string();
    let record_uuid = uuid::Uuid::new_v4().to_string();
    let columns = [
        ("ID", "1", uuid::Uuid::new_v4().to_string()),
        ("Name", "sample", uuid::Uuid::new_v4().to_string()),
    ];
    project
        .execute_transaction(
            "Initial data for the new table".into(),
            |transaction| {
                for (name, _, column_uuid) in &columns {
                    transaction.add_command(std::sync::Arc::new(Mutex::new(
                        AddColumnCommand::new(
                            table_uuid.clone(),
                            name,
                            ValueType::String,
                            None,
                            None,
                            None,
                        )
                        .with_column_uuid(column_uuid.clone()),
                    )));
                }
                transaction.add_command(std::sync::Arc::new(Mutex::new(
                    AddRecordCommand::with_uuid(table_uuid.clone(), record_uuid.clone()),
                )));
                for (_, value, column_uuid) in &columns {
                    transaction.add_command(std::sync::Arc::new(Mutex::new(
                        SetRecordValueCommand::new(
                            table_uuid.clone(),
                            record_uuid.clone(),
                            column_uuid.clone(),
                            (*value).into(),
                        ),
                    )));
                }
                Ok(())
            },
            save_queue,
        )
        .map_err(AppError::from)
}

#[tauri::command]
fn initialize_empty_table(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let path = project
            .resolve_table_path(&PathBuf::from(path))
            .map_err(AppError::from)?;
        if !project.tables_data.contains_key(&path) {
            project.load_table(&path).map_err(AppError::from)?;
        }
        let table = project
            .tables_data
            .get(&path)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        if !table.data.schema.columns.is_empty() || !table.data.records.is_empty() {
            return Err(AppError::owned("Only empty tables can be initialized"));
        }
        let uuid = table.data.uuid.clone();
        initialize_table_contents(project, &uuid, save_queue)?;
        Ok("ok".into())
    })
}

// Internal use only, called from file_operation
fn delete_table(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.delete_table(PathBuf::from(path)) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn move_table(
    path: &str,
    new_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<CreatedFile, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project_opt, queue| {
            let project = project_opt
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            // Validate the result contract before mutation, never after committing a
            // destination that cannot be represented by the frontend's relative path.
            let requested = project
                .resolve_table_path(&PathBuf::from(new_path))
                .map_err(AppError::from)?;
            created_file(project, &requested, FileType::Table, None)?;
            let destination = project
                .move_table_with_save_queue(PathBuf::from(path), PathBuf::from(new_path), queue)
                .map_err(AppError::from)?;
            let uuid = project
                .tables_data
                .get(&destination)
                .map(|table| table.data.uuid.clone());
            created_file(project, &destination, FileType::Table, uuid)
        })
}

// Internal use only, called from file_operation
fn rename_table(
    path: &str,
    new_name: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project_opt, queue| {
            let project = project_opt
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            project
                .rename_table_file(std::path::Path::new(path), new_name, queue)
                .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

#[tauri::command]
fn get_loaded_tables(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Vec<TableReference>, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.get_loaded_tables_list() {
            Ok(tables) => Ok(tables),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn get_project_entries(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Vec<ProjectEntry>, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            project.get_project_entries().map_err(AppError::from)
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn reload_table(uuid: &str, state: tauri::State<Mutex<ProjectState>>) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => {
            match project.reload_table_with_save_queue(uuid, save_queue.map(|v| &**v)) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn get_table_history_status(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<serde_json::Value, AppError> {
    state.lock().unwrap().with_project(|project| {
        let project = project.as_ref().ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let table = project.find_table_by_uuid(table_uuid).ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        Ok(serde_json::json!({ "canUndo": !table.undo_history.is_empty(), "canRedo": !table.redo_history.is_empty() }))
    })
}

#[tauri::command]
fn undo_command(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        // Recheck under the same project lock as replay: a stale UI/shortcut
        // may have consumed the final entry. Other replay errors remain errors.
        Some(project)
            if project
                .find_table_by_uuid(table_uuid)
                .is_some_and(|table| table.undo_history.is_empty()) =>
        {
            Ok("empty".into())
        }
        Some(project) => match project.undo_command(table_uuid) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn redo_command(
    table_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        // Recheck under the same project lock as replay: a stale UI/shortcut
        // may have consumed the final entry. Other replay errors remain errors.
        Some(project)
            if project
                .find_table_by_uuid(table_uuid)
                .is_some_and(|table| table.redo_history.is_empty()) =>
        {
            Ok("empty".into())
        }
        Some(project) => match project.redo_command(table_uuid) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn clear_table_undo_redo_stacks(
    table_uuid: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => match project.clear_table_undo_redo_stacks(table_uuid) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Preserve the named invoke arguments; group-changing them breaks existing UI/plugin clients.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_column(
    table_uuid: &str,
    column_name: &str,
    column_type: &str,
    tooltip: Option<String>,
    color: Option<String>,
    default_value: Option<String>,
    curve_config: Option<devcel_core::types::CurveConfig>,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    // Validate column name
    if let Err(e) = validate_data_name(column_name) {
        return Err(AppError::from(e));
    }

    // Convert string to ValueType
    // Validate and convert type names defined by the core value_type_from_string function.
    let value_type = devcel_core::operations::value_type_from_string(column_type)?;

    let command_data = AddColumnCommand::new(
        table_uuid.to_string(),
        column_name,
        value_type,
        tooltip,
        color,
        default_value,
    )
    .with_curve_config(curve_config);

    let state = state.lock().unwrap();
    let result = state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => {
            // Get the table's column count before executing the command
            let columns_before = project
                .tables_data
                .values()
                .find(|t| t.data.uuid == table_uuid)
                .map(|t| t.data.schema.columns.len())
                .unwrap_or(0);

            match project.execute_command(command_data, save_queue) {
                Ok(_) => {
                    // Find the newly added column
                    if let Some(table) = project
                        .tables_data
                        .values()
                        .find(|t| t.data.uuid == table_uuid)
                    {
                        if table.data.schema.columns.len() > columns_before {
                            // Return the UUID of the last added column
                            if let Some(new_column) = table.data.schema.columns.last() {
                                return Ok(new_column.uuid.clone());
                            }
                        }
                    }
                    Ok("ok".to_string())
                }
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    });

    result
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn insert_column(
    table_uuid: &str,
    column_name: &str,
    column_type: &str,
    insert_index: usize,
    tooltip: Option<String>,
    color: Option<String>,
    default_value: Option<String>,
    curve_config: Option<devcel_core::types::CurveConfig>,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    // Validate column name
    if let Err(e) = validate_data_name(column_name) {
        return Err(AppError::from(e));
    }

    // Convert string to ValueType
    // Validate and convert type names defined by the core value_type_from_string function.
    let value_type = devcel_core::operations::value_type_from_string(column_type)?;

    let command_data = InsertColumnCommand::new(
        table_uuid.to_string(),
        column_name,
        value_type,
        insert_index,
        tooltip,
        color,
        default_value,
    )
    .with_curve_config(curve_config);

    let state = state.lock().unwrap();
    let result = state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => {
            // Record the table's column IDs before executing the command
            let columns_before: Vec<String> = project
                .tables_data
                .values()
                .find(|t| t.data.uuid == table_uuid)
                .map(|t| {
                    t.data
                        .schema
                        .columns
                        .iter()
                        .map(|c| c.uuid.clone())
                        .collect()
                })
                .unwrap_or_default();

            match project.execute_command(command_data, save_queue) {
                Ok(_) => {
                    // Find the newly inserted column
                    if let Some(table) = project
                        .tables_data
                        .values()
                        .find(|t| t.data.uuid == table_uuid)
                    {
                        for column in &table.data.schema.columns {
                            if !columns_before.contains(&column.uuid) {
                                return Ok(column.uuid.clone());
                            }
                        }
                    }
                    Ok("ok".to_string())
                }
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    });

    result
}

#[tauri::command]
fn remove_column(
    table_uuid: &str,
    column_uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = RemoveColumnCommand::new(table_uuid.to_string(), column_uuid.to_string());

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn rename_column(
    table_uuid: &str,
    column_uuid: &str,
    new_name: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    // Validate new column name
    if let Err(e) = validate_data_name(new_name) {
        return Err(AppError::from(e));
    }

    let command_data =
        RenameColumnCommand::new(table_uuid.to_string(), column_uuid.to_string(), new_name);

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Move a table column to any position (free column reordering).
/// new_index is the zero-based target index in the resulting schema array.
#[tauri::command]
fn move_column(
    table_uuid: &str,
    column_uuid: &str,
    new_index: usize,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data =
        MoveColumnCommand::new(table_uuid.to_string(), column_uuid.to_string(), new_index);

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Read the complete schema without replacing live table state or history.
#[tauri::command]
fn load_column_editor(
    target: devcel_core::column_editor::EditorTarget,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::column_editor::EditorContext, AppError> {
    state.lock().unwrap().with_project(|project| {
        let project = project
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        devcel_core::column_editor::load(project, &target).map_err(AppError::from)
    })
}

#[tauri::command]
fn preview_column_editor(
    request: devcel_core::column_editor::EditorRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::column_editor::EditorPreview, AppError> {
    state.lock().unwrap().with_project(|project| {
        let project = project
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        devcel_core::column_editor::preview(project, &request).map_err(AppError::from)
    })
}

#[tauri::command]
fn save_column_editor(
    request: devcel_core::column_editor::EditorRequest,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::column_editor::EditorSaved, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            devcel_core::column_editor::save(project, request, save_queue).map_err(AppError::from)
        })
}

#[tauri::command]
fn set_column_tooltip(
    table_uuid: &str,
    column_uuid: &str,
    tooltip: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetColumnTooltipCommand::new(
        table_uuid.to_string(),
        column_uuid.to_string(),
        tooltip.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_column_memo_text(
    table_uuid: &str,
    column_uuid: &str,
    memo_text: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetColumnMemoTextCommand::new(
        table_uuid.to_string(),
        column_uuid.to_string(),
        memo_text.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_column_default_value(
    table_uuid: &str,
    column_uuid: &str,
    default_value: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetColumnDefaultValueCommand::new(
        table_uuid.to_string(),
        column_uuid.to_string(),
        default_value.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn rename_table_display_name(
    table_uuid: &str,
    new_name: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = RenameTableDisplayNameCommand::new(table_uuid.to_string(), new_name);

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn rename_table_data_name(
    table_uuid: &str,
    new_name: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    // Validate new table data name
    if let Err(e) = validate_data_name(new_name) {
        return Err(AppError::from(e));
    }

    let command_data =
        RenameTableDataNameCommand::new(table_uuid.to_string(), new_name.to_string());

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn add_record(
    table_uuid: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = AddRecordCommand::new(table_uuid.to_string());

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn insert_record(
    table_uuid: &str,
    index: usize,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = InsertRecordCommand::new(table_uuid.to_string(), index);

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn delete_record(
    table_uuid: &str,
    record_uuid: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = RemoveRecordCommand::new(table_uuid.to_string(), record_uuid.to_string());

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_record_value(
    table_uuid: &str,
    record_uuid: &str,
    column_uuid: &str,
    new_value: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetRecordValueCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        column_uuid.to_string(),
        new_value.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_cell_formula(
    table_uuid: &str,
    record_uuid: &str,
    column_name: &str,
    formula: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            let column_uuid = project
                .find_table_by_uuid(table_uuid)
                .and_then(|table| {
                    table.data.schema.columns.iter().find(|column| {
                        column.data_name == column_name || column.uuid == column_name
                    })
                })
                .map(|column| column.uuid.clone())
                .ok_or_else(|| AppError::code("error.columnMissing", serde_json::json!({})))?;
            project
                .execute_command(
                    SetRecordValueCommand::new(
                        table_uuid.into(),
                        record_uuid.into(),
                        column_uuid,
                        formula.into(),
                    ),
                    queue,
                )
                .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

#[tauri::command]
fn set_record_label(
    table_uuid: &str,
    record_uuid: &str,
    new_label: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetRecordLabelCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        new_label.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_record_memo_text(
    table_uuid: &str,
    record_uuid: &str,
    column_uuid: &str,
    new_memo_text: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetRecordMemoTextCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        column_uuid.to_string(),
        new_memo_text.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_record_min_version(
    table_uuid: &str,
    record_uuid: &str,
    new_min_version: u32,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetRecordMinVersionCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        new_min_version,
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_record_parent_uuid(
    table_uuid: &str,
    record_uuid: &str,
    new_parent_uuid: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetRecordParentUuidCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        new_parent_uuid.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn add_record_tag(
    table_uuid: &str,
    record_uuid: &str,
    tag: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = AddRecordTagCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        tag.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn remove_record_tag(
    table_uuid: &str,
    record_uuid: &str,
    tag: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = RemoveRecordTagCommand::new(
        table_uuid.to_string(),
        record_uuid.to_string(),
        tag.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn set_column_color(
    table_uuid: &str,
    column_uuid: &str,
    new_color: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let command_data = SetColumnColorCommand::new(
        table_uuid.to_string(),
        column_uuid.to_string(),
        new_color.to_string(),
    );

    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| match project_opt {
        Some(project) => match project.execute_command(command_data, save_queue) {
            Ok(()) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn read_markdown_file(
    file_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    devcel_core::utils::validate_markdown_path(std::path::Path::new(file_path))
        .map_err(AppError::from)?;
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let full_path = match project.resolve_table_path(&PathBuf::from(file_path)) {
                Ok(path) => path,
                Err(e) => return Err(AppError::from(e)),
            };

            match std::fs::read_to_string(&full_path) {
                Ok(content) => Ok(content),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn write_markdown_file(
    app: tauri::AppHandle,
    file_path: &str,
    content: &str,
    expected_content: String,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    devcel_core::utils::validate_markdown_path(std::path::Path::new(file_path))
        .map_err(AppError::from)?;
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let full_path = match project.resolve_table_path(&PathBuf::from(file_path)) {
                Ok(path) => path,
                Err(e) => return Err(AppError::from(e)),
            };

            {
                let current = std::fs::read_to_string(&full_path).map_err(AppError::from)?;
                if current != expected_content {
                    return Err(AppError::code(
                        "grid.markdownChanged",
                        serde_json::json!({}),
                    ));
                }
            }
            let write = (|| -> std::io::Result<()> {
                use std::io::Write;
                let metadata = std::fs::symlink_metadata(&full_path)?;
                if !metadata.is_file() {
                    return Err(std::io::Error::other("markdown target is not a file"));
                }
                let parent = full_path
                    .parent()
                    .ok_or_else(|| std::io::Error::other("markdown parent not found"))?;
                let mut temporary = tempfile::Builder::new()
                    .prefix(".devcel-write-")
                    .suffix(".tmp")
                    .rand_bytes(16)
                    .tempfile_in(parent)?;
                temporary
                    .as_file()
                    .set_permissions(metadata.permissions())?;
                temporary.write_all(content.as_bytes())?;
                temporary.as_file().sync_all()?;
                temporary.persist(&full_path).map_err(|error| error.error)?;
                Ok(())
            })();
            match write {
                Ok(_) => {
                    let _ = app.emit("markdown-saved", serde_json::json!({"path": file_path}));
                    Ok("ok".to_string())
                }
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn get_table_list(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Vec<TableReference>, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.get_loaded_tables_list() {
            Ok(tables) => Ok(tables),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

static CATALOG_SLOTS: Lazy<std::sync::Arc<tokio::sync::Semaphore>> =
    Lazy::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));

async fn read_table_catalog(
    project: std::sync::Arc<tokio::sync::Mutex<Option<Project>>>,
    expected_session: String,
    interface: Option<uuid::Uuid>,
    display_only: bool,
) -> Result<Vec<TableReference>, AppError> {
    let slot = CATALOG_SLOTS
        .clone()
        .acquire_owned()
        .await
        .map_err(AppError::technical)?;
    let (session, reader) = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        if expected_session != project.get_instance_id() {
            return Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ));
        }
        let reader: Box<dyn FnOnce() -> devcel_core::Result<Vec<TableReference>> + Send> =
            match interface {
                Some(uuid) => Box::new(project.get_tables_for_interface_reader(uuid)),
                None if display_only => Box::new(project.get_table_display_catalog_reader()),
                None => Box::new(project.get_table_catalog_reader()),
            };
        (project.get_instance_id().to_owned(), reader)
    };
    let entries = tokio::task::spawn_blocking(move || {
        let _slot = slot;
        reader().map_err(AppError::from)
    })
    .await
    .map_err(AppError::from)??;
    let guard = project.lock().await;
    if guard.as_ref().map(Project::get_instance_id) != Some(session.as_str()) {
        return Err(AppError::code(
            "grid.loading.sessionChanged",
            serde_json::json!({}),
        ));
    }
    Ok(entries)
}

/// Explicit discovery for reference pickers. Never used for startup or polling.
#[tauri::command]
async fn get_table_catalog(
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<TableReference>, AppError> {
    let project = { state.project.clone() };
    read_table_catalog(project, expected_project_session, None, false).await
}

/// Display labels are record-free and resilient to unrelated malformed files.
#[tauri::command]
async fn get_table_display_catalog(
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<TableReference>, AppError> {
    read_table_catalog(state.project.clone(), expected_project_session, None, true).await
}

static TABLE_LOADS: Lazy<devcel_core::table_loading::TableLoadCoordinator> =
    Lazy::new(|| devcel_core::table_loading::TableLoadCoordinator::new(2));

#[tauri::command]
async fn load_table(
    path: String,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    let (project, queue) = {
        let state = &*state;
        (state.project.clone(), state.save_queue.clone())
    };
    TABLE_LOADS
        .ensure_loaded(
            project,
            queue,
            PathBuf::from(path),
            Some(expected_project_session),
        )
        .await
        .map(|_| "ok".to_string())
}

#[tauri::command]
async fn load_tables_batch(
    paths: Vec<String>,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<Result<String, AppError>>, AppError> {
    let (project, queue) = {
        let state = &*state;
        (state.project.clone(), state.save_queue.clone())
    };
    let session = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        let session = project.get_instance_id().to_owned();
        if expected_project_session != session {
            return Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ));
        }
        session
    };
    // Yield between tables. Demand loads can use the other IO slot; this API
    // cannot monopolize the project lock or destructively reload live tables.
    let mut results = Vec::with_capacity(paths.len());
    for path in paths {
        results.push(
            TABLE_LOADS
                .ensure_loaded(
                    project.clone(),
                    queue.clone(),
                    PathBuf::from(path),
                    Some(session.clone()),
                )
                .await
                .map(|_| "ok".to_string()),
        );
        tokio::task::yield_now().await;
    }
    Ok(results)
}

#[tauri::command]
fn get_table_data(
    uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::TableData, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(uuid)
                .map_err(AppError::from)?;
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    return Ok(table.data.clone());
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Formula completion transfers schema metadata only; it never evaluates a draft.
#[tauri::command]
fn get_formula_completion_schema(
    uuid: Option<String>,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<serde_json::Value, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        read_formula_completion_schema(project, uuid, &expected_project_session)
    })
}

fn read_formula_completion_schema(
    project: &mut Project,
    uuid: Option<String>,
    expected_project_session: &str,
) -> Result<serde_json::Value, AppError> {
    ensure_project_session(project, expected_project_session)?;
    let table = if let Some(id) = uuid.as_ref().and_then(|id| id.strip_prefix("interface:")) {
        let id = uuid::Uuid::parse_str(id).map_err(AppError::from)?;
        let interface = project
            .get_interface(&id)
            .ok_or_else(|| AppError::code("interface.api.notFound", serde_json::json!({})))?;
        Some(serde_json::json!({
            "uuid": format!("interface:{id}"), "data_name": interface.name,
            "display_name": interface.name, "columns": interface.columns, "isInterface": true
        }))
    } else if let Some(uuid) = uuid {
        project
            .ensure_table_loaded_by_uuid(&uuid)
            .map_err(AppError::from)?;
        let table = project
            .tables_data
            .values()
            .find(|table| table.data.uuid == uuid)
            .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
        Some(serde_json::json!({
            "uuid": table.data.uuid, "data_name": table.data.metadata.data_name,
            "display_name": table.data.display_name, "columns": table.data.schema.columns
        }))
    } else {
        None
    };
    Ok(
        serde_json::json!({ "functions": devcel_core::formula_engine::BUILTIN_FUNCTIONS, "table": table }),
    )
}

#[cfg(test)]
mod formula_completion_tests {
    use super::*;

    #[test]
    fn schema_is_session_bound_record_free_and_refreshes_without_draft_evaluation() {
        let root = std::env::temp_dir().join(format!("devcel-completion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut project =
            Project::create_project("Probe", root.to_str().unwrap(), "", "#123456").unwrap();
        let path = project.create_table("Probe.table.toml".into()).unwrap();
        let id = project.tables_data[&path].data.uuid.clone();
        let session = project.get_instance_id().to_owned();
        assert!(read_formula_completion_schema(&mut project, None, "old-session").is_err());
        assert!(
            read_formula_completion_schema(&mut project, Some(id.clone()), "old-session").is_err()
        );
        assert!(
            read_formula_completion_schema(&mut project, Some("missing".into()), &session).is_err()
        );
        assert!(read_formula_completion_schema(
            &mut project,
            Some("interface:invalid".into()),
            &session
        )
        .is_err());
        let before = serde_json::to_value(&project.tables_data[&path].data).unwrap();
        let value =
            read_formula_completion_schema(&mut project, Some(id.clone()), &session).unwrap();
        assert_eq!(value["table"]["uuid"], id);
        assert_eq!(value["table"]["columns"], before["schema"]["columns"]);
        assert!(value["table"].get("records").is_none());
        assert_eq!(value["table"].as_object().unwrap().len(), 4);
        assert_eq!(
            serde_json::to_value(&project.tables_data[&path].data).unwrap(),
            before
        );
        project
            .tables_data
            .get_mut(&path)
            .unwrap()
            .data
            .display_name = "Renamed".into();
        let updated = read_formula_completion_schema(&mut project, Some(id), &session).unwrap();
        assert_eq!(updated["table"]["display_name"], "Renamed");
        let functions = read_formula_completion_schema(&mut project, None, &session).unwrap();
        assert!(functions["table"].is_null());
        assert_eq!(
            functions["functions"],
            serde_json::json!(devcel_core::formula_engine::BUILTIN_FUNCTIONS)
        );
        drop(project);
        std::fs::remove_dir_all(root).unwrap();
    }
}

/// The lifecycle keeps its existing serialized snapshot for delete events. Polls
/// only transfer a replacement when the authoritative, session-bound revision
/// changed; no native table cache or second project snapshot is introduced.
#[derive(serde::Serialize)]
struct PluginTableSnapshot {
    revision: String,
    data: String,
}

#[tauri::command]
fn get_plugin_table_snapshot(
    uuid: &str,
    expected_project_session: String,
    known_revision: Option<String>,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Option<PluginTableSnapshot>, AppError> {
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        read_plugin_table_snapshot(
            project,
            uuid,
            &expected_project_session,
            known_revision.as_deref(),
        )
    })
}

fn read_plugin_table_snapshot(
    project: &mut Project,
    uuid: &str,
    expected_session: &str,
    known_revision: Option<&str>,
) -> Result<Option<PluginTableSnapshot>, AppError> {
    ensure_project_session(project, expected_session)?;
    project
        .ensure_table_loaded_by_uuid(uuid)
        .map_err(AppError::from)?;
    let table = project
        .find_table_by_uuid(uuid)
        .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;
    let revision = devcel_core::cell_rules::revision(&table.data);
    if known_revision == Some(revision.as_str()) {
        return Ok(None);
    }
    let data = serde_json::to_string(&table.data).map_err(AppError::from)?;
    Ok(Some(PluginTableSnapshot { revision, data }))
}

#[cfg(test)]
mod plugin_snapshot_tests {
    use super::*;
    #[test]
    fn conditional_snapshot_preserves_payload_and_checks_session_before_null() {
        let root =
            std::env::temp_dir().join(format!("devcel-plugin-read-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut project =
            Project::create_project("Probe", root.to_str().unwrap(), "", "#123456").unwrap();
        let path = project.create_table("Probe.table.toml".into()).unwrap();
        let id = project.tables_data[&path].data.uuid.clone();
        let session = project.get_instance_id().to_owned();
        let first = read_plugin_table_snapshot(&mut project, &id, &session, None)
            .unwrap()
            .unwrap();
        assert_eq!(
            first.data,
            serde_json::to_string(&project.tables_data[&path].data).unwrap()
        );
        assert!(
            read_plugin_table_snapshot(&mut project, &id, &session, Some(&first.revision))
                .unwrap()
                .is_none()
        );
        assert!(read_plugin_table_snapshot(
            &mut project,
            &id,
            "different-session",
            Some(&first.revision)
        )
        .is_err());
        project.tables_data.get_mut(&path).unwrap().data.description = "changed".into();
        let changed =
            read_plugin_table_snapshot(&mut project, &id, &session, Some(&first.revision))
                .unwrap()
                .unwrap();
        assert_ne!(first.revision, changed.revision);
        assert_eq!(
            changed.data,
            serde_json::to_string(&project.tables_data[&path].data).unwrap()
        );
        assert!(
            read_plugin_table_snapshot(&mut project, &id, &session, Some(&changed.revision))
                .unwrap()
                .is_none()
        );
        drop(project);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[tauri::command]
async fn get_table_data_batch(
    uuids: Vec<String>,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<Result<String, AppError>>, AppError> {
    let project = { state.project.clone() };
    let guard = project.lock_owned().await;
    tokio::task::spawn_blocking(move || {
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        Ok(uuids
            .into_iter()
            .map(|uuid| {
                let data = project
                    .read_table_data_by_uuid(&uuid)
                    .map_err(AppError::from)?;
                serde_json::to_string(&data).map_err(AppError::from)
            })
            .collect())
    })
    .await
    .map_err(AppError::from)?
}

#[tauri::command]
fn get_table_data_range(
    uuid: &str,
    start_row: usize,
    end_row: usize,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            project
                .ensure_table_loaded_by_uuid(uuid)
                .map_err(AppError::from)?;
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    let total_records = table.data.records.len();

                    let end_index = std::cmp::min(end_row, total_records);
                    let records_slice = if start_row < total_records {
                        &table.data.records[start_row..end_index]
                    } else {
                        &[]
                    };

                    let response = serde_json::json!({
                        "metadata": table.data.metadata,
                        "columns": table.data.schema.columns,
                        "records": records_slice,
                        "total_record_count": total_records,
                        "start_row": start_row,
                        "end_row": end_index
                    });

                    match serde_json::to_string(&response) {
                        Ok(json) => return Ok(json),
                        Err(e) => {
                            return Err(AppError::code(
                                "error.parse",
                                serde_json::json!({ "details": e.to_string() }),
                            ))
                        }
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
async fn get_table_path_by_uuid(
    expected_project_session: String,
    table_uuid: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    let project = { state.project.clone() };
    let session = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        if let Some((path, _)) = project
            .tables_data
            .iter()
            .find(|(_, t)| t.data.uuid == table_uuid)
        {
            return Ok(path.to_string_lossy().into_owned());
        }
        project.get_instance_id().to_owned()
    };
    read_table_catalog(project, session, None, false)
        .await?
        .into_iter()
        .find(|t| t.uuid == table_uuid)
        .map(|t| t.path)
        .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))
}

#[tauri::command]
fn get_table_data_by_uuids(
    table_uuid: &str,
    record_uuids: Vec<String>,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            project
                .ensure_table_loaded_by_uuid(table_uuid)
                .map_err(AppError::from)?;
            for table in project.tables_data.values() {
                if table.data.uuid == table_uuid {
                    let mut filtered_records = Vec::new();

                    for record in &table.data.records {
                        if record_uuids.contains(&record.uuid) {
                            filtered_records.push(record);
                        }
                    }

                    let response = serde_json::json!({
                        "metadata": table.data.metadata,
                        "columns": table.data.schema.columns,
                        "records": filtered_records,
                        "total_record_count": table.data.records.len(),
                        "filtered_count": filtered_records.len()
                    });

                    match serde_json::to_string(&response) {
                        Ok(json) => return Ok(json),
                        Err(e) => {
                            return Err(AppError::code(
                                "error.parse",
                                serde_json::json!({ "details": e.to_string() }),
                            ))
                        }
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn get_interfaces(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            // Collect only basic interface information
            let interfaces: Vec<serde_json::Value> = project
                .interface_registry
                .get_all_interfaces()
                .into_iter()
                .map(|interface| {
                    serde_json::json!({
                        "uuid": interface.uuid.to_string(),
                        "name": interface.name,
                        "description": interface.description,
                    })
                })
                .collect();

            Ok(serde_json::to_string(&interfaces).unwrap())
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn check_and_apply_interface_updates(
    uuid: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project_opt, queue| {
            let project = project_opt
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            let changed =
                devcel_core::table_mutation::sync_pending_interface_updates(project, uuid, queue)
                    .map_err(AppError::from)?;
            Ok(if changed {
                "updates_applied"
            } else {
                "no_updates"
            }
            .to_string())
        })
}

#[tauri::command]
fn get_project_tags(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::project_tags::TagState, AppError> {
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        Ok(devcel_core::project_tags::state(project))
    })
}

#[tauri::command]
fn get_project_tag_usage(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<devcel_core::project_tags::TagUsageResult, AppError> {
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        devcel_core::project_tags::usage(project).map_err(AppError::from)
    })
}

#[tauri::command]
fn update_project_tag(
    operation: devcel_core::project_tags::TagOperation,
    name: String,
    new_name: Option<String>,
    expected_revision: String,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    app: tauri::AppHandle,
) -> Result<devcel_core::project_tags::TagUpdateResult, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project_opt, queue| {
            let project = project_opt
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            let result = devcel_core::project_tags::update(
                project,
                devcel_core::project_tags::TagUpdateRequest {
                    operation,
                    name: &name,
                    new_name: new_name.as_deref(),
                    expected_revision: &expected_revision,
                    expected_session: &expected_project_session,
                },
                queue,
                |progress| {
                    use tauri::Emitter;
                    let _ = app.emit("project-tag-progress", progress);
                },
            )
            .map_err(AppError::from)?;
            use tauri::Emitter;
            let _ = app.emit(
                "project-tags-changed",
                serde_json::json!({ "project_session": expected_project_session }),
            );
            Ok(result)
        })
}

/// Save the editor snapshot as one session-fenced transaction. No intermediate
/// command may target a project opened while the separate editor was on screen.
#[tauri::command]
fn update_project_info(
    description: &str,
    color: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<(), AppError> {
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let previous = project.project_data.clone();
        project.project_data.project_description = description.to_string();
        project.project_data.color = color.to_string();
        if let Err(error) = project.save_project() {
            project.project_data = previous;
            return Err(AppError::from(error));
        }
        Ok(())
    })
}

#[tauri::command]
fn export_table_data(
    uuid: &str,
    format: &str,
    output_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            formula_source_watcher::check_source_error(&expected_project_session)?;
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    match format {
                        "json" => match serde_json::to_string_pretty(&table.data) {
                            Ok(json) => match std::fs::write(output_path, json) {
                                Ok(_) => return Ok("ok".to_string()),
                                Err(e) => {
                                    return Err(AppError::code(
                                        "error.io",
                                        serde_json::json!({ "details": e.to_string() }),
                                    ))
                                }
                            },
                            Err(e) => {
                                return Err(AppError::code(
                                    "error.parse",
                                    serde_json::json!({ "details": e.to_string() }),
                                ))
                            }
                        },
                        _ => {
                            return Err(AppError::code(
                                "error.unsupportedFormat",
                                serde_json::json!({"format":format}),
                            ))
                        }
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn export_table_json_full(
    uuid: &str,
    output_path: &str,
    allow_invalid: Option<bool>,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            formula_source_watcher::check_source_error(&expected_project_session)?;
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    match devcel_core::json_export::export_table_as_json_in_project_with_validation(
                        project,
                        &table.data,
                        ExportMode::Full,
                        allow_invalid.unwrap_or(false),
                    ) {
                        Ok(json) => {
                            match devcel_core::json_export::write_export_file(output_path, &json) {
                                Ok(_) => return Ok("ok".to_string()),
                                Err(e) => {
                                    return Err(AppError::code(
                                        "error.io",
                                        serde_json::json!({ "details": e.to_string() }),
                                    ))
                                }
                            }
                        }
                        Err(e) => return Err(AppError::from(e)),
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn export_table_json_minimal(
    uuid: &str,
    output_path: &str,
    allow_invalid: Option<bool>,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            formula_source_watcher::check_source_error(&expected_project_session)?;
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    match devcel_core::json_export::export_table_as_json_in_project_with_validation(
                        project,
                        &table.data,
                        ExportMode::Minimal,
                        allow_invalid.unwrap_or(false),
                    ) {
                        Ok(json) => {
                            match devcel_core::json_export::write_export_file(output_path, &json) {
                                Ok(_) => return Ok("ok".to_string()),
                                Err(e) => {
                                    return Err(AppError::code(
                                        "error.io",
                                        serde_json::json!({ "details": e.to_string() }),
                                    ))
                                }
                            }
                        }
                        Err(e) => return Err(AppError::from(e)),
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
async fn export_all_tables_json_full(
    output_path: String,
    allow_invalid: Option<bool>,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    // Get the project reference
    let project_arc = {
        let state_guard = &*state;
        state_guard.project.clone()
    };

    // Acquire the project lock
    let mut project_guard = project_arc.lock().await;
    let project = match project_guard.as_mut() {
        Some(p) => p,
        None => {
            return Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ))
        }
    };

    ensure_project_session(project, &expected_project_session)?;

    formula_source_watcher::check_source_error(&expected_project_session)?;
    let sorted_tables = devcel_core::json_export::export_all_table_values_with_validation(
        project,
        ExportMode::Full,
        allow_invalid.unwrap_or(false),
    )
    .map_err(AppError::from)?;

    // Build the final JSON structure containing project metadata and tables
    let project_json = serde_json::json!({
        "project": {
            "name": project.project_data.project_name,
            "description": project.project_data.project_description,
            "header_color": project.project_data.color,
        },
        "tables": sorted_tables,
    });

    // Output formatted JSON
    match serde_json::to_string_pretty(&project_json) {
        Ok(json) => match devcel_core::json_export::write_export_file(&output_path, &json) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::code(
                "error.io",
                serde_json::json!({ "details": e.to_string() }),
            )),
        },
        Err(e) => Err(AppError::code(
            "error.parse",
            serde_json::json!({ "details": e.to_string() }),
        )),
    }
}

#[tauri::command]
async fn export_all_tables_json_minimal(
    output_path: String,
    allow_invalid: Option<bool>,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    // Get the project reference
    let project_arc = {
        let state_guard = &*state;
        state_guard.project.clone()
    };

    // Acquire the project lock
    let mut project_guard = project_arc.lock().await;
    let project = match project_guard.as_mut() {
        Some(p) => p,
        None => {
            return Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ))
        }
    };

    ensure_project_session(project, &expected_project_session)?;

    formula_source_watcher::check_source_error(&expected_project_session)?;
    let sorted_tables = devcel_core::json_export::export_all_table_values_with_validation(
        project,
        ExportMode::Minimal,
        allow_invalid.unwrap_or(false),
    )
    .map_err(AppError::from)?;

    // Build the final JSON structure containing project metadata and tables
    let project_json = serde_json::json!({
        "project": {
            "name": project.project_data.project_name,
            "description": project.project_data.project_description,
            "header_color": project.project_data.color,
        },
        "tables": sorted_tables,
    });

    // Output formatted JSON
    match serde_json::to_string_pretty(&project_json) {
        Ok(json) => match devcel_core::json_export::write_export_file(&output_path, &json) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::code(
                "error.io",
                serde_json::json!({ "details": e.to_string() }),
            )),
        },
        Err(e) => Err(AppError::code(
            "error.parse",
            serde_json::json!({ "details": e.to_string() }),
        )),
    }
}

#[tauri::command]
async fn export_tables_batch(
    export_configs: Vec<(String, String, String)>, // (uuid, output_path, mode)
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<Result<String, AppError>>, AppError> {
    use rayon::prelude::*;

    // Get the project reference
    let project_arc = {
        let state_guard = &*state;
        state_guard.project.clone()
    };

    // Acquire the project lock
    let project_guard = project_arc.lock().await;
    let project = match project_guard.as_ref() {
        Some(p) => p,
        None => {
            return Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ))
        }
    };

    ensure_project_session(project, &expected_project_session)?;

    formula_source_watcher::check_source_error(&expected_project_session)?;

    // Run exports in parallel
    let results: Vec<Result<String, AppError>> = export_configs
        .into_par_iter()
        .map(|(uuid, output_path, mode)| {
            // Find the table
            for table in project.tables_data.values() {
                if table.data.uuid == uuid {
                    let export_mode = match mode.as_str() {
                        "full" => ExportMode::Full,
                        "minimal" => ExportMode::Minimal,
                        _ => {
                            return Err(AppError::code(
                                "error.unsupportedFormat",
                                serde_json::json!({"format":mode}),
                            ))
                        }
                    };

                    match export_table_as_json_in_project_with_validation(
                        project,
                        &table.data,
                        export_mode,
                        false,
                    ) {
                        Ok(json) => {
                            match devcel_core::json_export::write_export_file(&output_path, &json) {
                                Ok(_) => return Ok("ok".to_string()),
                                Err(e) => {
                                    return Err(AppError::code(
                                        "error.io",
                                        serde_json::json!({ "details": e.to_string() }),
                                    ))
                                }
                            }
                        }
                        Err(e) => return Err(AppError::from(e)),
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        })
        .collect();

    Ok(results)
}

#[tauri::command]
async fn export_table_metadata(
    uuid: &str,
    output_path: &str,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    let project_arc = {
        let state = &*state;
        state.project.clone()
    };

    let project_guard = project_arc.lock().await;
    if project_guard.is_none() {
        return Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        ));
    }

    let project = project_guard.as_ref().unwrap();
    ensure_project_session(project, &expected_project_session)?;
    formula_source_watcher::check_source_error(&expected_project_session)?;
    for table in project.tables_data.values() {
        if table.data.uuid == uuid {
            match export_table_metadata_as_json(&table.data) {
                Ok(json) => match std::fs::write(output_path, json) {
                    Ok(_) => return Ok("ok".to_string()),
                    Err(e) => {
                        return Err(AppError::code(
                            "error.io",
                            serde_json::json!({ "details": e.to_string() }),
                        ))
                    }
                },
                Err(e) => {
                    return Err(AppError::code(
                        "error.parse",
                        serde_json::json!({ "details": e.to_string() }),
                    ))
                }
            }
        }
    }
    Err(AppError::code("error.tableMissing", serde_json::json!({})))
}

#[tauri::command]
async fn export_project_metadata(
    output_path: &str,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<String, AppError> {
    let project_arc = {
        let state = &*state;
        state.project.clone()
    };

    let mut project_guard = project_arc.lock().await;
    if project_guard.is_none() {
        return Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        ));
    }

    let project = project_guard.as_mut().unwrap();
    ensure_project_session(project, &expected_project_session)?;
    formula_source_watcher::check_source_error(&expected_project_session)?;
    match export_project_metadata_as_json(project) {
        Ok(json) => match std::fs::write(output_path, json) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::code(
                "error.io",
                serde_json::json!({ "details": e.to_string() }),
            )),
        },
        Err(e) => Err(AppError::from(e)),
    }
}

#[tauri::command]
fn search_table_data(
    uuid: &str,
    query: &str,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| {
        match project_opt {
            Some(project) => {
                project
                    .ensure_table_loaded_by_uuid(uuid)
                    .map_err(AppError::from)?;
                for table in project.tables_data.values() {
                    if table.data.uuid == uuid {
                        let mut matching_records = Vec::new();

                        for record in &table.data.records {
                            // Search record labels
                            if record.label.to_lowercase().contains(&query.to_lowercase()) {
                                matching_records.push(record);
                                continue;
                            }

                            // Search record values
                            for value in record.values.values() {
                                if value.to_lowercase().contains(&query.to_lowercase()) {
                                    matching_records.push(record);
                                    break;
                                }
                            }
                        }

                        match serde_json::to_string(&matching_records) {
                            Ok(json) => return Ok(json),
                            Err(e) => {
                                return Err(AppError::code(
                                    "error.parse",
                                    serde_json::json!({ "details": e.to_string() }),
                                ))
                            }
                        }
                    }
                }
                Err(AppError::code("error.tableMissing", serde_json::json!({})))
            }
            None => Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            )),
        }
    })
}

// Internal use only, called from file_operation
fn create_directory(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<CreatedFile, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let dir_path = PathBuf::from(validate_create_path(path, FileType::Directory)?);
            match project.create_directory(dir_path) {
                Ok(path) => created_file(project, &path, FileType::Directory, None),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn rename_directory(
    old_path: &str,
    new_name: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let old_dir_path = PathBuf::from(old_path);
            match project.rename_directory(old_dir_path, new_name) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn move_directory(
    old_path: &str,
    new_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let old_dir_path = PathBuf::from(old_path);
            let new_dir_path = PathBuf::from(new_path);
            match project.move_directory(old_dir_path, new_dir_path) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn delete_directory(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let dir_path = PathBuf::from(path);
            match project.delete_directory(dir_path) {
                Ok(_) => Ok("ok".to_string()),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Separate file-manager target-path calculation from OS command execution.
fn resolve_file_manager_target(project_path: &str, file_path: &str) -> Result<PathBuf, AppError> {
    let project_dir = std::path::Path::new(project_path)
        .parent()
        .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))?;
    let project_name = project_dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy();
    let project_prefix = format!("{project_name}/");
    let relative_path = file_path.strip_prefix(&project_prefix).unwrap_or(file_path);
    Ok(project_dir.join("Tables").join(relative_path))
}

#[cfg(target_os = "linux")]
fn is_wsl_environment(has_wsl_variable: bool, kernel_version: &str) -> bool {
    let kernel_version = kernel_version.to_ascii_lowercase();
    has_wsl_variable || kernel_version.contains("microsoft") || kernel_version.contains("wsl")
}

// Opening a file with xdg-open launches its associated app, so open its parent directory instead.
#[cfg(target_os = "linux")]
fn file_manager_directory(
    path: &std::path::Path,
    is_directory: bool,
) -> Result<&std::path::Path, AppError> {
    if is_directory {
        Ok(path)
    } else {
        path.parent()
            .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))
    }
}

#[tauri::command]
fn open_in_explorer(project_path: &str, file_path: &str) -> Result<String, AppError> {
    use std::process::Command;

    let full_path = resolve_file_manager_target(project_path, file_path)?;
    if !full_path.exists() {
        return Err(AppError::code(
            "error.notFound",
            serde_json::json!({"details":full_path.to_string_lossy()}),
        ));
    }

    #[cfg(target_os = "windows")]
    let launch = {
        let mut selection = std::ffi::OsString::from("/select,");
        selection.push(full_path.as_os_str());
        Command::new("explorer.exe").arg(selection).spawn()
    };

    #[cfg(target_os = "macos")]
    let launch = Command::new("open").arg("-R").arg(&full_path).spawn();

    #[cfg(target_os = "linux")]
    let launch = {
        let has_wsl_variable = ["WSL_DISTRO_NAME", "WSL_INTEROP", "WSLENV"]
            .iter()
            .any(|name| std::env::var_os(name).is_some());
        let kernel_version = std::fs::read_to_string("/proc/version").unwrap_or_default();
        if is_wsl_environment(has_wsl_variable, &kernel_version) {
            // wslpath supports drives other than C: and paths inside WSL.
            let converted = match Command::new("wslpath").arg("-w").arg(&full_path).output() {
                Ok(output) if output.status.success() => output,
                Ok(output) => {
                    return Err(AppError::code(
                        "error.fileManager",
                        serde_json::json!({"details":String::from_utf8_lossy(&output.stderr).trim()}),
                    ));
                }
                Err(error) => {
                    return Err(AppError::code(
                        "error.fileManager",
                        serde_json::json!({"details":error.to_string()}),
                    ))
                }
            };
            let windows_path = String::from_utf8_lossy(&converted.stdout);
            let windows_path = windows_path.trim_end_matches(['\r', '\n']);
            if windows_path.is_empty() {
                return Err(AppError::code(
                    "error.fileManager",
                    serde_json::json!({"details":""}),
                ));
            }
            Command::new("explorer.exe")
                .arg(format!("/select,{windows_path}"))
                .spawn()
        } else {
            let directory = file_manager_directory(&full_path, full_path.is_dir())?;
            Command::new("xdg-open").arg(directory).spawn()
        }
    };

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        match launch {
            Ok(mut child) => {
                tauri::async_runtime::spawn_blocking(move || {
                    let _ = child.wait();
                });
                Ok("ok".to_string())
            }
            Err(error) => Err(AppError::code(
                "error.fileManager",
                serde_json::json!({"details":error.to_string()}),
            )),
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    Err(AppError::code(
        "error.fileManager",
        serde_json::json!({"details":""}),
    ))
}

// Used by both internal file_operation calls and direct frontend invokes
#[tauri::command]
fn move_markdown_file(
    old_path: &str,
    new_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    devcel_core::utils::validate_markdown_path(std::path::Path::new(old_path))
        .map_err(AppError::from)?;
    devcel_core::utils::validate_markdown_path(std::path::Path::new(new_path))
        .map_err(AppError::from)?;

    let state_guard = state.lock().unwrap();
    state_guard.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            project
                .move_markdown_file(old_path, new_path)
                .map_err(AppError::from)?;
            Ok("ok".to_string())
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Internal use only, called from file_operation
fn move_interface_file(
    old_path: &str,
    new_path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    if !old_path.ends_with(".interface.toml") || !new_path.ends_with(".interface.toml") {
        return Err(AppError::code(
            "error.fileExtension",
            serde_json::json!({"extension":".interface.toml"}),
        ));
    }
    state.lock().unwrap().with_project_mut(|project| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        project
            .move_interface_file(old_path, new_path)
            .map_err(AppError::from)?;
        Ok("ok".to_string())
    })
}

#[tauri::command]
fn validate_file_name_command(name: &str, file_type: FileType) -> Result<String, AppError> {
    let extension = match file_type {
        FileType::Table => ".table.toml",
        FileType::Interface => ".interface.toml",
        _ => return Err(AppError::code("error.invalidPath", serde_json::json!({}))),
    };
    devcel_core::utils::renamed_file_name(name, extension).map_err(AppError::from)
}

#[tauri::command]
fn validate_data_name_command(name: &str) -> Result<String, AppError> {
    match validate_data_name(name) {
        Ok(_) => Ok("ok".to_string()),
        Err(e) => Err(AppError::from(e)),
    }
}

/// Add or update a column's reference configuration
#[tauri::command]
fn set_column_reference_config_command(
    table_uuid: String,
    column_uuid: String,
    config: ReferenceConfig,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            devcel_core::commands::set_column_reference_config_with_save_queue(
                project,
                &table_uuid,
                &column_uuid,
                config,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

/// Make a column a TableRef and set the interface required of the referenced table
#[tauri::command]
fn set_column_table_ref_config_command(
    table_uuid: String,
    column_uuid: String,
    interface_uuid: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            let command = devcel_core::column_config::SetColumnConfigCommand::new(
                table_uuid,
                column_uuid,
                devcel_core::column_config::Configuration::TableRef(devcel_core::TableRefConfig {
                    interface_uuid,
                }),
            );
            project
                .execute_command(command, save_queue)
                .map_err(AppError::from)?;
            Ok("ok".to_string())
        })
}

/// Make a column a Curve and set fixed y values at its endpoints
#[tauri::command]
fn set_column_curve_config_command(
    table_uuid: String,
    column_uuid: String,
    start_value: f64,
    end_value: f64,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            let command = devcel_core::column_config::SetColumnConfigCommand::new(
                table_uuid,
                column_uuid,
                devcel_core::column_config::Configuration::Curve(devcel_core::CurveConfig {
                    start_value,
                    end_value,
                }),
            );
            project
                .execute_command(command, save_queue)
                .map_err(AppError::from)?;
            Ok("ok".to_string())
        })
}

/// Table-reference options: tables implementing the interface
#[derive(serde::Serialize)]
struct TableRefOptionInfo {
    uuid: String,
    /// Project-relative path after Tables/, including folder structure, for tree views
    path: String,
    display_name: String,
}

/// Return tables implementing the specified interface, with paths for a file-tree view.
/// (Currently includes direct implementations only; inheritance support is planned)
#[tauri::command]
async fn get_tables_for_interface(
    expected_project_session: String,
    interface_uuid: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<TableRefOptionInfo>, AppError> {
    let project = { state.project.clone() };
    let (session, directory) = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        (
            project.get_instance_id().to_owned(),
            project
                .path
                .parent()
                .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))?
                .join("Tables"),
        )
    };
    let id = uuid::Uuid::parse_str(&interface_uuid).map_err(AppError::from)?;
    Ok(read_table_catalog(project, session, Some(id), false)
        .await?
        .into_iter()
        .map(|table| {
            let full = PathBuf::from(&table.path);
            TableRefOptionInfo {
                path: full
                    .strip_prefix(&directory)
                    .unwrap_or(&full)
                    .to_string_lossy()
                    .replace('\\', "/"),
                uuid: table.uuid,
                display_name: table.display_name,
            }
        })
        .collect())
}

/// Remove a column's reference configuration
#[tauri::command]
fn remove_column_reference_config_command(
    table_uuid: String,
    column_uuid: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            devcel_core::commands::remove_column_reference_config_with_save_queue(
                project,
                &table_uuid,
                &column_uuid,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

/// Get the options for a reference column
#[tauri::command]
fn get_reference_options_command(
    expected_project_session: String,
    table_uuid: String,
    column_uuid: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Vec<ReferenceOption>, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            match get_reference_options(project, &table_uuid, &column_uuid) {
                Ok(options) => Ok(options),
                Err(e) => Err(AppError::from(e)),
            }
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Check referential integrity
#[tauri::command]
fn check_reference_integrity_command(
    table_uuid: String,
    record_uuid: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<ReferenceIntegrityCheck, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => match check_reference_integrity(project, &table_uuid, &record_uuid) {
            Ok(result) => Ok(result),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

// Command to set values in a cell range in bulk

// Copy/paste operations for cell ranges

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Both command styles share these same Arc-backed handles. Async commands
    // must never wait on the outer synchronous state mutex: doing so can starve
    // every executor worker behind a sync command waiting on the project mutex.
    let command_dispatcher =
        command_dispatcher::CommandDispatcher::new().expect("Failed to create command dispatcher");
    let mode =
        settings_mode::ApplicationMode::from_arguments().expect("Invalid application arguments");
    let mut context = tauri::generate_context!();
    if mode.is_settings_editor() {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.visible = false;
            }
        }
    }
    let project_state = ProjectState::new();
    let builder = tauri::Builder::default()
        .manage(mode)
        .manage(command_dispatcher.clone())
        .manage(project_state.clone())
        .manage(Mutex::new(project_state))
        .plugin(tauri_plugin_dialog::init());
    // Settings windows use only native project commands and ordinary dialogs.
    // Plugin commands bypass invoke_handler, so omit these plugins entirely.
    let builder = if mode.is_settings_editor() {
        builder
    } else {
        builder
            .plugin(tauri_plugin_fs::init())
            .plugin(tauri_plugin_shell::init())
            .plugin(tauri_plugin_process::init())
    };

    #[cfg(not(feature = "p2p"))]
    let app = builder
        .setup(|app| {
            window_geometry::fit_main_window(app.handle())?;
            app_settings::initialize(app.handle());
            if !settings_mode::initialize_editor(app.handle())? {
                return Ok(());
            }
            if !app
                .state::<settings_mode::ApplicationMode>()
                .is_settings_editor()
            {
                app_updater::initialize(app.handle())?;
            }
            formula_source_watcher::initialize(app.handle())?;
            Ok(())
        })
        .invoke_handler(command_dispatcher.handler(tauri::generate_handler![
            bundled_cli::get_bundled_cli_info,
            color_preview::preview_color,
            app_settings::get_app_settings,
            app_settings::reset_settings_project,
            settings_mode::get_application_mode,
            settings_mode::open_settings_editor,
            settings_mode::acquire_settings_update_lease,
            color_swatch_settings::get_user_color_swatches,
            color_swatch_settings::set_user_color_swatches,
            color_swatch_settings::apply_color_swatch,
            app_updater::get_updater_configuration,
            preview_plugin_package,
            install_plugin_package,
            export_plugin_package,
            list_installed_plugin_packages,
            list_removed_plugin_packages,
            approve_plugin_package,
            get_installed_plugin_source,
            set_plugin_package_enabled,
            remove_plugin_package,
            rollback_plugin_package,
            validate_plugin_catalog,
            fetch_plugin_catalog,
            has_project,
            get_project_name,
            get_project_description,
            get_project_path,
            get_project_session,
            get_project_header_color,
            create_project,
            open_project,
            delete_project,
            rename_project,
            save_project,
            close_project,
            // Unified file operations
            file_operation,
            delete_plugin_table,
            duplicate_project_entry,
            // Table-specific commands, separate from file operations
            initialize_empty_table,
            reload_table,
            get_table_history_status,
            undo_command,
            redo_command,
            clear_table_undo_redo_stacks,
            get_loaded_tables,
            get_table_data_range,
            get_table_path_by_uuid,
            get_table_data_by_uuids,
            check_and_apply_interface_updates,
            add_column,
            insert_column,
            remove_column,
            rename_column,
            move_column,
            prepare_table_rule_snapshot,
            cancel_table_rule_snapshot,
            get_table_rule_snapshot,
            get_table_presentation,
            new_formatting_rule,
            prepare_record_draft,
            create_column_type_session,
            get_column_type_session,
            resolve_column_type_session,
            take_column_type_result,
            create_bulk_row_session,
            get_bulk_row_session,
            resolve_bulk_row_session,
            take_bulk_row_result,
            apply_table_mutation,
            update_table_edit_settings,
            update_record_metadata,
            update_record_inheritance,
            set_column_read_only,
            create_table_dialog_session,
            get_table_dialog_session,
            resolve_table_dialog_session,
            take_table_dialog_result,
            load_column_editor,
            preview_column_editor,
            save_column_editor,
            set_column_tooltip,
            set_column_memo_text,
            set_column_default_value,
            rename_table_display_name,
            rename_table_data_name,
            add_record,
            insert_record,
            delete_record,
            set_record_value,
            set_cell_formula,
            set_record_label,
            set_record_memo_text,
            set_record_min_version,
            set_record_parent_uuid,
            add_record_tag,
            remove_record_tag,
            set_column_color,
            get_project_entries,
            get_table_list,
            get_table_catalog,
            get_table_display_catalog,
            load_table,
            load_tables_batch,
            get_table_data,
            get_formula_completion_schema,
            get_plugin_table_snapshot,
            update_plugin_table,
            get_plugin_projects,
            get_table_data_batch,
            get_project_tags,
            get_project_tag_usage,
            update_project_tag,
            update_project_info,
            export_table_data,
            export_table_json_full,
            export_table_json_minimal,
            export_all_tables_json_full,
            export_all_tables_json_minimal,
            lint_project_export,
            export_tables_batch,
            export_table_metadata,
            export_project_metadata,
            search_table_data,
            open_in_explorer,
            validate_data_name_command,
            validate_file_name_command,
            set_column_reference_config_command,
            set_column_table_ref_config_command,
            set_column_curve_config_command,
            set_column_select_config_command,
            configure_interface_column_command,
            get_tables_for_interface,
            remove_column_reference_config_command,
            get_reference_options_command,
            check_reference_integrity_command,
            read_markdown_file,
            write_markdown_file,
            move_markdown_file,
            // Interface commands
            list_interfaces,
            get_interface_details,
            apply_interface_to_table,
            update_interface,
            sync_table_with_interface,
            validate_interface_implementation,
            get_table_interfaces,
            get_interface_columns_for_table,
            get_interfaces,
            remove_interface_from_table,
            add_interface_column,
            undo_interface_command,
            redo_interface_command,
            remove_interface_column,
            import_interface_history,
            preview_interface_removal_impact,
            check_interface_name_collisions,
            find_duplicate_interface_copies
        ]));

    #[cfg(feature = "p2p")]
    let app = {
        // Initialize P2P state
        let builder = if mode.is_settings_editor() {
            builder
        } else {
            builder.manage(p2p_integration::P2PState::new())
        };

        builder
            .setup(move |app| {
                window_geometry::fit_main_window(app.handle())?;
                app_settings::initialize(app.handle());
                if !settings_mode::initialize_editor(app.handle())? {
                    return Ok(());
                }
                if !app
                    .state::<settings_mode::ApplicationMode>()
                    .is_settings_editor()
                {
                    app_updater::initialize(app.handle())?;
                }
                formula_source_watcher::initialize(app.handle())?;
                // The settings ProjectState never installs P2P change notifications.
                if app
                    .state::<settings_mode::ApplicationMode>()
                    .is_settings_editor()
                {
                    return Ok(());
                }

                // Production frontend assets are embedded by Tauri's custom protocol.
                // Their availability does not depend on the process working directory.

                // Set the event notification channel
                let (tx, mut rx) = tokio::sync::mpsc::channel::<state::ProjectChangeEvent>(100);
                {
                    let project_state: tauri::State<Mutex<ProjectState>> = app.state();
                    let project_state_guard = project_state.lock().unwrap();
                    let mut notifier =
                        tauri::async_runtime::block_on(project_state_guard.change_notifier.lock());
                    *notifier = Some(tx);
                }

                // Start the event notification task
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    while let Some(event) = rx.recv().await {
                        match event {
                            state::ProjectChangeEvent::P2PModeChanged { mode } => {
                                let _ = app_handle.emit(
                                    "p2p-mode-changed",
                                    serde_json::json!({
                                        "mode": mode
                                    }),
                                );
                            }
                            state::ProjectChangeEvent::ProjectOpened { path } => {
                                let _ = app_handle.emit(
                                    "project-opened",
                                    serde_json::json!({
                                        "path": path
                                    }),
                                );
                            }
                            state::ProjectChangeEvent::ProjectClosed => {
                                let _ = app_handle.emit("project-closed", serde_json::json!({}));
                            }
                            state::ProjectChangeEvent::ProjectModified => {
                                let _ = app_handle.emit("project-modified", serde_json::json!({}));
                            }
                        }
                    }
                });

                Ok(())
            })
            .invoke_handler(command_dispatcher.handler(tauri::generate_handler![
                bundled_cli::get_bundled_cli_info,
                color_preview::preview_color,
                app_settings::get_app_settings,
                app_settings::reset_settings_project,
                settings_mode::get_application_mode,
                settings_mode::open_settings_editor,
                settings_mode::acquire_settings_update_lease,
                color_swatch_settings::get_user_color_swatches,
                color_swatch_settings::set_user_color_swatches,
                color_swatch_settings::apply_color_swatch,
                app_updater::get_updater_configuration,
                preview_plugin_package,
                install_plugin_package,
                export_plugin_package,
                list_installed_plugin_packages,
                list_removed_plugin_packages,
                approve_plugin_package,
                get_installed_plugin_source,
                set_plugin_package_enabled,
                remove_plugin_package,
                rollback_plugin_package,
                validate_plugin_catalog,
                fetch_plugin_catalog,
                has_project,
                get_project_name,
                get_project_description,
                get_project_path,
                get_project_session,
                get_project_header_color,
                create_project,
                open_project,
                delete_project,
                rename_project,
                save_project,
                close_project,
                // Unified file operations
                file_operation,
                delete_plugin_table,
                duplicate_project_entry,
                // Table-specific commands, separate from file operations
                initialize_empty_table,
                reload_table,
                get_table_history_status,
                undo_command,
                redo_command,
                clear_table_undo_redo_stacks,
                get_loaded_tables,
                get_table_data_range,
                get_table_path_by_uuid,
                get_table_data_by_uuids,
                check_and_apply_interface_updates,
                add_column,
                insert_column,
                remove_column,
                rename_column,
                move_column,
                prepare_table_rule_snapshot,
                cancel_table_rule_snapshot,
                get_table_rule_snapshot,
                get_table_presentation,
                new_formatting_rule,
                prepare_record_draft,
                create_column_type_session,
                get_column_type_session,
                resolve_column_type_session,
                take_column_type_result,
                create_bulk_row_session,
                get_bulk_row_session,
                resolve_bulk_row_session,
                take_bulk_row_result,
                apply_table_mutation,
                update_table_edit_settings,
                update_record_metadata,
                update_record_inheritance,
                set_column_read_only,
                create_table_dialog_session,
                get_table_dialog_session,
                resolve_table_dialog_session,
                take_table_dialog_result,
                load_column_editor,
                preview_column_editor,
                save_column_editor,
                set_column_tooltip,
                set_column_memo_text,
                set_column_default_value,
                rename_table_display_name,
                rename_table_data_name,
                add_record,
                insert_record,
                delete_record,
                set_record_value,
                set_cell_formula,
                set_record_label,
                set_record_memo_text,
                set_record_min_version,
                set_record_parent_uuid,
                add_record_tag,
                remove_record_tag,
                set_column_color,
                get_project_entries,
                get_table_list,
                get_table_catalog,
                get_table_display_catalog,
                load_table,
                load_tables_batch,
                get_table_data,
                get_formula_completion_schema,
                get_plugin_table_snapshot,
                update_plugin_table,
                get_plugin_projects,
                get_table_data_batch,
                get_project_tags,
                get_project_tag_usage,
                update_project_tag,
                update_project_info,
                export_table_data,
                export_table_json_full,
                export_table_json_minimal,
                export_all_tables_json_full,
                export_all_tables_json_minimal,
                lint_project_export,
                export_tables_batch,
                export_table_metadata,
                export_project_metadata,
                search_table_data,
                open_in_explorer,
                validate_data_name_command,
                validate_file_name_command,
                set_column_reference_config_command,
                set_column_table_ref_config_command,
                set_column_curve_config_command,
                set_column_select_config_command,
                configure_interface_column_command,
                get_tables_for_interface,
                remove_column_reference_config_command,
                get_reference_options_command,
                check_reference_integrity_command,
                read_markdown_file,
                write_markdown_file,
                move_markdown_file,
                // Interface commands
                list_interfaces,
                get_interface_details,
                apply_interface_to_table,
                update_interface,
                sync_table_with_interface,
                validate_interface_implementation,
                get_table_interfaces,
                get_interface_columns_for_table,
                get_interfaces,
                remove_interface_from_table,
                add_interface_column,
                undo_interface_command,
                redo_interface_command,
                remove_interface_column,
                import_interface_history,
                preview_interface_removal_impact,
                check_interface_name_collisions,
                find_duplicate_interface_copies,
                // P2P commands
                p2p_integration::open_project_p2p,
                p2p_integration::get_p2p_status,
                p2p_integration::disconnect_p2p,
                p2p_integration::find_active_servers,
                p2p_integration::promote_to_server,
                // Change detection commands
                change_detection_commands::initialize_change_detection,
                change_detection_commands::get_current_sequence,
                change_detection_commands::get_changes_since,
                change_detection_commands::check_for_external_changes
            ]))
    };

    let app = app.on_window_event(|window, event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            column_type_dialog_commands::cleanup_for_owner(window.label(), window.app_handle());
            rule_commands::cancel_snapshot_requests_for_window(window.label());
        }
        if let tauri::WindowEvent::CloseRequested { .. } = event {
            // Clean up P2P connections
            #[cfg(feature = "p2p")]
            {
                // Simply log the cleanup request - actual cleanup will happen when the app exits
            }

            // Do not call close() from CloseRequested: that re-emits this event.
            // Tauri's default handling / the window's JS guard owns completion.
        }
    });

    match app.build(context) {
        Ok(app) => {
            app.run(move |handle, event| {
                if matches!(event, tauri::RunEvent::Exit) {
                    settings_mode::shutdown(handle);
                    if let Some(watcher) =
                        handle.try_state::<formula_source_watcher::FormulaSourceWatcher>()
                    {
                        watcher.stop();
                    }
                }
                if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                    // Tauri cannot prevent a restart. Normal closes/exits drain
                    // all accepted synchronous app commands before termination.
                    // Existing async handlers retain their prior shutdown contract.
                    if code != Some(tauri::RESTART_EXIT_CODE) {
                        let handle = handle.clone();
                        if command_dispatcher.defer_exit(move || handle.exit(code.unwrap_or(0))) {
                            api.prevent_exit();
                        }
                    }
                }
            });
        }
        Err(e) => {
            eprintln!("Tauri run error: {e:?}");
            panic!("Failed to run Tauri application: {e:?}");
        }
    }
}

// === File operations ===

#[derive(serde::Deserialize, Debug)]
#[serde(tag = "type")]
enum FileOperation {
    Create {
        file_type: FileType,
        path: String,
        content: Option<String>,
    },
    Delete {
        file_type: FileType,
        path: String,
    },
    Move {
        file_type: FileType,
        old_path: String,
        new_path: String,
    },
    Rename {
        file_type: FileType,
        old_path: String,
        new_name: String,
    },
    Duplicate {
        file_type: FileType,
        source_path: String,
        dest_path: String,
    },
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy)]
enum FileType {
    Table,
    Interface,
    Markdown,
    Directory,
}

#[derive(serde::Serialize)]
struct CreatedFile {
    path: String,
    file_type: FileType,
    uuid: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(tag = "type")]
enum FileOperationResult {
    Created { entry: CreatedFile },
    Moved { entry: CreatedFile },
    Completed,
}

fn validate_create_path(path: &str, file_type: FileType) -> Result<String, AppError> {
    let path = path.replace('\\', "/");
    if path.is_empty()
        || std::path::Path::new(&path)
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err(AppError::code("error.invalidPath", serde_json::json!({})));
    }
    let extension = match file_type {
        FileType::Table => ".table.toml",
        FileType::Interface => ".interface.toml",
        FileType::Markdown => ".md",
        FileType::Directory => "",
    };
    if !path.ends_with(extension)
        || path.rsplit('/').next().unwrap_or_default().len() <= extension.len()
    {
        return Err(AppError::code("error.invalidPath", serde_json::json!({})));
    }
    Ok(path)
}

fn created_file(
    project: &Project,
    path: &std::path::Path,
    file_type: FileType,
    uuid: Option<String>,
) -> Result<CreatedFile, AppError> {
    let tables_dir = project
        .path
        .parent()
        .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))?
        .join("Tables");
    let relative = path
        .strip_prefix(tables_dir)
        .map_err(|_| AppError::code("error.invalidPath", serde_json::json!({})))?;
    Ok(CreatedFile {
        path: relative.to_string_lossy().replace('\\', "/"),
        file_type,
        uuid,
    })
}

fn create_candidate(path: &std::path::Path, extension: &str, suffix: usize) -> PathBuf {
    if suffix == 0 {
        return path.to_path_buf();
    }
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    let stem = name.strip_suffix(extension).unwrap_or(&name);
    path.with_file_name(format!("{stem}_{suffix}{extension}"))
}

/// Unified file operation command
#[tauri::command]
fn file_operation(
    operation: FileOperation,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    app_handle: tauri::AppHandle,
) -> Result<FileOperationResult, AppError> {
    use FileOperation::*;
    use FileType::*;

    let affects_formula_sources = match &operation {
        Create { file_type, .. }
        | Delete { file_type, .. }
        | Move { file_type, .. }
        | Rename { file_type, .. }
        | Duplicate { file_type, .. } => !matches!(file_type, Markdown),
    };
    let session = expected_project_session.clone();
    let result = (|| {
        let completed = match operation {
            Create {
                file_type,
                path,
                content,
            } => {
                let entry = match file_type {
                    Table => create_table(&path, expected_project_session, state),
                    Interface => create_interface(expected_project_session, state, path, content),
                    Markdown => {
                        create_markdown_file(expected_project_session, state, path, content)
                    }
                    Directory => create_directory(&path, expected_project_session, state),
                }?;
                return Ok(FileOperationResult::Created { entry });
            }
            Delete { file_type, path } => match file_type {
                Table => delete_table(&path, expected_project_session, state),
                Interface => delete_interface(&path, expected_project_session, state),
                Markdown => delete_markdown_file(&path, expected_project_session, state),
                Directory => delete_directory(&path, expected_project_session, state),
            },
            Move {
                file_type,
                old_path,
                new_path,
            } => match file_type {
                Table => {
                    return move_table(&old_path, &new_path, expected_project_session, state)
                        .map(|entry| FileOperationResult::Moved { entry })
                }
                Interface => {
                    move_interface_file(&old_path, &new_path, expected_project_session, state)
                }
                Markdown => {
                    move_markdown_file(&old_path, &new_path, expected_project_session, state)
                }
                Directory => move_directory(&old_path, &new_path, expected_project_session, state),
            },
            Rename {
                file_type,
                old_path,
                new_name,
            } => match file_type {
                Table => rename_table(&old_path, &new_name, expected_project_session, state),
                Interface => state.lock().unwrap().with_project_mut(|project| {
                    let project = project.as_mut().ok_or_else(|| {
                        AppError::code("grid.loading.noProject", serde_json::json!({}))
                    })?;
                    ensure_project_session(project, &expected_project_session)?;
                    project
                        .rename_interface_file(&old_path, &new_name)
                        .map_err(AppError::from)?;
                    Ok("ok".into())
                }),
                Markdown | Directory => {
                    // Renaming is equivalent to moving to parent directory + new name
                    let old_path_buf = PathBuf::from(&old_path);
                    let parent = old_path_buf
                        .parent()
                        .map(|p| p.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let new_path = if parent.is_empty() {
                        new_name.clone()
                    } else {
                        format!("{}/{}", parent, new_name)
                    };
                    match file_type {
                        Markdown => move_markdown_file(
                            &old_path,
                            &new_path,
                            expected_project_session,
                            state,
                        ),
                        Directory => {
                            rename_directory(&old_path, &new_name, expected_project_session, state)
                        }
                        _ => unreachable!(),
                    }
                }
            },
            Duplicate {
                source_path,
                dest_path,
                file_type,
            } => {
                let _ = file_type;
                duplicate_project_entry(source_path, dest_path, expected_project_session, state)
                    .map(|_| "ok".to_string())
            }
        };
        completed.map(|_| FileOperationResult::Completed)
    })();
    if result.is_ok() && affects_formula_sources {
        let _ = app_handle.emit(
            "formula-sources-changed",
            serde_json::json!({ "project_session": session }),
        );
    }
    result
}

// === Interface-related commands ===

#[derive(serde::Serialize)]
struct InterfaceInfo {
    uuid: String,
    name: String,
    path: String,
    description: Option<String>,
    column_count: usize,
}

#[derive(serde::Serialize)]
struct InterfaceDetails {
    uuid: String,
    name: String,
    description: Option<String>,
    columns: Vec<InterfaceColumnInfo>,
    extends: Vec<String>,
    current_version_id: String,
    current_version: InterfaceVersionInfo,
    version_history: Vec<InterfaceVersionInfo>,
    implementing_tables: Vec<ImplementingTableInfo>,
}

#[derive(serde::Serialize)]
struct ImplementingTableInfo {
    uuid: String,
    data_name: String,
    display_name: String,
}

#[derive(serde::Serialize)]
struct InterfaceColumnInfo {
    uuid: String,
    name: String,
    display_name: Option<String>,
    value_type: String,
    default_value: Option<String>,
    description: Option<String>,
    color: Option<String>,
    tooltip: Option<String>,
    required: Option<bool>,
    constraints: Option<devcel_core::ColumnConstraints>,
    curve_config: Option<devcel_core::CurveConfig>,
    table_ref_config: Option<devcel_core::TableRefConfig>,
    select_config: Option<devcel_core::SelectConfig>,
    color_swatches: Vec<devcel_core::ColorSwatch>,
    input_validation: Option<devcel_core::cell_rules::InputValidationSettings>,
    conditional_formatting: Option<devcel_core::cell_rules::ConditionalFormatting>,
}

#[derive(serde::Serialize)]
struct FieldConflictInfo {
    field: String,
    field_label: devcel_core::types::Diagnostic,
    ours: String,
    theirs: String,
}

#[derive(serde::Serialize)]
struct InterfaceRemovalImpact {
    /// Names of columns to be removed
    columns: Vec<String>,
    /// Number of entered values to be removed
    value_count: usize,
}

#[derive(serde::Serialize)]
struct DuplicateInterfaceCopy {
    interface_uuid: String,
    name: String,
    canonical_path: String,
    duplicate_path: String,
}

#[derive(serde::Serialize)]
struct InterfaceVersionInfo {
    id: String,
    parent_version_id: Option<String>,
    timestamp: String,
    changes: Vec<InterfaceChangeInfo>,
    author: Option<String>,
    comment: Option<String>,
    merge_info: Option<MergeInfo>,
}

#[derive(serde::Serialize)]
struct MergeInfo {
    second_parent_id: String,
    conflict_resolutions: Vec<ConflictResolutionInfo>,
}

#[derive(serde::Serialize)]
struct ConflictResolutionInfo {
    column_name: String,
    resolution_type: String,
    description: String,
    field_conflicts: Vec<FieldConflictInfo>,
}

#[derive(serde::Serialize)]
struct InterfaceChangeInfo {
    action: String,
    column_name: Option<String>,
    old_type: Option<String>,
    new_type: Option<String>,
    details: Option<String>,
}

/// Create an interface. Call only through the single file-operation boundary.
fn create_interface(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    path: String,
    description: Option<String>,
) -> Result<CreatedFile, AppError> {
    let path = validate_create_path(&path, FileType::Interface)?;
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let requested = project.resolve_table_path(&PathBuf::from(&path))?;
        let mut suffix = 0;
        let (full_path, entry) = loop {
            let candidate = create_candidate(&requested, ".interface.toml", suffix);
            let entry = created_file(project, &candidate, FileType::Interface, None)?;
            if !candidate.try_exists().map_err(DevcelError::Io)?
                && project
                    .interface_registry
                    .get_interface_by_path(&entry.path)
                    .is_none()
            {
                break (candidate, entry);
            }
            suffix += 1;
        };
        let name = full_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .trim_end_matches(".interface.toml")
            .to_string();
        let interface = devcel_core::interface::Interface::new(name, description);
        let uuid = interface.uuid;
        project
            .interface_registry
            .add_interface_with_path(entry.path.clone(), interface.clone())?;
        if let Err(error) = project.save_interface(&interface) {
            // A disk race or save failure must never replace an existing registry entry.
            project.interface_registry.remove_interface(&uuid);
            return Err(error.into());
        }
        Ok(CreatedFile {
            uuid: Some(uuid.to_string()),
            ..entry
        })
    })
}

/// Remove an interface
// Internal use only, called from file_operation
fn delete_interface(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.delete_interface(PathBuf::from(path)) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Delete a Markdown file
// Internal use only, called from file_operation
fn delete_markdown_file(
    path: &str,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) if ensure_project_session(project, &expected_project_session).is_err() => {
            Err(AppError::code(
                "grid.loading.sessionChanged",
                serde_json::json!({}),
            ))
        }
        Some(project) => match project.delete_markdown(PathBuf::from(path)) {
            Ok(_) => Ok("ok".to_string()),
            Err(e) => Err(AppError::from(e)),
        },
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Get the interface list
#[tauri::command]
fn list_interfaces(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<Vec<InterfaceInfo>, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            // Get the project directory
            let project_dir = project
                .path
                .parent()
                .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))?;
            let tables_dir = project_dir.join("Tables");

            let mut interfaces = Vec::new();
            // Get all interfaces and their paths from the registry
            let all_interfaces = project.interface_registry.get_all_interfaces_with_paths();
            for (path, interface) in all_interfaces {
                // Compute paths relative to the Tables directory
                let relative_path =
                    if let Ok(rel_path) = PathBuf::from(path).strip_prefix(&tables_dir) {
                        rel_path.to_string_lossy().to_string()
                    } else {
                        path.clone()
                    };

                interfaces.push(InterfaceInfo {
                    uuid: interface.uuid.to_string(),
                    name: interface.name.clone(),
                    path: relative_path,
                    description: interface.description.clone(),
                    column_count: interface.columns.len(),
                });
            }
            Ok(interfaces)
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Get interface details
fn map_change_to_info(change: &InterfaceChange) -> InterfaceChangeInfo {
    match change {
        InterfaceChange::AddColumn { column } => InterfaceChangeInfo {
            action: "add".to_string(),
            column_name: Some(column.data_name.clone()),
            old_type: None,
            new_type: Some(format!("{:?}", column.data_type)),
            details: None,
        },
        InterfaceChange::RemoveColumn { column_name } => InterfaceChangeInfo {
            action: "remove".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: None,
        },
        InterfaceChange::ModifyColumn {
            column_name,
            old_type,
            new_type,
        } => InterfaceChangeInfo {
            action: "modify".to_string(),
            column_name: Some(column_name.clone()),
            old_type: Some(format!("{:?}", old_type)),
            new_type: Some(format!("{:?}", new_type)),
            details: None,
        },
        InterfaceChange::ChangeMinVersion {
            column_name,
            min_version,
        } => InterfaceChangeInfo {
            action: "change_min_version".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: Some(min_version.to_string()),
        },
        InterfaceChange::ChangeRequired {
            column_name,
            required,
        } => InterfaceChangeInfo {
            action: "change_required".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: Some(required.to_string()),
        },
        InterfaceChange::ChangeDefault {
            column_name,
            new_default,
        } => InterfaceChangeInfo {
            action: "change_default".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: new_default.clone(),
        },
        InterfaceChange::ChangeConstraints {
            column_name,
            new_constraints,
        } => InterfaceChangeInfo {
            action: "change_constraints".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: new_constraints
                .as_ref()
                .and_then(|c| serde_json::to_string(c).ok()),
        },
        InterfaceChange::ChangeInputValidation {
            column_name,
            settings,
        } => InterfaceChangeInfo {
            action: "change_input_validation".into(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: settings
                .as_ref()
                .and_then(|settings| serde_json::to_string(settings).ok()),
        },
        InterfaceChange::ChangeConditionalFormatting {
            column_name,
            formatting,
        } => InterfaceChangeInfo {
            action: "change_conditional_formatting".into(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: formatting
                .as_ref()
                .and_then(|formatting| serde_json::to_string(formatting).ok()),
        },
        InterfaceChange::RenameColumn { old_name, new_name } => InterfaceChangeInfo {
            action: "rename".to_string(),
            column_name: Some(old_name.clone()),
            old_type: None,
            new_type: None,
            details: Some(new_name.clone()),
        },
        InterfaceChange::ModifyColumnMeta { column_name, .. } => InterfaceChangeInfo {
            action: "modify_meta".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: None,
        },
        InterfaceChange::ChangeColorSwatches {
            column_name,
            swatches,
        } => InterfaceChangeInfo {
            action: "change_color_swatches".to_string(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: serde_json::to_string(swatches).ok(),
        },
        InterfaceChange::ConfigureColumn { column_name, .. } => InterfaceChangeInfo {
            action: "configure".into(),
            column_name: Some(column_name.clone()),
            old_type: None,
            new_type: None,
            details: None,
        },
        InterfaceChange::ChangeDescription { new_description } => InterfaceChangeInfo {
            action: "change_description".to_string(),
            column_name: None,
            old_type: None,
            new_type: None,
            details: new_description.clone(),
        },
        InterfaceChange::ModifyExtends { new_extends } => InterfaceChangeInfo {
            action: "modify_extends".to_string(),
            column_name: None,
            old_type: None,
            new_type: None,
            details: serde_json::to_string(
                &new_extends
                    .iter()
                    .map(|uuid| uuid.to_string())
                    .collect::<Vec<_>>(),
            )
            .ok(),
        },
        InterfaceChange::ReorderColumns { order } => InterfaceChangeInfo {
            action: "reorder".to_string(),
            column_name: None,
            old_type: None,
            new_type: None,
            details: serde_json::to_string(order).ok(),
        },
    }
}

/// Describe changes in plain, user-facing language
/// (Used in merge and restore previews; avoid technical jargon)
fn map_conflict_to_info(c: &devcel_core::ConflictResolution) -> ConflictResolutionInfo {
    ConflictResolutionInfo {
        column_name: c.column_name.clone(),
        resolution_type: format!("{:?}", c.resolution_type),
        description: c.description.clone(),
        field_conflicts: c
            .field_conflicts
            .iter()
            .map(|f| FieldConflictInfo {
                field: f.field.clone(),
                field_label: interface_presentation::field_label(&f.field, &f.field_label),
                ours: f.ours.clone(),
                theirs: f.theirs.clone(),
            })
            .collect(),
    }
}

#[tauri::command]
async fn get_interface_details(
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
    interface_uuid: String,
) -> Result<InterfaceDetails, AppError> {
    let project = { state.project.clone() };
    let id = uuid::Uuid::parse_str(&interface_uuid).map_err(AppError::from)?;
    let (session, interface) = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        (
            project.get_instance_id().to_owned(),
            project
                .get_interface(&id)
                .cloned()
                .ok_or_else(|| AppError::code("interface.api.notFound", serde_json::json!({})))?,
        )
    };
    let implementing_tables = read_table_catalog(project, session, Some(id), false)
        .await?
        .into_iter()
        .map(|table| ImplementingTableInfo {
            uuid: table.uuid,
            data_name: table.data_name,
            display_name: table.display_name,
        })
        .collect();
    let current_version = interface
        .history
        .get(&interface.current_version_id)
        .ok_or_else(|| AppError::code("interface.api.notFound", serde_json::json!({})))?;
    Ok(InterfaceDetails {
        uuid: interface.uuid.to_string(),
        name: interface.name.clone(),
        description: interface.description.clone(),
        columns: interface
            .columns
            .iter()
            .map(|c| InterfaceColumnInfo {
                uuid: c.uuid.clone(),
                name: c.data_name.clone(),
                display_name: if c.display_name.is_empty() || c.display_name == c.data_name {
                    None
                } else {
                    Some(c.display_name.clone())
                },
                value_type: format!("{:?}", c.data_type),
                default_value: if c.default_value.is_empty() {
                    None
                } else {
                    Some(c.default_value.clone())
                },
                description: if c.memo_text.is_empty() {
                    None
                } else {
                    Some(c.memo_text.clone())
                },
                color: Some(c.style.color.clone()),
                tooltip: if c.tooltip.is_empty() {
                    None
                } else {
                    Some(c.tooltip.clone())
                },
                required: c.required,
                constraints: c.constraints.clone(),
                curve_config: c.curve_config.clone(),
                table_ref_config: c.table_ref_config.clone(),
                select_config: c.select_config.clone(),
                color_swatches: c.color_swatches.clone(),
                input_validation: c.input_validation.clone(),
                conditional_formatting: c.conditional_formatting.clone(),
            })
            .collect(),
        extends: interface.extends.iter().map(|u| u.to_string()).collect(),
        current_version_id: interface.current_version_id.to_string(),
        current_version: InterfaceVersionInfo {
            id: current_version.version_id.to_string(),
            parent_version_id: current_version.parent_version_id.map(|id| id.to_string()),
            timestamp: current_version.timestamp.to_rfc3339(),
            changes: current_version
                .changes
                .iter()
                .map(map_change_to_info)
                .collect(),
            author: current_version.author.clone(),
            comment: current_version.comment.clone(),
            merge_info: current_version.merge_info.as_ref().map(|m| MergeInfo {
                second_parent_id: m.second_parent_id.to_string(),
                conflict_resolutions: m
                    .conflict_resolutions
                    .iter()
                    .map(map_conflict_to_info)
                    .collect(),
            }),
        },
        version_history: interface
            .history
            .values()
            .map(|v| InterfaceVersionInfo {
                id: v.version_id.to_string(),
                parent_version_id: v.parent_version_id.map(|id| id.to_string()),
                timestamp: v.timestamp.to_rfc3339(),
                changes: v.changes.iter().map(map_change_to_info).collect(),
                author: v.author.clone(),
                comment: v.comment.clone(),
                merge_info: v.merge_info.as_ref().map(|m| MergeInfo {
                    second_parent_id: m.second_parent_id.to_string(),
                    conflict_resolutions: m
                        .conflict_resolutions
                        .iter()
                        .map(map_conflict_to_info)
                        .collect(),
                }),
            })
            .collect(),
        implementing_tables,
    })
}

/// Apply an interface to a table
#[tauri::command]
fn apply_interface_to_table(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    auto_add_columns: bool,
    table_uuid: String,
    acknowledgement: Option<String>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;
            let id = uuid::Uuid::parse_str(&interface_uuid).map_err(AppError::from)?;
            devcel_core::table_mutation::apply_interface_checked(
                project,
                &table_uuid,
                &id,
                auto_add_columns,
                acknowledgement,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

/// Update an interface
#[tauri::command]
fn update_interface(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    changes: Vec<serde_json::Value>,
    author: Option<String>,
    comment: Option<String>,
    expected_version_id: Option<String>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();

    // Parse the UUID
    let uuid = match uuid::Uuid::parse_str(&interface_uuid) {
        Ok(u) => u,
        Err(e) => return Err(AppError::from(e)),
    };

    // Convert JSON to InterfaceChange
    let interface_changes: Result<Vec<InterfaceChange>, _> =
        changes.into_iter().map(serde_json::from_value).collect();

    match interface_changes {
        Ok(changes) => {
            let command = UpdateInterfaceCommand::new(uuid, changes, author, comment);

            state.with_project_mut_save(|project_opt, save_queue| match project_opt {
                Some(project)
                    if ensure_project_session(project, &expected_project_session).is_err() =>
                {
                    Err(AppError::code(
                        "grid.loading.sessionChanged",
                        serde_json::json!({}),
                    ))
                }
                Some(project) => {
                    if let Some(expected) = expected_version_id.as_deref() {
                        let interface = project.get_interface(&uuid).ok_or_else(|| {
                            AppError::code("interface.api.notFound", serde_json::json!({}))
                        })?;
                        if interface.current_version_id.to_string() != expected {
                            return Err(AppError::code("error.staleData", serde_json::json!({})));
                        }
                    }
                    match project.execute_command(command, save_queue) {
                        Ok(_) => Ok("ok".to_string()),
                        Err(e) => Err(AppError::from(e)),
                    }
                }
                None => Err(AppError::code(
                    "grid.loading.noProject",
                    serde_json::json!({}),
                )),
            })
        }
        Err(e) => Err(AppError::from(e)),
    }
}

/// Impact of detaching an interface: columns and number of values to be removed
#[tauri::command]
fn preview_interface_removal_impact(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    table_uuid: String,
    interface_uuid: String,
) -> Result<InterfaceRemovalImpact, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;
            let table = project
                .tables_data
                .values()
                .find(|t| t.data.uuid == table_uuid)
                .ok_or_else(|| format!("Table (UUID: {}) not found", table_uuid))?;

            let columns: Vec<String> = table
                .data
                .schema
                .columns
                .iter()
                .filter(|c| c.interface_origin.as_deref() == Some(interface_uuid.as_str()))
                .map(|c| c.data_name.clone())
                .collect();
            let value_count = table.count_interface_column_values(&interface_uuid, None);

            Ok(InterfaceRemovalImpact {
                columns,
                value_count,
            })
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Detect same-named column collisions before applying an interface
/// Return column names that would collide with existing columns
#[tauri::command]
fn check_interface_name_collisions(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    table_uuid: String,
    interface_uuid: String,
    preceding_interface_uuids: Option<Vec<String>>,
) -> Result<Vec<String>, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let uuid = uuid::Uuid::parse_str(&interface_uuid)
                .map_err(|e| format!("Invalid UUID: {}", e))?;
            let interface = project
                .get_interface(&uuid)
                .ok_or_else(|| format!("Interface {} not found", interface_uuid))?;
            let table = project
                .tables_data
                .values()
                .find(|t| t.data.uuid == table_uuid)
                .ok_or_else(|| format!("Table (UUID: {}) not found", table_uuid))?;

            let mut existing = table.data.schema.columns.clone();
            for preceding in preceding_interface_uuids.unwrap_or_default() {
                let id = uuid::Uuid::parse_str(&preceding)
                    .map_err(|e| format!("Invalid UUID: {}", e))?;
                let previous = project
                    .get_interface(&id)
                    .ok_or_else(|| format!("Interface {} not found", preceding))?;
                existing.extend(previous.get_effective_columns(&project.interface_registry)?);
            }
            let collisions =
                interface.column_name_collisions(&existing, &project.interface_registry)?;

            Ok(collisions)
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Find other copies of the same interface within the project, such as conflict copies
/// Used to guide merging duplicate files created by file synchronization tools
#[tauri::command]
async fn find_duplicate_interface_copies(
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<DuplicateInterfaceCopy>, AppError> {
    let project = { state.project.clone() };
    let (session, tables_dir, canonical_paths) = {
        let guard = project.lock().await;
        let project = guard
            .as_ref()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let tables_dir = project
            .path
            .parent()
            .ok_or_else(|| AppError::code("error.invalidPath", serde_json::json!({})))?
            .join("Tables");
        let canonical: std::collections::HashMap<_, _> = project
            .interface_registry
            .get_all_interfaces_with_paths()
            .into_iter()
            .map(|(path, interface)| (interface.uuid, tables_dir.join(path)))
            .collect();
        (project.get_instance_id().to_owned(), tables_dir, canonical)
    };
    // This startup check used to parse every table as a possible Interface.
    // A known table suffix is never an Interface copy. Keep generic .toml copy
    // names supported, since sync tools may rename the original extension.
    let duplicates = tokio::task::spawn_blocking(move || {
        if canonical_paths.is_empty() || !tables_dir.exists() {
            return Vec::new();
        }
        fn collect_candidates(dir: &std::path::Path, files: &mut Vec<PathBuf>) {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        collect_candidates(&path, files);
                    } else if path.extension().and_then(|s| s.to_str()) == Some("toml")
                        && !path.to_string_lossy().ends_with(".table.toml")
                    {
                        files.push(path);
                    }
                }
            }
        }
        let mut paths = Vec::new();
        collect_candidates(&tables_dir, &mut paths);
        let mut duplicates = Vec::new();
        for path in paths {
            let Ok(candidate) = devcel_core::Interface::load_from_file(&path) else {
                continue;
            };
            if let Some(canonical) = canonical_paths.get(&candidate.uuid) {
                if &path != canonical {
                    duplicates.push(DuplicateInterfaceCopy {
                        interface_uuid: candidate.uuid.to_string(),
                        name: candidate.name,
                        canonical_path: canonical.to_string_lossy().into_owned(),
                        duplicate_path: path.to_string_lossy().into_owned(),
                    });
                }
            }
        }
        duplicates
    })
    .await
    .map_err(AppError::from)?;
    if project.lock().await.as_ref().map(Project::get_instance_id) != Some(session.as_str()) {
        return Err(AppError::code(
            "grid.loading.sessionChanged",
            serde_json::json!({}),
        ));
    }
    Ok(duplicates)
}

/// Import history from an external interface file
/// (Prepares for merging copies of the same interface diverged through file synchronization)
/// Return the number of imported versions
#[tauri::command]
fn import_interface_history(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    source_path: String,
    delete_source: Option<bool>,
) -> Result<usize, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            let uuid = uuid::Uuid::parse_str(&interface_uuid)
                .map_err(|e| format!("Invalid UUID: {}", e))?;

            // Kept for wire compatibility. External conflict copies are never
            // deleted: another process can append history after our read.
            let _ = delete_source;
            let absorbed = project
                .import_interface_history_file(&uuid, &PathBuf::from(&source_path))
                .map_err(AppError::from)?;

            Ok(absorbed)
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Synchronize a table with its interface
#[tauri::command]
fn sync_table_with_interface(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    apply_safe_changes: bool,
    reconcile_after_sync: bool,
    table_uuid: String,
    acknowledgement: Option<String>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;
            let id = uuid::Uuid::parse_str(&interface_uuid).map_err(AppError::from)?;
            devcel_core::table_mutation::sync_interface_checked(
                project,
                &table_uuid,
                &id,
                reconcile_after_sync,
                apply_safe_changes,
                acknowledgement,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

/// Remove (detach) an interface from the table
#[tauri::command]
fn remove_interface_from_table(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    table_uuid: String,
    acknowledgement: Option<String>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;
            let id = uuid::Uuid::parse_str(&interface_uuid).map_err(AppError::from)?;
            devcel_core::table_mutation::remove_interface_checked(
                project,
                &table_uuid,
                &id,
                acknowledgement,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

/// Get candidate interface columns the table should implement
#[tauri::command]
fn get_interface_columns_for_table(
    state: tauri::State<Mutex<ProjectState>>,
    table_uuid: String,
) -> Result<Vec<InterfaceColumnInfo>, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;
            // Find the table
            let table_entry = project
                .tables_data
                .values()
                .find(|entry| entry.data.uuid == table_uuid)
                .ok_or_else(|| AppError::code("error.tableMissing", serde_json::json!({})))?;

            let table = &table_entry.data;
            let mut interface_columns = Vec::new();

            // Check the interfaces implemented by the table
            for interface_name in table.interface_implementations.keys() {
                if let Some(interface) = project.get_interface(interface_name) {
                    // Check each interface column
                    for interface_col in &interface.columns {
                        // Check whether the table has a column with the same name
                        let exists_in_table = table
                            .schema
                            .columns
                            .iter()
                            .any(|table_col| table_col.data_name == interface_col.data_name);

                        // Add missing columns as candidates
                        if !exists_in_table {
                            interface_columns.push(InterfaceColumnInfo {
                                uuid: interface_col.uuid.clone(),
                                name: interface_col.data_name.clone(),
                                display_name: None,
                                value_type: format!("{:?}", interface_col.data_type),
                                default_value: if interface_col.default_value.is_empty() {
                                    None
                                } else {
                                    Some(interface_col.default_value.clone())
                                },
                                description: if interface_col.memo_text.is_empty() {
                                    None
                                } else {
                                    Some(interface_col.memo_text.clone())
                                },
                                color: Some(interface_col.style.color.clone()),
                                tooltip: if interface_col.tooltip.is_empty() {
                                    None
                                } else {
                                    Some(interface_col.tooltip.clone())
                                },
                                required: interface_col.required,
                                constraints: interface_col.constraints.clone(),
                                curve_config: interface_col.curve_config.clone(),
                                table_ref_config: interface_col.table_ref_config.clone(),
                                select_config: interface_col.select_config.clone(),
                                color_swatches: interface_col.color_swatches.clone(),
                                input_validation: interface_col.input_validation.clone(),
                                conditional_formatting: interface_col
                                    .conditional_formatting
                                    .clone(),
                            });
                        }
                    }
                }
            }

            // Check all interfaces in the project, including those not implemented
            for interface in project.list_interfaces() {
                // Skip already implemented interfaces
                if table
                    .interface_implementations
                    .contains_key(&interface.uuid)
                {
                    continue;
                }

                // Add column candidates including their interface names
                for interface_col in &interface.columns {
                    let column_name = format!("{}_{}", interface.name, interface_col.data_name);

                    // Add only when no same-named column exists
                    let exists = table.schema.columns.iter().any(|col| {
                        col.data_name == column_name || col.data_name == interface_col.data_name
                    });

                    if !exists {
                        interface_columns.push(InterfaceColumnInfo {
                            uuid: interface_col.uuid.clone(),
                            name: interface_col.data_name.clone(),
                            display_name: None,
                            value_type: format!("{:?}", interface_col.data_type),
                            default_value: if interface_col.default_value.is_empty() {
                                None
                            } else {
                                Some(interface_col.default_value.clone())
                            },
                            description: Some(format!("From interface: {}", interface.name)),
                            color: Some(interface_col.style.color.clone()),
                            tooltip: if interface_col.tooltip.is_empty() {
                                None
                            } else {
                                Some(interface_col.tooltip.clone())
                            },
                            required: interface_col.required,
                            constraints: interface_col.constraints.clone(),
                            curve_config: interface_col.curve_config.clone(),
                            table_ref_config: interface_col.table_ref_config.clone(),
                            select_config: interface_col.select_config.clone(),
                            color_swatches: interface_col.color_swatches.clone(),
                            input_validation: interface_col.input_validation.clone(),
                            conditional_formatting: interface_col.conditional_formatting.clone(),
                        });
                    }
                }
            }

            Ok(interface_columns)
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

/// Create a Markdown file
// Internal use only, called from file_operation
fn create_markdown_file(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    path: String,
    content: Option<String>,
) -> Result<CreatedFile, AppError> {
    use std::io::Write;
    let path = validate_create_path(&path, FileType::Markdown)?;
    state.lock().unwrap().with_project_mut(|project_opt| {
        let project = project_opt
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let requested = project.resolve_table_path(&PathBuf::from(path))?;
        if let Some(parent) = requested.parent() {
            std::fs::create_dir_all(parent).map_err(DevcelError::Io)?;
        }
        let mut suffix = 0;
        loop {
            let candidate = create_candidate(&requested, ".md", suffix);
            let entry = created_file(project, &candidate, FileType::Markdown, None)?;
            let mut file = match std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&candidate)
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    suffix += 1;
                    continue;
                }
                Err(error) => return Err(DevcelError::Io(error).into()),
            };
            let content = content.unwrap_or_else(|| {
                format!(
                    "# {}\n\n",
                    candidate.file_stem().unwrap_or_default().to_string_lossy()
                )
            });
            if let Err(error) = file
                .write_all(content.as_bytes())
                .and_then(|_| file.sync_all())
            {
                drop(file);
                let _ = std::fs::remove_file(&candidate);
                return Err(DevcelError::Io(error).into());
            }
            return Ok(entry);
        }
    })
}

/// Validate an interface implementation
#[tauri::command]
fn validate_interface_implementation(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    interface_uuid: String,
    table_uuid: String,
) -> Result<serde_json::Value, AppError> {
    let state = state.lock().unwrap();
    state.with_project(|project_opt| match project_opt {
        Some(project) => {
                ensure_project_session(project, &expected_project_session)?;
            // Find the table by UUID
            for table in project.tables_data.values() {
                let matches = table.data.uuid == table_uuid;

                if matches {
                    let interface_id = match uuid::Uuid::parse_str(&interface_uuid) {
                        Ok(id) => id,
                        Err(_) => return Err(AppError::code("column.conversion.invalidValue", serde_json::json!({"type":"UUID"}))),
                    };
                    if let Some(interface) = project.get_interface(&interface_id) {
                        match table.validate_interface(interface, &project.interface_registry) {
                            Ok(validation) => {
                                return Ok(serde_json::json!({
                                    "interface_uuid": validation.interface_uuid,
                                    "is_valid": validation.is_valid,
                                    "missing_columns": validation.missing_columns,
                                    "type_mismatches": validation.type_mismatches.iter().map(|m| {
                                        serde_json::json!({
                                            "column_name": m.column_name,
                                            "expected_type": format!("{:?}", m.expected_type),
                                            "actual_type": format!("{:?}", m.actual_type),
                                        })
                                    }).collect::<Vec<_>>(),
                                    "constraint_violations": validation.constraint_violations.iter().map(|v| {
                                        serde_json::json!({
                                            "column_name": v.column_name,
                                            "constraint_type": v.constraint_type,
                                            "diagnostic": v.diagnostic,
                                            "record_uuid": v.record_uuid,
                                        })
                                    }).collect::<Vec<_>>(),
                                }));
                            }
                            Err(e) => return Err(e.into()),
                        }
                    } else {
                        return Err(AppError::code("interface.api.notFound", serde_json::json!({})));
                    }
                }
            }
            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code("grid.loading.noProject", serde_json::json!({}))),
    })
}

/// Add an interface column (improved version)
// Preserve the named invoke arguments; group-changing them breaks existing UI/plugin clients.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn add_interface_column(
    interface_uuid: &str,
    column_name: &str,
    column_type: &str,
    tooltip: Option<String>,
    color: Option<String>,
    default_value: Option<String>,
    curve_config: Option<devcel_core::types::CurveConfig>,
    app_handle: tauri::AppHandle,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    if let Err(e) = validate_data_name(column_name) {
        return Err(AppError::from(e));
    }
    let value_type = devcel_core::operations::value_type_from_string(column_type)?;
    let id = match uuid::Uuid::parse_str(interface_uuid) {
        Ok(v) => v,
        Err(e) => return Err(AppError::from(e)),
    };
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| {
        let Some(project) = project_opt else { return Err(AppError::code("grid.loading.noProject", serde_json::json!({}))); };
        let interface = project.get_interface(&id).ok_or_else(|| AppError::code("interface.api.notFound", serde_json::json!({})))?;
        if interface.columns.iter().any(|c| c.data_name == column_name) { return Err(AppError::owned("A column with the same name already exists")); }
        let name = interface.name.clone();
        let mut column = devcel_core::column::ColumnSchema::new();
        column.display_name = column_name.into(); column.data_name = column_name.into(); column.data_type = value_type;
        if let Some(config) = &curve_config { if column.data_type != ValueType::Curve || !config.start_value.is_finite() || !config.end_value.is_finite() { return Err(AppError::code("error.rules.typeConfiguration", serde_json::json!({}))); } }
        column.curve_config = curve_config;
        column.tooltip = tooltip.unwrap_or_default(); column.style.color = color.unwrap_or_else(|| "#FFFFFF".into()); column.default_value = default_value.unwrap_or_default();
        column.interface_origin = Some(id.to_string()); column.interface_origin_name_fallback = Some(name.clone());
        project.execute_command(devcel_core::commands::UpdateInterfaceCommand::new(id, vec![InterfaceChange::AddColumn { column }], None, Some(format!("Add column {column_name}"))), save_queue).map_err(AppError::from)?;
        let _ = app_handle.emit("interface-column-added", serde_json::json!({"interfaceUuid":id.to_string(),"interfaceName":name,"columnName":column_name,"projectSession":project.get_instance_id()}));
        Ok("ok".into())
    })
}

#[tauri::command]
fn remove_interface_column(
    interface_uuid: &str,
    column_name: &str,
    app_handle: tauri::AppHandle,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let id = match uuid::Uuid::parse_str(interface_uuid) {
        Ok(v) => v,
        Err(e) => return Err(AppError::from(e)),
    };
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project_opt, save_queue| {
        let Some(project) = project_opt else {
            return Err(AppError::code(
                "grid.loading.noProject",
                serde_json::json!({}),
            ));
        };
        project
            .execute_command(
                devcel_core::commands::UpdateInterfaceCommand::new(
                    id,
                    vec![InterfaceChange::RemoveColumn {
                        column_name: column_name.into(),
                    }],
                    None,
                    Some(format!("Remove column {column_name}")),
                ),
                save_queue,
            )
            .map_err(AppError::from)?;
        let _ = app_handle.emit(
            "interface-column-removed",
            serde_json::json!({"interfaceUuid":id.to_string(),"columnName":column_name}),
        );
        Ok("ok".into())
    })
}

#[tauri::command]
fn undo_interface_command(
    interface_uuid: &str,
    app: tauri::AppHandle,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        project
            .undo_interface_command(interface_uuid)
            .map_err(AppError::from)?;
        let _ = app.emit(
            "interface-history-applied",
            serde_json::json!({"interfaceUuid":interface_uuid}),
        );
        Ok("ok".into())
    })
}
#[tauri::command]
fn redo_interface_command(
    interface_uuid: &str,
    app: tauri::AppHandle,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        project
            .redo_interface_command(interface_uuid)
            .map_err(AppError::from)?;
        let _ = app.emit(
            "interface-history-applied",
            serde_json::json!({"interfaceUuid":interface_uuid}),
        );
        Ok("ok".into())
    })
}

/// Get the interfaces implemented by a table
#[tauri::command]
fn get_table_interfaces(
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
    table_uuid: String,
) -> Result<Vec<serde_json::Value>, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut(|project_opt| match project_opt {
        Some(project) => {
            ensure_project_session(project, &expected_project_session)?;
            project
                .ensure_table_loaded_by_uuid(&table_uuid)
                .map_err(AppError::from)?;

            // Read-only operation also used by automatic validation. Reloading from disk here
            // would erase Undo/Redo history for every table, including tables being edited.
            // Explicit load/P2P operations are responsible for incorporating external changes.

            // Find by UUID
            for table in project.tables_data.values() {
                if table.data.uuid == table_uuid {
                    let implementations = table
                        .data
                        .interface_implementations
                        .values()
                        .map(|impl_info| {
                            serde_json::json!({
                                "interface_uuid": impl_info.interface_uuid.to_string(),
                                "synced_version_id": impl_info.synced_version_id.to_string(),
                                "last_sync_date": impl_info.last_sync_date.to_rfc3339(),
                            })
                        })
                        .collect();
                    return Ok(implementations);
                }
            }

            Err(AppError::code("error.tableMissing", serde_json::json!({})))
        }
        None => Err(AppError::code(
            "grid.loading.noProject",
            serde_json::json!({}),
        )),
    })
}

#[tauri::command]
fn update_plugin_table(
    expected_project_session: String,
    table_uuid: String,
    data: serde_json::Value,
    expected_revision: String,
    acknowledgement: Option<String>,
    state: tauri::State<'_, std::sync::Mutex<crate::state::ProjectState>>,
    app_handle: tauri::AppHandle,
) -> Result<(), AppError> {
    {
        let state = state.lock().map_err(AppError::from)?;
        state.with_project_mut_save(|project, save_queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            ensure_project_session(project, &expected_project_session)?;
            devcel_core::plugin_data::update_table_data_checked(
                project,
                &table_uuid,
                &expected_revision,
                data,
                acknowledgement,
                save_queue.cloned(),
            )
            .map_err(AppError::from)
        })?;
    }
    // The save listener propagates to P2P. Immediately notify the originator to refetch.
    if let Err(error) = app_handle.emit(
        "p2p-data-changed",
        serde_json::json!({
            "operation": "UpdateTableData", "table_uuid": table_uuid,
            "project_session": expected_project_session,
        }),
    ) {
        eprintln!("Plugin table saved but frontend notification failed: {error}");
    }
    Ok(())
}

#[tauri::command]
async fn get_plugin_projects(
    state: tauri::State<'_, crate::state::ProjectState>,
) -> Result<Vec<serde_json::Value>, AppError> {
    let project = state.project.clone();
    let guard = project.lock().await;
    Ok(guard
        .as_ref()
        .map(|p| {
            serde_json::json!({
                "sessionId": p.get_instance_id(),
                "name": p.get_project_name(),
                "description": p.get_project_description(),
                "headerColor": p.get_project_header_color(),
                "path": p.get_project_path(),
            })
        })
        .into_iter()
        .collect())
}

#[tauri::command]
async fn lint_project_export(
    table_uuid: Option<String>,
    version: Option<u32>,
    expected_project_session: String,
    state: tauri::State<'_, ProjectState>,
) -> Result<Vec<devcel_core::export_validation::ExportIssue>, AppError> {
    let project = state.project.clone();
    let mut guard = project.lock().await;
    let project = guard
        .as_mut()
        .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
    ensure_project_session(project, &expected_project_session)?;
    formula_source_watcher::check_source_error(&expected_project_session)?;
    devcel_core::export_validation::lint_project(project, table_uuid.as_deref(), version)
        .map_err(AppError::from)
}

fn plugin_package_store(app: &tauri::AppHandle) -> Result<plugin_packages::PackageStore, AppError> {
    use tauri::Manager;
    let config = crate::settings_profile::directory(app)?;
    plugin_packages::versioned_store(
        &app.path().app_data_dir().map_err(|error| {
            AppError::code(
                "plugin.package.error.dataDirectory",
                serde_json::json!({"details": error.to_string()}),
            )
        })?,
        &app.package_info().version.to_string(),
    )
    .map(|store| store.with_settings_config(config))
}

// dialog.open({directory:true,recursive:true}) adds only that selected directory recursively.
// dialog.open({filters:[{name:'Plugin ZIP',extensions:['zip']}]}) / dialog.save grants exact file.
// Reject symlink roots, and require both lexical and canonical paths to be permitted.
fn selected_package_path(
    app: &tauri::AppHandle,
    path: &str,
    new_file: bool,
) -> Result<std::path::PathBuf, AppError> {
    use tauri_plugin_fs::FsExt;
    let path = std::path::PathBuf::from(path);
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err(AppError::code(
            "plugin.package.error.selectPath",
            serde_json::json!({}),
        ));
    }
    let scope = app.fs_scope();
    if !scope.is_allowed(&path) {
        return Err(AppError::code(
            "plugin.package.error.pathScope",
            serde_json::json!({"path": path.to_string_lossy()}),
        ));
    }
    if let Ok(metadata) = std::fs::symlink_metadata(&path) {
        if metadata.file_type().is_symlink() {
            return Err(AppError::code(
                "plugin.package.error.pathSymlink",
                serde_json::json!({"path": path.to_string_lossy()}),
            ));
        }
    }
    let canonical = if new_file && !path.try_exists().map_err(AppError::from)? {
        path.parent()
            .ok_or_else(|| {
                AppError::code("plugin.package.error.destination", serde_json::json!({}))
            })?
            .canonicalize()
            .map_err(AppError::from)?
            .join(path.file_name().ok_or_else(|| {
                AppError::code("plugin.package.error.destination", serde_json::json!({}))
            })?)
    } else {
        path.canonicalize().map_err(AppError::from)?
    };
    if !scope.is_allowed(&canonical) {
        return Err(AppError::code(
            "plugin.package.error.linkScope",
            serde_json::json!({"path": canonical.to_string_lossy()}),
        ));
    }
    Ok(canonical)
}

#[tauri::command]
fn preview_plugin_package(
    app: tauri::AppHandle,
    path: String,
) -> Result<plugin_packages::PackagePreview, AppError> {
    let path = selected_package_path(&app, &path, false)?;
    plugin_package_store(&app)?.preview_package(&path)
}
#[tauri::command]
fn install_plugin_package(
    app: tauri::AppHandle,
    path: String,
    expected_digest: String,
    conflict_policy: String,
) -> Result<plugin_packages::InstalledPluginPackage, AppError> {
    let path = selected_package_path(&app, &path, false)?;
    plugin_package_store(&app)?.install(&path, &expected_digest, &conflict_policy)
}
#[tauri::command]
fn export_plugin_package(
    app: tauri::AppHandle,
    directory: String,
    destination: String,
) -> Result<plugin_packages::PackagePreview, AppError> {
    let directory = selected_package_path(&app, &directory, false)?;
    let destination = selected_package_path(&app, &destination, true)?;
    plugin_package_store(&app)?.export_directory(&directory, &destination)
}
#[tauri::command]
fn list_installed_plugin_packages(
    app: tauri::AppHandle,
) -> Result<Vec<plugin_packages::InstalledPluginPackage>, AppError> {
    plugin_package_store(&app)?.list()
}
#[tauri::command]
fn list_removed_plugin_packages(
    app: tauri::AppHandle,
) -> Result<Vec<plugin_packages::InstalledPluginPackage>, AppError> {
    plugin_package_store(&app)?.list_removed()
}
#[tauri::command]
fn approve_plugin_package(
    app: tauri::AppHandle,
    plugin_id: String,
    digest: String,
    allow_full_app_access: bool,
) -> Result<plugin_packages::InstalledPluginPackage, AppError> {
    plugin_package_store(&app)?.approve(&plugin_id, &digest, allow_full_app_access)
}
#[tauri::command]
fn get_installed_plugin_source(
    app: tauri::AppHandle,
    plugin_id: String,
    expected_digest: String,
) -> Result<plugin_packages::InstalledPluginSource, AppError> {
    plugin_package_store(&app)?.source(&plugin_id, &expected_digest)
}
#[tauri::command]
fn set_plugin_package_enabled(
    app: tauri::AppHandle,
    plugin_id: String,
    expected_digest: String,
    enabled: bool,
) -> Result<(), AppError> {
    plugin_package_store(&app)?.set_enabled(&plugin_id, &expected_digest, enabled)
}
#[tauri::command]
fn remove_plugin_package(
    app: tauri::AppHandle,
    plugin_id: String,
    expected_digest: String,
) -> Result<(), AppError> {
    plugin_package_store(&app)?.remove(&plugin_id, &expected_digest)
}
#[tauri::command]
fn rollback_plugin_package(
    app: tauri::AppHandle,
    plugin_id: String,
    expected_digest: Option<String>,
    expected_restore_digest: String,
) -> Result<plugin_packages::InstalledPluginPackage, AppError> {
    plugin_package_store(&app)?.rollback(
        &plugin_id,
        expected_digest.as_deref(),
        &expected_restore_digest,
    )
}

#[tauri::command]
fn validate_plugin_catalog(json: String) -> Result<plugin_catalog::PluginCatalog, AppError> {
    plugin_catalog::validate_catalog_json(&json)
}

#[tauri::command]
async fn fetch_plugin_catalog(url: String) -> Result<plugin_catalog::PluginCatalog, AppError> {
    catalog_transport::fetch(&url).await
}

#[tauri::command]
fn duplicate_project_entry(
    source_path: String,
    dest_path: String,
    expected_project_session: String,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    let state = state.lock().unwrap();
    state.with_project_mut_save(|project, _queue| {
        let project = project
            .as_mut()
            .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
        ensure_project_session(project, &expected_project_session)?;
        let path = devcel_core::duplicate::duplicate_entry(
            project,
            std::path::Path::new(&source_path),
            std::path::Path::new(&dest_path),
        )
        .map_err(AppError::from)?;
        Ok(
            devcel_core::utils::absolute_path_to_tables_relative_path(project, &path)
                .unwrap_or_else(|| path.to_string_lossy().to_string()),
        )
    })
}

#[tauri::command]
fn set_column_select_config_command(
    table_uuid: String,
    column_uuid: String,
    config: Option<devcel_core::SelectConfig>,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            project
                .execute_command(
                    devcel_core::column_config::SetColumnConfigCommand::new(
                        table_uuid,
                        column_uuid,
                        devcel_core::column_config::Configuration::Select(config),
                    ),
                    queue,
                )
                .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

#[tauri::command]
fn configure_interface_column_command(
    interface_uuid: String,
    column_name: String,
    configuration: devcel_core::column_config::Configuration,
    state: tauri::State<Mutex<ProjectState>>,
) -> Result<String, AppError> {
    state
        .lock()
        .unwrap()
        .with_project_mut_save(|project, queue| {
            let project = project
                .as_mut()
                .ok_or_else(|| AppError::code("grid.loading.noProject", serde_json::json!({})))?;
            devcel_core::column_config::configure_interface_column(
                project,
                &interface_uuid,
                &column_name,
                configuration,
                queue,
            )
            .map_err(AppError::from)?;
            Ok("ok".into())
        })
}

#[cfg(test)]
mod settings_contract_tests;
