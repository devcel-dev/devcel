use crate::commands::CommandData;
use crate::operations::{DevcelOperation, DevcelResponse};
use crate::Project;
use async_trait::async_trait;
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;
#[cfg(feature = "p2p")]
use tokio::sync::RwLock;

/// Trait for handling Devcel operations
/// This can be implemented for local execution (Tauri) or remote execution (P2P)
#[async_trait]
pub trait OperationHandler: Send + Sync {
    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse;

    /// Only the elected-server receive path may apply committed replicas. Never expose via RPC.
    async fn apply_server_snapshot(&self, _snapshot: serde_json::Value) -> DevcelResponse {
        DevcelResponse::Error("This handler cannot receive server snapshots".into())
    }
}

/// Local operation handler that executes operations directly
pub struct LocalOperationHandler {
    pub project: Arc<Mutex<Option<Project>>>,
}

/// Resolve a column UUID from a column name (data_name) or UUID
fn resolve_column_uuid(project: &Project, table_uuid: &str, column: &str) -> Option<String> {
    project
        .tables_data
        .values()
        .find(|t| t.data.uuid == table_uuid)
        .and_then(|t| {
            t.data
                .schema
                .columns
                .iter()
                .find(|c| c.uuid == column || c.data_name == column)
                .map(|c| c.uuid.clone())
        })
}

/// Resolve dependent operations only after earlier commands in the transaction ran.
struct DeferredOperationCommand {
    operation: DevcelOperation,
    table_uuid: String,
    command: Option<Arc<StdMutex<dyn CommandData>>>,
}

impl DeferredOperationCommand {
    fn new(operation: DevcelOperation) -> Option<Self> {
        use DevcelOperation::*;

        let table_uuid = match &operation {
            AddColumn { table_uuid, .. }
            | RemoveColumn { table_uuid, .. }
            | AddRecord { table_uuid, .. }
            | DeleteRecord { table_uuid, .. }
            | SetRecordValue { table_uuid, .. }
            | SetRecordLabel { table_uuid, .. }
            | SetRecordMemoText { table_uuid, .. }
            | SetRecordMinVersion { table_uuid, .. }
            | SetRecordParentUuid { table_uuid, .. }
            | AddRecordTag { table_uuid, .. }
            | RemoveRecordTag { table_uuid, .. }
            | SetColumnTooltip { table_uuid, .. }
            | SetColumnDefaultValue { table_uuid, .. }
            | SetColumnColor { table_uuid, .. } => table_uuid.clone(),
            _ => return None,
        };

        Some(Self {
            operation,
            table_uuid,
            command: None,
        })
    }
}

impl CommandData for DeferredOperationCommand {
    fn execute(&mut self, project: &mut Project) -> crate::Result<()> {
        // Retain the resolved command for undo/redo, including generated UUIDs.
        if self.command.is_none() {
            self.command = Some(
                LocalOperationHandler::operation_to_command(&self.operation, project)?.ok_or_else(
                    || {
                        crate::DevcelError::InvalidOperation(
                            "Cannot resolve batch operation against the current project"
                                .to_string(),
                        )
                    },
                )?,
            );
        }
        self.command
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .execute(project)
    }

    fn undo(&mut self, project: &mut Project) -> crate::Result<()> {
        if let Some(command) = &self.command {
            command.lock().unwrap().undo(project)?;
        }
        Ok(())
    }

    fn get_table_uuid(&self) -> String {
        self.table_uuid.clone()
    }
}

/// Parse a string as an interface UUID
fn parse_interface_uuid(s: &str) -> Result<uuid::Uuid, String> {
    uuid::Uuid::parse_str(s).map_err(|e| format!("Invalid interface UUID {s}: {e}"))
}

/// Apply one InterfaceChange through UpdateInterfaceCommand, recording a new version
fn run_interface_change(
    project: &mut Project,
    interface_uuid: &str,
    change: crate::interface::InterfaceChange,
) -> DevcelResponse {
    let uuid = match parse_interface_uuid(interface_uuid) {
        Ok(u) => u,
        Err(e) => return DevcelResponse::Error(e.into()),
    };
    let cmd = crate::commands::UpdateInterfaceCommand::new(
        uuid,
        vec![change],
        Some("cli".to_string()),
        None,
    );
    match project.execute_command(cmd, None) {
        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
        Err(e) => DevcelResponse::Error(e.into()),
    }
}

/// Get interface-defined columns as applied to the table,
/// including interface-origin column types
fn interface_column_value_type(
    project: &Project,
    interface_uuid: &uuid::Uuid,
    column_name: &str,
) -> Option<crate::types::ValueType> {
    project.get_interface(interface_uuid).and_then(|iface| {
        iface
            .columns
            .iter()
            .find(|c| c.data_name == column_name)
            .map(|c| c.data_type.clone())
    })
}

/// Convert an interface to summary JSON for list views
fn interface_summary_json(
    rel_path: &str,
    interface: &crate::interface::Interface,
) -> serde_json::Value {
    serde_json::json!({
        "uuid": interface.uuid.to_string(),
        "name": interface.name,
        "path": rel_path,
        "description": interface.description,
        "column_count": interface.columns.len(),
        "extends": interface.extends.iter().map(|u| u.to_string()).collect::<Vec<_>>(),
        "current_version_id": interface.current_version_id.to_string(),
    })
}

/// Build detailed interface JSON, including implementing tables
fn interface_details_json(
    project: &Project,
    interface: &crate::interface::Interface,
) -> Result<serde_json::Value, crate::AppError> {
    let mut value = serde_json::to_value(interface)?;
    let implementing_tables: Vec<serde_json::Value> = project
        .get_tables_for_interface(&interface.uuid)?
        .into_iter()
        .map(|table| {
            serde_json::json!({
                "uuid": table.uuid,
                "data_name": table.data_name,
                "display_name": table.display_name,
            })
        })
        .collect();
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "implementing_tables".to_string(),
            serde_json::Value::Array(implementing_tables),
        );
    }
    Ok(value)
}

impl LocalOperationHandler {
    pub fn new(project: Arc<Mutex<Option<Project>>>) -> Self {
        Self { project }
    }

    /// Execute a batch of operations atomically using TransactionCommand
    async fn execute_batch_operations(
        &self,
        project: &mut Project,
        operations: Vec<DevcelOperation>,
    ) -> crate::Result<Vec<serde_json::Value>> {
        use crate::commands::TransactionCommand;

        let mut transaction = TransactionCommand::new("Batch operation".to_string());
        let mut responses = Vec::new();

        // Check supported operation kinds up front, but defer name/UUID resolution
        // until execution so earlier operations can create the required columns.
        for operation in operations {
            match DeferredOperationCommand::new(operation) {
                Some(command) => {
                    transaction.add_command(Arc::new(StdMutex::new(command)));
                    responses.push(serde_json::json!({ "success": true }));
                }
                None => {
                    return Err(crate::DevcelError::InvalidOperation(
                        "Cannot mix read-only operations with write operations in a batch".into(),
                    ));
                }
            }
        }

        // Preserve structured validation failures from the atomic command boundary.
        if !transaction.is_empty() {
            project.execute_command(transaction, None)?;
        }
        Ok(responses)
    }

    /// Convert a DevcelOperation to a Command (if possible)
    fn operation_to_command(
        operation: &DevcelOperation,
        _project: &Project,
    ) -> crate::Result<Option<Arc<StdMutex<dyn CommandData>>>> {
        use crate::commands::*;
        use std::sync::Arc;
        use std::sync::Mutex as StdMutex;

        Ok(match operation {
            DevcelOperation::AddColumn {
                table_uuid,
                column_name,
                column_type,
            } => {
                let value_type = crate::operations::value_type_from_string(column_type)
                    .map_err(crate::DevcelError::Validation)?;
                Some(Arc::new(StdMutex::new(AddColumnCommand::new(
                    table_uuid.clone(),
                    column_name,
                    value_type,
                    None, // tooltip
                    None, // color
                    None, // default_value
                ))))
            }
            DevcelOperation::RemoveColumn {
                table_uuid,
                column_name,
            } => {
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .ok_or_else(|| {
                        crate::DevcelError::NotFound(format!("Column not found: {column_name}"))
                    })?;
                Some(Arc::new(StdMutex::new(RemoveColumnCommand::new(
                    table_uuid.clone(),
                    column_uuid,
                ))))
            }
            DevcelOperation::AddRecord {
                table_uuid,
                record_uuid,
            } => Some(Arc::new(StdMutex::new(if record_uuid.is_empty() {
                AddRecordCommand::new(table_uuid.clone())
            } else {
                AddRecordCommand::with_uuid(table_uuid.clone(), record_uuid.clone())
            }))),
            DevcelOperation::DeleteRecord {
                table_uuid,
                record_uuid,
            } => Some(Arc::new(StdMutex::new(RemoveRecordCommand::new(
                table_uuid.clone(),
                record_uuid.clone(),
            )))),
            DevcelOperation::SetRecordValue {
                table_uuid,
                record_uuid,
                column_name,
                value,
            } => {
                // Resolve column names to UUIDs; pass unresolved values through to fail during execution
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .unwrap_or_else(|| column_name.clone());
                Some(Arc::new(StdMutex::new(SetRecordValueCommand::new(
                    table_uuid.clone(),
                    record_uuid.clone(),
                    column_uuid,
                    value.clone(),
                ))))
            }
            DevcelOperation::SetRecordLabel {
                table_uuid,
                record_uuid,
                label,
            } => Some(Arc::new(StdMutex::new(SetRecordLabelCommand::new(
                table_uuid.clone(),
                record_uuid.clone(),
                label.clone(),
            )))),
            DevcelOperation::SetRecordMemoText {
                table_uuid,
                record_uuid,
                column_name,
                memo_text,
            } => {
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .ok_or_else(|| {
                        crate::DevcelError::NotFound(format!("Column not found: {column_name}"))
                    })?;
                Some(Arc::new(StdMutex::new(SetRecordMemoTextCommand::new(
                    table_uuid.clone(),
                    record_uuid.clone(),
                    column_uuid,
                    memo_text.clone(),
                ))))
            }
            DevcelOperation::SetRecordMinVersion {
                table_uuid,
                record_uuid,
                min_version,
            } => {
                // The operation uses String while the command uses u32; parsing failure means conversion is unavailable
                let version = min_version
                    .parse::<u32>()
                    .map_err(|error| crate::DevcelError::Validation(error.to_string()))?;
                Some(Arc::new(StdMutex::new(SetRecordMinVersionCommand::new(
                    table_uuid.clone(),
                    record_uuid.clone(),
                    version,
                ))))
            }
            DevcelOperation::SetRecordParentUuid {
                table_uuid,
                record_uuid,
                parent_uuid,
            } => Some(Arc::new(StdMutex::new(SetRecordParentUuidCommand::new(
                table_uuid.clone(),
                record_uuid.clone(),
                parent_uuid.clone(),
            )))),
            DevcelOperation::AddRecordTag {
                table_uuid,
                record_uuid,
                tag,
            } => Some(Arc::new(StdMutex::new(AddRecordTagCommand::new(
                table_uuid.clone(),
                record_uuid.clone(),
                tag.clone(),
            )))),
            DevcelOperation::RemoveRecordTag {
                table_uuid,
                record_uuid,
                tag,
            } => Some(Arc::new(StdMutex::new(RemoveRecordTagCommand::new(
                table_uuid.clone(),
                record_uuid.clone(),
                tag.clone(),
            )))),
            DevcelOperation::SetColumnTooltip {
                table_uuid,
                column_name,
                tooltip,
            } => {
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .ok_or_else(|| {
                        crate::DevcelError::NotFound(format!("Column not found: {column_name}"))
                    })?;
                Some(Arc::new(StdMutex::new(SetColumnTooltipCommand::new(
                    table_uuid.clone(),
                    column_uuid,
                    tooltip.clone(),
                ))))
            }
            DevcelOperation::SetColumnDefaultValue {
                table_uuid,
                column_name,
                default_value,
            } => {
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .ok_or_else(|| {
                        crate::DevcelError::NotFound(format!("Column not found: {column_name}"))
                    })?;
                Some(Arc::new(StdMutex::new(SetColumnDefaultValueCommand::new(
                    table_uuid.clone(),
                    column_uuid,
                    default_value.clone(),
                ))))
            }
            DevcelOperation::SetColumnColor {
                table_uuid,
                column_name,
                color,
            } => {
                let column_uuid = resolve_column_uuid(_project, table_uuid, column_name)
                    .ok_or_else(|| {
                        crate::DevcelError::NotFound(format!("Column not found: {column_name}"))
                    })?;
                Some(Arc::new(StdMutex::new(SetColumnColorCommand::new(
                    table_uuid.clone(),
                    column_uuid,
                    color.clone(),
                ))))
            }
            // Add more operation-to-command conversions as needed
            _ => None, // Operations that don't have command equivalents
        })
    }
}

/// Remote operation handler that forwards operations to a P2P server
#[cfg(feature = "p2p")]
pub struct RemoteOperationHandler {
    /// The client connection to forward operations through
    pub client: Arc<RwLock<Option<Box<dyn crate::p2p_manager::DevcelClient>>>>,
}

#[cfg(feature = "p2p")]
impl RemoteOperationHandler {
    pub fn new(client: Arc<RwLock<Option<Box<dyn crate::p2p_manager::DevcelClient>>>>) -> Self {
        Self { client }
    }
}

#[async_trait]
impl OperationHandler for LocalOperationHandler {
    async fn apply_server_snapshot(&self, snapshot: serde_json::Value) -> DevcelResponse {
        let mut guard = self.project.lock().await;
        match guard.as_mut() {
            Some(project) => match crate::replication::apply(project, snapshot) {
                Ok(()) => DevcelResponse::Ok(serde_json::json!({"success": true})),
                Err(error) => DevcelResponse::Error(error.into()),
            },
            None => DevcelResponse::Error("No project open".into()),
        }
    }

    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        use DevcelOperation::*;
        if !operation.is_read_only()
            && !matches!(operation, OpenProject { .. } | CreateProject { .. })
        {
            let guard = self.project.lock().await;
            if let Some(project) = guard.as_ref() {
                if let Err(error) = project.ensure_tag_transactions_ready() {
                    return DevcelResponse::Error(error.into());
                }
            }
        }
        match operation {
            // Project operations
            HasProject => {
                let project = self.project.lock().await;
                DevcelResponse::Ok(serde_json::json!({
                    "value": project.is_some()
                }))
            }

            GetProjectInfo => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    DevcelResponse::Ok(serde_json::json!({
                        "name": proj.get_project_name(),
                        "description": proj.get_project_description(),
                        "path": proj.get_project_path(),
                        "header_color": proj.get_project_header_color()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            CreateProject {
                project_name,
                project_path,
                description,
                header_color,
            } => {
                let mut project_guard = self.project.lock().await;

                // Close existing project if open
                if let Some(ref mut proj) = *project_guard {
                    if let Err(error) = proj.close_project() {
                        return DevcelResponse::Error(error.into());
                    }
                }

                match Project::create_project(
                    &project_name,
                    &project_path,
                    &description,
                    &header_color,
                ) {
                    Ok(new_project) => {
                        *project_guard = Some(new_project);
                        DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        }))
                    }
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }

            OpenProject { project_path } => {
                let mut project_guard = self.project.lock().await;

                // Close existing project if open
                if let Some(ref mut proj) = *project_guard {
                    if let Err(error) = proj.close_project() {
                        return DevcelResponse::Error(error.into());
                    }
                }

                match Project::open_project(&project_path) {
                    Ok(new_project) => {
                        *project_guard = Some(new_project);
                        DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        }))
                    }
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }

            SaveProject => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.save_project() {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            CloseProject => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.close_project() {
                        Ok(_) => {
                            *project = None;
                            DevcelResponse::Ok(serde_json::json!({
                                "success": true
                            }))
                        }
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DeleteProject { .. } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.delete_project() {
                        Ok(_) => {
                            *project = None;
                            DevcelResponse::Ok(serde_json::json!({
                                "success": true
                            }))
                        }
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Table operations

            // Table operations
            CreateTable {
                parent_path,
                data_name,
                display_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    use std::path::PathBuf;

                    // Build the table path from parent_path and data_name.
                    let table_path = if parent_path.is_empty() || parent_path == "/" {
                        PathBuf::from(format!("{data_name}.table.toml"))
                    } else {
                        PathBuf::from(parent_path).join(format!("{data_name}.table.toml"))
                    };

                    match proj.create_table(table_path.clone()) {
                        Ok(created_path) => {
                            // Get the UUID from the created table
                            if let Some(table) = proj.tables_data.get_mut(&created_path) {
                                // Apply the display name when specified
                                // (create_table derives a display name from the filename)
                                if !display_name.is_empty() {
                                    table.data.display_name = display_name.clone();
                                    table.is_dirty = true;
                                }
                                let uuid = table.data.uuid.clone();
                                if !display_name.is_empty() {
                                    if let Err(e) = proj.save_project() {
                                        return DevcelResponse::Error(e.into());
                                    }
                                }
                                DevcelResponse::Ok(serde_json::json!({
                                    "table_uuid": uuid
                                }))
                            } else {
                                DevcelResponse::Ok(serde_json::json!({
                                    "table_uuid": data_name
                                }))
                            }
                        }
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetTableData { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    // Find table by UUID
                    for table_wrapper in proj.tables_data.values() {
                        if table_wrapper.data.uuid == table_uuid {
                            let table_json = serde_json::json!({
                                "table": table_wrapper.data,
                                "revision": crate::cell_rules::revision(&table_wrapper.data),
                            });
                            return DevcelResponse::Ok(table_json);
                        }
                    }
                    DevcelResponse::Error(
                        (format!("Table with UUID {table_uuid} not found")).into(),
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Column operations
            AddColumn {
                table_uuid,
                column_name,
                column_type,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::AddColumnCommand;
                    use crate::operations::value_type_from_string;

                    let value_type = match value_type_from_string(&column_type) {
                        Ok(vt) => vt,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };

                    let command = AddColumnCommand::new(
                        table_uuid.clone(),
                        &column_name,
                        value_type,
                        None, // tooltip
                        None, // color
                        None, // default_value
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Record operations
            SetRecordValue {
                table_uuid,
                record_uuid,
                column_name,
                value,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetRecordValueCommand;

                    // SetRecordValueCommand requires a column UUID, so
                    // accept either a column name (data_name) or UUID and resolve it
                    let column_uuid = match resolve_column_uuid(proj, &table_uuid, &column_name) {
                        Some(uuid) => uuid,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Column not found: {column_name}")).into(),
                            )
                        }
                    };

                    let command = SetRecordValueCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        column_uuid,
                        value.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Server management
            Ping => DevcelResponse::Ok(serde_json::json!({
                "timestamp": chrono::Utc::now().timestamp()
            })),

            GetServerInfo => {
                let project = self.project.lock().await;
                DevcelResponse::Ok(serde_json::json!({
                    "server_running": false,
                    "uptime_seconds": null,
                    "connected_clients": 0,
                    "has_active_project": project.is_some()
                }))
            }

            Shutdown => {
                // For local handler, shutdown doesn't make sense
                DevcelResponse::Error("Cannot shutdown local handler".into())
            }

            SetInterfaceColumnCurveConfig {
                interface_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                match crate::column_config::configure_interface_column(
                    project,
                    &interface_uuid,
                    &column_name,
                    crate::column_config::Configuration::Curve(config),
                    None,
                ) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({"success":true})),
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }
            SetInterfaceColumnTableRefConfig {
                interface_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                match crate::column_config::configure_interface_column(
                    project,
                    &interface_uuid,
                    &column_name,
                    crate::column_config::Configuration::TableRef(config),
                    None,
                ) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({"success":true})),
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }
            SetInterfaceColumnSelectConfig {
                interface_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                match crate::column_config::configure_interface_column(
                    project,
                    &interface_uuid,
                    &column_name,
                    crate::column_config::Configuration::Select(config),
                    None,
                ) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({"success":true})),
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }
            SetColumnCurveConfig {
                table_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let Some(column_uuid) = resolve_column_uuid(project, &table_uuid, &column_name)
                else {
                    return DevcelResponse::Error(
                        (format!("Column not found: {column_name}")).into(),
                    );
                };
                let command = crate::column_config::SetColumnConfigCommand::new(
                    table_uuid,
                    column_uuid,
                    crate::column_config::Configuration::Curve(config),
                );
                match project.execute_command(command, None) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }

            SetColumnTableRefConfig {
                table_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let Some(column_uuid) = resolve_column_uuid(project, &table_uuid, &column_name)
                else {
                    return DevcelResponse::Error(
                        (format!("Column not found: {column_name}")).into(),
                    );
                };
                let command = crate::column_config::SetColumnConfigCommand::new(
                    table_uuid,
                    column_uuid,
                    crate::column_config::Configuration::TableRef(config),
                );
                match project.execute_command(command, None) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }

            SetColumnSelectConfig {
                table_uuid,
                column_name,
                config,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let Some(column_uuid) = resolve_column_uuid(project, &table_uuid, &column_name)
                else {
                    return DevcelResponse::Error(
                        (format!("Column not found: {column_name}")).into(),
                    );
                };
                let command = crate::column_config::SetColumnConfigCommand::new(
                    table_uuid,
                    column_uuid,
                    crate::column_config::Configuration::Select(config),
                );
                match project.execute_command(command, None) {
                    Ok(()) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }

            GetTablePresentation { table_uuid } => {
                let mut guard = self.project.lock().await;
                let Some(project) = guard.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let table = project.find_table_by_uuid(&table_uuid).unwrap();
                let context =
                    match crate::formula_context::ProjectFormulaContext::new(project, None) {
                        Ok(context) => context,
                        Err(error) => return DevcelResponse::Error(error.into()),
                    };
                let presentation = crate::cell_rules::presentation_with_evaluator(
                    &table.data,
                    &mut |data, column, record, formula| {
                        context.evaluate_cell_with_override(data, column, record, formula)
                    },
                );
                DevcelResponse::Ok(serde_json::to_value(presentation).unwrap())
            }
            PrepareRecordDraft { table_uuid } => {
                let mut guard = self.project.lock().await;
                let Some(project) = guard.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                match crate::table_mutation::prepare_record_draft(project, &table_uuid) {
                    Ok(draft) => DevcelResponse::Ok(serde_json::to_value(draft).unwrap()),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }
            ApplyTableMutation { request } => {
                let mut guard = self.project.lock().await;
                match guard.as_mut() {
                    Some(project) => match crate::table_mutation::apply(project, request, None) {
                        Ok(result) => DevcelResponse::Ok(serde_json::to_value(result).unwrap()),
                        Err(error) => DevcelResponse::Error(error.into()),
                    },
                    None => DevcelResponse::Error("No project open".into()),
                }
            }

            UpdateTableEditSettings { request } => {
                let mut guard = self.project.lock().await;
                match guard.as_mut() {
                    Some(project) => match crate::edit_controls::update_table_edit_settings(
                        project, request, None,
                    ) {
                        Ok(result) => DevcelResponse::Ok(serde_json::to_value(result).unwrap()),
                        Err(error) => DevcelResponse::Error(error.into()),
                    },
                    None => DevcelResponse::Error("No project open".into()),
                }
            }
            SetColumnReadOnly { request } => {
                let mut guard = self.project.lock().await;
                match guard.as_mut() {
                    Some(project) => {
                        match crate::edit_controls::set_column_read_only(project, request, None) {
                            Ok(result) => DevcelResponse::Ok(serde_json::to_value(result).unwrap()),
                            Err(error) => DevcelResponse::Error(error.into()),
                        }
                    }
                    None => DevcelResponse::Error("No project open".into()),
                }
            }

            UpdateTableData {
                table_uuid,
                expected_revision,
                data,
                acknowledgement,
            } => {
                let mut project = self.project.lock().await;
                match project.as_mut() {
                    Some(project) => match crate::plugin_data::update_table_data_checked(
                        project,
                        &table_uuid,
                        &expected_revision,
                        data,
                        acknowledgement,
                        None,
                    ) {
                        Ok(()) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(error) => DevcelResponse::Error(error.into()),
                    },
                    None => DevcelResponse::Error("No project open".into()),
                }
            }

            // P2P Sync operations
            GetFullProjectState => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    use crate::operations::{FullProjectState, TableInfo};

                    // Collect table information
                    let mut tables = Vec::new();
                    let mut loaded_tables = Vec::new();

                    // Get all project entries
                    let entries = match proj.get_project_entries() {
                        Ok(entries) => entries,
                        Err(e) => {
                            return DevcelResponse::Error(
                                (format!("Failed to get project entries: {e}")).into(),
                            )
                        }
                    };
                    for entry in &entries {
                        if entry.entry_type == crate::types::ProjectEntryType::Table {
                            let table_path = match proj
                                .resolve_table_path(&std::path::PathBuf::from(&entry.path))
                            {
                                Ok(path) => path,
                                Err(error) => return DevcelResponse::Error(error.into()),
                            };
                            let is_loaded = proj.tables_data.contains_key(&table_path);

                            // Find the actual table data
                            if let Some((_, table_wrapper)) =
                                proj.tables_data.iter().find(|(p, _)| *p == &table_path)
                            {
                                let uuid = &table_wrapper.data.uuid;
                                if is_loaded {
                                    loaded_tables.push(uuid.clone());
                                }

                                tables.push(TableInfo {
                                    uuid: uuid.clone(),
                                    path: entry.path.clone(),
                                    display_name: table_wrapper.data.display_name.clone(),
                                    data_name: table_wrapper.data.metadata.data_name.clone(),
                                    is_loaded,
                                });
                            }
                        }
                    }

                    let project_state = FullProjectState {
                        project_info: crate::operations::ProjectInfo {
                            name: proj.get_project_name(),
                            description: proj.get_project_description(),
                            path: proj.get_project_path(),
                            header_color: proj.get_project_header_color(),
                        },
                        tables,
                        loaded_tables,
                    };

                    let mut state = serde_json::to_value(project_state).unwrap();
                    match crate::replication::capture(proj) {
                        Ok(snapshot) => {
                            state["replication_state"] = snapshot;
                            DevcelResponse::Ok(state)
                        }
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ReloadProjectTags => {
                let mut project = self.project.lock().await;
                match project.as_mut() {
                    Some(project) => match crate::project_tags::reload(project) {
                        Ok(changed) => {
                            DevcelResponse::Ok(serde_json::json!({ "changed": changed }))
                        }
                        Err(error) => DevcelResponse::Error(error.into()),
                    },
                    None => DevcelResponse::Error("No project open".into()),
                }
            }

            ReloadInterfaces => {
                let mut project = self.project.lock().await;
                match project.as_mut() {
                    Some(project) => match project.reload_interfaces() {
                        Ok(()) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    },
                    None => DevcelResponse::Error("No project open".into()),
                }
            }

            // Table operations - continued
            InitializeEmptyTable { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    let Some(table) = proj.find_table_by_uuid(&table_uuid) else {
                        return DevcelResponse::Error(
                            (format!("Table {table_uuid} not found")).into(),
                        );
                    };
                    if !table.data.records.is_empty() {
                        return DevcelResponse::Ok(serde_json::json!({"success": true}));
                    }
                    match proj
                        .execute_command(crate::commands::AddRecordCommand::new(table_uuid), None)
                    {
                        Ok(()) => DevcelResponse::Ok(serde_json::json!({"success": true})),
                        Err(error) => DevcelResponse::Error(error.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DeleteTable { table_path } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.delete_table(std::path::PathBuf::from(table_path)) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            MoveTable {
                table_path,
                new_parent_path,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    // Project::move_table requires the full destination path (parent and filename).
                    // new_parent_path is a directory, so append the original filename
                    let file_name = match std::path::Path::new(&table_path)
                        .file_name()
                        .and_then(|n| n.to_str())
                    {
                        Some(n) => n.to_string(),
                        None => {
                            return DevcelResponse::Error(
                                (format!("Invalid table path: {table_path}")).into(),
                            )
                        }
                    };
                    let dest = if new_parent_path.is_empty() {
                        file_name
                    } else {
                        format!("{new_parent_path}/{file_name}")
                    };
                    match proj.move_table(
                        std::path::PathBuf::from(table_path),
                        std::path::PathBuf::from(dest),
                    ) {
                        Ok(new_path) => DevcelResponse::Ok(serde_json::json!({
                            "success": true,
                            "new_path": new_path.to_string_lossy().to_string()
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DuplicateTable {
                table_path,
                new_data_name,
                new_display_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let dest_path = if table_path.contains('/') {
                        let parent = table_path.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
                        format!("{parent}/{new_data_name}.table.toml")
                    } else {
                        format!("{new_data_name}.table.toml")
                    };
                    match crate::duplicate::duplicate_entry(
                        proj,
                        std::path::Path::new(&table_path),
                        std::path::Path::new(&dest_path),
                    ) {
                        Ok(new_path) => {
                            // Apply the duplicate's display name when specified
                            if !new_display_name.is_empty() {
                                if let Some(table) = proj.tables_data.get_mut(&new_path) {
                                    table.data.display_name = new_display_name.clone();
                                    table.is_dirty = true;
                                }
                                if let Err(e) = proj.save_project() {
                                    return DevcelResponse::Error(e.into());
                                }
                            }
                            DevcelResponse::Ok(serde_json::json!({
                                "new_path": new_path.to_string_lossy().to_string()
                            }))
                        }
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RenameTable {
                table_uuid,
                new_display_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RenameTableDisplayNameCommand;

                    let command =
                        RenameTableDisplayNameCommand::new(table_uuid.clone(), &new_display_name);

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            LoadTable { table_path } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    // Resolve Tables-relative paths from GetProjectEntries to absolute paths
                    let full_path =
                        match proj.resolve_table_path(&std::path::PathBuf::from(table_path)) {
                            Ok(p) => p,
                            Err(e) => return DevcelResponse::Error(e.into()),
                        };
                    match proj.ensure_table_loaded_with_save_queue(&full_path, None, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ReloadTable { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    match proj.reload_table(&table_uuid) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetLoadedTables => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let loaded_tables: Vec<String> = proj
                        .tables_data
                        .keys()
                        .filter_map(|path| {
                            proj.tables_data
                                .get(path)
                                .map(|wrapper| wrapper.data.uuid.clone())
                        })
                        .collect();

                    DevcelResponse::Ok(serde_json::json!({
                        "tables": loaded_tables
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetProjectEntries => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let entries = match proj.get_project_entries() {
                        Ok(entries) => entries,
                        Err(e) => {
                            return DevcelResponse::Error(
                                (format!("Failed to get project entries: {e}")).into(),
                            )
                        }
                    };
                    let entries_json: Vec<serde_json::Value> = entries
                        .iter()
                        .map(|entry| {
                            match entry.entry_type {
                                crate::types::ProjectEntryType::Directory => {
                                    serde_json::json!({
                                        "type": "directory",
                                        "modified": entry.modified,
                                        "path": entry.path
                                    })
                                }
                                crate::types::ProjectEntryType::Table => {
                                    // For tables, we need to find the UUID from tables_data
                                    // (tables_data keys are absolute; entry.path is relative to Tables)
                                    let uuid = proj
                                        .tables_data
                                        .iter()
                                        .find(|(path, _)| {
                                            crate::utils::absolute_path_to_tables_relative_path(
                                                proj, path,
                                            )
                                            .as_deref()
                                                == Some(entry.path.as_str())
                                        })
                                        .map(|(_, table)| &table.data.uuid)
                                        .unwrap_or(&entry.path);
                                    serde_json::json!({
                                        "type": "table",
                                        "modified": entry.modified,
                                        "path": entry.path,
                                        "uuid": uuid
                                    })
                                }
                                crate::types::ProjectEntryType::Markdown => {
                                    serde_json::json!({
                                        "type": "markdown",
                                        "modified": entry.modified,
                                        "path": entry.path
                                    })
                                }
                                _ => {
                                    serde_json::json!({
                                        "type": "other",
                                        "modified": entry.modified,
                                        "path": entry.path
                                    })
                                }
                            }
                        })
                        .collect();

                    DevcelResponse::Ok(serde_json::json!({
                        "entries": entries_json
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetTableList { parent_path } => {
                let project = self.project.lock().await;
                let Some(project) = project.as_ref() else {
                    return DevcelResponse::Error("No project open".into());
                };
                let catalog = match project.get_table_catalog() {
                    Ok(catalog) => catalog,
                    Err(error) => return DevcelResponse::Error(error.into()),
                };
                let parent = std::path::PathBuf::from(parent_path);
                let tables: Vec<serde_json::Value> =
                    catalog
                        .into_iter()
                        .filter_map(|table| {
                            let path = crate::utils::absolute_path_to_tables_relative_path(
                                project,
                                &std::path::PathBuf::from(&table.path),
                            )?;
                            let matches = std::path::Path::new(&path)
                                .parent()
                                .is_some_and(|p| p == parent);
                            matches.then(|| serde_json::json!({
                        "path": path, "uuid": table.uuid,
                        "display_name": table.display_name, "data_name": table.data_name,
                    }))
                        })
                        .collect();
                DevcelResponse::Ok(serde_json::json!({"tables": tables}))
            }

            GetTableDataRange {
                table_uuid,
                start_row,
                end_row,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    // Find table by UUID
                    for table_wrapper in proj.tables_data.values() {
                        if table_wrapper.data.uuid == table_uuid {
                            let start = start_row as usize;
                            let end = (end_row as usize).min(table_wrapper.data.records.len());

                            if start <= end {
                                let records: Vec<&crate::record::Record> =
                                    table_wrapper.data.records[start..end].iter().collect();
                                return DevcelResponse::Ok(serde_json::json!({
                                    "records": records
                                }));
                            } else {
                                return DevcelResponse::Error("Invalid range".into());
                            }
                        }
                    }
                    DevcelResponse::Error(
                        (format!("Table with UUID {table_uuid} not found")).into(),
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetTableDataByUuids {
                table_uuid,
                record_uuids,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    // Find table by UUID
                    for table_wrapper in proj.tables_data.values() {
                        if table_wrapper.data.uuid == table_uuid {
                            let records: Vec<&crate::record::Record> = table_wrapper
                                .data
                                .records
                                .iter()
                                .filter(|r| record_uuids.contains(&r.uuid))
                                .collect();

                            return DevcelResponse::Ok(serde_json::json!({
                                "records": records
                            }));
                        }
                    }
                    DevcelResponse::Error(
                        (format!("Table with UUID {table_uuid} not found")).into(),
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ExportTableData {
                table_uuid,
                export_mode,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::json_export::{
                        export_table_as_json_in_project_with_validation, ExportMode,
                    };

                    let mode = match export_mode.as_str() {
                        "full" => ExportMode::Full,
                        "minimal" => ExportMode::Minimal,
                        _ => return DevcelResponse::Error("Invalid export mode".into()),
                    };

                    // Find table by UUID
                    for table_wrapper in proj.tables_data.values() {
                        if table_wrapper.data.uuid == table_uuid {
                            match export_table_as_json_in_project_with_validation(
                                proj,
                                &table_wrapper.data,
                                mode,
                                false,
                            ) {
                                Ok(json_str) => {
                                    return DevcelResponse::Ok(serde_json::json!({
                                        "data": json_str
                                    }))
                                }
                                Err(e) => return DevcelResponse::Error(e.into()),
                            }
                        }
                    }
                    DevcelResponse::Error((format!("Table {table_uuid} not found")).into())
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SearchTableData {
                table_uuid,
                search_text,
                search_columns,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    // Find table by UUID
                    for table_wrapper in proj.tables_data.values() {
                        if table_wrapper.data.uuid == table_uuid {
                            let mut results = Vec::new();

                            for (row_idx, record) in table_wrapper.data.records.iter().enumerate() {
                                for col in &search_columns {
                                    // Look up the column definition and read through the canonical access path
                                    // (To include interface-origin columns)
                                    let value = table_wrapper
                                        .data
                                        .schema
                                        .columns
                                        .iter()
                                        .find(|c| &c.data_name == col)
                                        .and_then(|c| record.get_cell_value(c));
                                    if let Some(value) = value {
                                        if value
                                            .to_lowercase()
                                            .contains(&search_text.to_lowercase())
                                        {
                                            results.push(serde_json::json!({
                                                "row": row_idx,
                                                "column": col,
                                                "value": value,
                                                "record_uuid": record.uuid
                                            }));
                                        }
                                    }
                                }
                            }

                            return DevcelResponse::Ok(serde_json::json!({
                                "results": results
                            }));
                        }
                    }
                    DevcelResponse::Error(
                        (format!("Table with UUID {table_uuid} not found")).into(),
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Column operations - continued
            InsertColumn {
                table_uuid,
                index,
                column_name,
                column_type,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::InsertColumnCommand;
                    use crate::operations::value_type_from_string;

                    let value_type = match value_type_from_string(&column_type) {
                        Ok(vt) => vt,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };

                    let command = InsertColumnCommand::new(
                        table_uuid.clone(),
                        &column_name,
                        value_type,
                        index as usize,
                        None, // tooltip
                        None, // color
                        None, // default_value
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RemoveColumn {
                table_uuid,
                column_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RemoveColumnCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &column_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {column_name}")).into(),
                        );
                    };

                    let command = RemoveColumnCommand::new(table_uuid.clone(), column_uuid);

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RenameColumn {
                table_uuid,
                old_name,
                new_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RenameColumnCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &old_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {old_name}")).into(),
                        );
                    };

                    let command =
                        RenameColumnCommand::new(table_uuid.clone(), column_uuid, &new_name);

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetColumnTooltip {
                table_uuid,
                column_name,
                tooltip,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetColumnTooltipCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &column_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {column_name}")).into(),
                        );
                    };

                    let command = SetColumnTooltipCommand::new(
                        table_uuid.clone(),
                        column_uuid,
                        tooltip.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetColumnMemoText {
                table_uuid,
                column_name,
                memo_text,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetColumnMemoTextCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &column_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {column_name}")).into(),
                        );
                    };

                    let command = SetColumnMemoTextCommand::new(
                        table_uuid.clone(),
                        column_uuid,
                        memo_text.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetColumnDefaultValue {
                table_uuid,
                column_name,
                default_value,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetColumnDefaultValueCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &column_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {column_name}")).into(),
                        );
                    };

                    let command = SetColumnDefaultValueCommand::new(
                        table_uuid.clone(),
                        column_uuid,
                        default_value.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetColumnColor {
                table_uuid,
                column_name,
                color,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetColumnColorCommand;
                    let Some(column_uuid) = resolve_column_uuid(proj, &table_uuid, &column_name)
                    else {
                        return DevcelResponse::Error(
                            (format!("Column not found: {column_name}")).into(),
                        );
                    };

                    let command =
                        SetColumnColorCommand::new(table_uuid.clone(), column_uuid, color.clone());

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Record operations - continued
            AddRecord {
                table_uuid,
                record_uuid,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::AddRecordCommand;

                    // Generate a UUID if unspecified and return it to the caller in the response
                    let record_uuid = if record_uuid.is_empty() {
                        uuid::Uuid::new_v4().to_string()
                    } else {
                        record_uuid.clone()
                    };
                    let command =
                        AddRecordCommand::with_uuid(table_uuid.clone(), record_uuid.clone());

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true,
                            "record_uuid": record_uuid
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            InsertRecord {
                table_uuid,
                index,
                record_uuid: _,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::InsertRecordCommand;

                    let command = InsertRecordCommand::new(table_uuid.clone(), index as usize);

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DeleteRecord {
                table_uuid,
                record_uuid,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RemoveRecordCommand;

                    let command = RemoveRecordCommand::new(table_uuid.clone(), record_uuid.clone());

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetRecordLabel {
                table_uuid,
                record_uuid,
                label,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetRecordLabelCommand;

                    let command = SetRecordLabelCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        label.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetRecordMemoText {
                table_uuid,
                record_uuid,
                column_name,
                memo_text,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetRecordMemoTextCommand;

                    // Memo text belongs to a cell (record x column). Resolve the column name to its UUID
                    let column_uuid = match resolve_column_uuid(proj, &table_uuid, &column_name) {
                        Some(uuid) => uuid,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Column not found: {column_name}")).into(),
                            )
                        }
                    };
                    let command = SetRecordMemoTextCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        column_uuid,
                        memo_text.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetColumnReferenceConfig {
                table_uuid,
                column_name,
                target_table_uuid,
                display_column_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&target_table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    let column_uuid = match resolve_column_uuid(proj, &table_uuid, &column_name) {
                        Some(uuid) => uuid,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Column not found: {column_name}")).into(),
                            )
                        }
                    };
                    // Resolve the display column from the referenced table's columns
                    let display_column_uuid = if display_column_name.is_empty() {
                        None
                    } else {
                        match resolve_column_uuid(proj, &target_table_uuid, &display_column_name) {
                            Some(uuid) => Some(uuid),
                            None => {
                                return DevcelResponse::Error(
                                    (format!(
                                "Display column not found in target table: {display_column_name}"
                            ))
                                    .into(),
                                )
                            }
                        }
                    };
                    let config = crate::types::ReferenceConfig {
                        target_table_uuid: target_table_uuid.clone(),
                        display_column_uuid,
                    };
                    match crate::commands::set_column_reference_config(
                        proj,
                        &table_uuid,
                        &column_uuid,
                        config,
                    ) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetRecordMinVersion {
                table_uuid,
                record_uuid,
                min_version,
            } => {
                let version = match min_version.parse::<u32>() {
                    Ok(version) => version,
                    Err(_) => {
                        return DevcelResponse::Error(
                            "min_version must be an integer between 0 and 4294967295".into(),
                        );
                    }
                };
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetRecordMinVersionCommand;

                    let command = SetRecordMinVersionCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        version,
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetRecordParentUuid {
                table_uuid,
                record_uuid,
                parent_uuid,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::SetRecordParentUuidCommand;

                    let command = SetRecordParentUuidCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        parent_uuid.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            AddRecordTag {
                table_uuid,
                record_uuid,
                tag,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::AddRecordTagCommand;

                    let command = AddRecordTagCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        tag.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RemoveRecordTag {
                table_uuid,
                record_uuid,
                tag,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RemoveRecordTagCommand;

                    let command = RemoveRecordTagCommand::new(
                        table_uuid.clone(),
                        record_uuid.clone(),
                        tag.clone(),
                    );

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Project operations - continued
            RenameProject { new_name } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.rename_project(&new_name) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            UpdateProjectDescription { description } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    proj.project_data.project_description = description.clone();
                    DevcelResponse::Ok(serde_json::json!({
                        "success": true
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            UpdateProjectHeaderColor { color } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    proj.project_data.color = color.clone();
                    DevcelResponse::Ok(serde_json::json!({
                        "success": true
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetProjectName => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    DevcelResponse::Ok(serde_json::json!({
                        "name": proj.get_project_name()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetProjectDescription => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    DevcelResponse::Ok(serde_json::json!({
                        "description": proj.get_project_description()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetProjectPath => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    DevcelResponse::Ok(serde_json::json!({
                        "path": proj.get_project_path()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetProjectHeaderColor => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    DevcelResponse::Ok(serde_json::json!({
                        "color": proj.get_project_header_color()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Validation
            ValidateDataName { name } => {
                use crate::utils::validate_data_name;

                match validate_data_name(&name) {
                    Ok(_) => DevcelResponse::Ok(serde_json::json!({
                        "valid": true
                    })),
                    Err(e) => DevcelResponse::Error(e.into()),
                }
            }

            // Operation with metadata - pass through to actual operation
            OperationWithMetadata {
                operation,
                metadata: _,
            } => {
                // Extract and handle the wrapped operation
                self.handle_operation(*operation).await
            }

            // Directory operations
            CreateDirectory {
                parent_path,
                directory_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let dir_path = if parent_path.is_empty() || parent_path == "/" {
                        std::path::PathBuf::from(&directory_name)
                    } else {
                        std::path::PathBuf::from(parent_path).join(&directory_name)
                    };
                    match proj.create_directory(dir_path) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RenameDirectory {
                directory_path,
                new_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.rename_directory(std::path::PathBuf::from(directory_path), &new_name)
                    {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            MoveDirectory {
                directory_path,
                new_parent_path,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.move_directory(
                        std::path::PathBuf::from(directory_path),
                        std::path::PathBuf::from(new_parent_path),
                    ) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DeleteDirectory { directory_path } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    match proj.delete_directory(std::path::PathBuf::from(directory_path)) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            OpenInExplorer { path } => {
                // This is a platform-specific operation
                #[cfg(target_os = "windows")]
                {
                    use std::process::Command;
                    match Command::new("explorer").arg(&path).spawn() {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => {
                            DevcelResponse::Error((format!("Failed to open explorer: {e}")).into())
                        }
                    }
                }

                #[cfg(target_os = "macos")]
                {
                    use std::process::Command;
                    match Command::new("open").arg(&path).spawn() {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => {
                            DevcelResponse::Error((format!("Failed to open finder: {e}")).into())
                        }
                    }
                }

                #[cfg(target_os = "linux")]
                {
                    use std::process::Command;
                    match Command::new("xdg-open").arg(&path).spawn() {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(
                            (format!("Failed to open file manager: {e}")).into(),
                        ),
                    }
                }

                #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
                {
                    DevcelResponse::Error("Open in explorer not supported on this platform".into())
                }
            }

            // Command operations (Undo/Redo)
            UndoCommand { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    match proj.undo_command(&table_uuid) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RedoCommand { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    match proj.redo_command(&table_uuid) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ClearTableUndoRedoStacks { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    match proj.clear_table_undo_redo_stacks(&table_uuid) {
                        Ok(()) => DevcelResponse::Ok(serde_json::json!({"success":true})),
                        Err(error) => DevcelResponse::Error(error.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Table name operations
            RenameTableDisplayName {
                table_uuid,
                new_display_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RenameTableDisplayNameCommand;

                    let command =
                        RenameTableDisplayNameCommand::new(table_uuid.clone(), &new_display_name);

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RenameTableDataName {
                table_uuid,
                new_data_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    use crate::commands::RenameTableDataNameCommand;

                    let command =
                        RenameTableDataNameCommand::new(table_uuid.clone(), new_data_name.clone());

                    match proj.execute_command(command, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({
                            "success": true
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // Markdown operations
            ReadMarkdownFile { file_path } => {
                use std::fs;
                if let Err(error) =
                    crate::utils::validate_markdown_path(std::path::Path::new(&file_path))
                {
                    return DevcelResponse::Error(error.into());
                }
                let project = self.project.lock().await;
                let Some(ref proj) = *project else {
                    return DevcelResponse::Error("No project open".into());
                };
                // Resolve relative paths from the project (Tables directory), not the process CWD
                let full_path = match proj.resolve_table_path(&std::path::PathBuf::from(&file_path))
                {
                    Ok(p) => p,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                match fs::read_to_string(&full_path) {
                    Ok(content) => DevcelResponse::Ok(serde_json::json!({
                        "content": content
                    })),
                    Err(e) => {
                        DevcelResponse::Error((format!("Failed to read markdown file: {e}")).into())
                    }
                }
            }

            WriteMarkdownFile { file_path, content } => {
                use std::fs;
                if let Err(error) =
                    crate::utils::validate_markdown_path(std::path::Path::new(&file_path))
                {
                    return DevcelResponse::Error(error.into());
                }
                let project = self.project.lock().await;
                let Some(ref proj) = *project else {
                    return DevcelResponse::Error("No project open".into());
                };
                let full_path = match proj.resolve_table_path(&std::path::PathBuf::from(&file_path))
                {
                    Ok(p) => p,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                if let Some(parent) = full_path.parent() {
                    if let Err(e) = fs::create_dir_all(parent) {
                        return DevcelResponse::Error(
                            (format!("Failed to create parent directory: {e}")).into(),
                        );
                    }
                }
                match fs::write(&full_path, &content) {
                    Ok(_) => DevcelResponse::Ok(serde_json::json!({
                        "success": true,
                        "path": full_path.to_string_lossy().to_string()
                    })),
                    Err(e) => DevcelResponse::Error(
                        (format!("Failed to write markdown file: {e}")).into(),
                    ),
                }
            }

            MoveMarkdownFile { old_path, new_path } => {
                use std::fs;
                if let Err(error) = crate::utils::validate_markdown_path(std::path::Path::new(
                    &old_path,
                ))
                .and_then(|_| crate::utils::validate_markdown_path(std::path::Path::new(&new_path)))
                {
                    return DevcelResponse::Error(error.into());
                }
                let project = self.project.lock().await;
                let Some(ref proj) = *project else {
                    return DevcelResponse::Error("No project open".into());
                };
                let full_old = match proj.resolve_table_path(&std::path::PathBuf::from(&old_path)) {
                    Ok(p) => p,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                let full_new = match proj.resolve_table_path(&std::path::PathBuf::from(&new_path)) {
                    Ok(p) => p,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                match fs::rename(&full_old, &full_new) {
                    Ok(_) => DevcelResponse::Ok(serde_json::json!({
                        "success": true
                    })),
                    Err(e) => {
                        DevcelResponse::Error((format!("Failed to move markdown file: {e}")).into())
                    }
                }
            }

            LintProject {
                table_uuid,
                version,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                match crate::export_validation::lint_project(
                    project,
                    table_uuid.as_deref(),
                    version,
                ) {
                    Ok(issues) => DevcelResponse::Ok(serde_json::to_value(issues).unwrap()),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }
            ExportAllTablesChecked {
                mode,
                allow_invalid,
            } => {
                let mut project = self.project.lock().await;
                let Some(project) = project.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                let mode = match mode.as_str() {
                    "full" => crate::json_export::ExportMode::Full,
                    "minimal" => crate::json_export::ExportMode::Minimal,
                    _ => return DevcelResponse::Error("Invalid export mode".into()),
                };
                match crate::json_export::export_all_tables_as_json_with_validation(
                    project,
                    mode,
                    allow_invalid,
                ) {
                    Ok(data) => DevcelResponse::Ok(serde_json::json!({"data":data})),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }

            ExportRuntimeBundle {
                mode,
                version,
                allow_invalid,
                filters,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    use crate::json_export::{export_runtime_bundle_with_filters, ExportMode};

                    let export_mode = match mode.to_lowercase().as_str() {
                        "minimal" => ExportMode::Minimal,
                        "full" => ExportMode::Full,
                        other => {
                            return DevcelResponse::Error(
                                (format!("Invalid export mode: {other} (specify full or minimal)"))
                                    .into(),
                            );
                        }
                    };

                    match export_runtime_bundle_with_filters(
                        proj,
                        export_mode,
                        version,
                        allow_invalid,
                        &filters,
                    ) {
                        Ok(bundle) => match serde_json::to_value(&bundle) {
                            Ok(value) => DevcelResponse::Ok(value),
                            Err(e) => DevcelResponse::Error(e.into()),
                        },
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ExportCode {
                target,
                namespace,
                version,
                filters,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    use crate::codegen::{
                        generate_code_with_class_name_for_filters, CodegenTarget,
                    };

                    let Some(cg_target) = CodegenTarget::from_name(&target) else {
                        return DevcelResponse::Error((format!(
                            "Invalid code generation target: {target} (specify csharp / cpp / typescript)"
                        )).into());
                    };

                    match generate_code_with_class_name_for_filters(
                        proj,
                        cg_target,
                        namespace.as_deref(),
                        None,
                        version,
                        &filters,
                    ) {
                        Ok(code) => DevcelResponse::Ok(serde_json::json!({
                            "target": target,
                            "extension": cg_target.file_extension(),
                            "version": version,
                            "code": code,
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            // === Interface operations ===
            ListInterfaces => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let interfaces: Vec<serde_json::Value> = proj
                        .interface_registry
                        .get_all_interfaces_with_paths()
                        .into_iter()
                        .map(|(path, iface)| interface_summary_json(path, iface))
                        .collect();
                    DevcelResponse::Ok(serde_json::json!({ "interfaces": interfaces }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetInterfaceDetails { interface_uuid } => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    match proj.get_interface(&uuid) {
                        Some(iface) => match interface_details_json(proj, iface) {
                            Ok(value) => DevcelResponse::Ok(value),
                            Err(error) => DevcelResponse::Error(error),
                        },
                        None => DevcelResponse::Error(
                            (format!("Interface not found: {interface_uuid}")).into(),
                        ),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            CreateInterface { path, description } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    // Normalize extensionless input using the same rules as create_interface in lib.rs
                    let normalized_path = {
                        let trimmed = path.trim();
                        if trimmed.is_empty() {
                            return DevcelResponse::Error("Interface path is empty".into());
                        }
                        let normalized = trimmed.replace('\\', "/");
                        if normalized.ends_with(".interface.toml") {
                            normalized
                        } else if let Some(stem) = normalized.strip_suffix(".toml") {
                            format!("{stem}.interface.toml")
                        } else {
                            format!("{normalized}.interface.toml")
                        }
                    };

                    let name = std::path::Path::new(&normalized_path)
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|s| s.trim_end_matches(".interface.toml").to_string())
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| normalized_path.clone());

                    let project_dir = match proj.path.parent() {
                        Some(d) => d.to_path_buf(),
                        None => {
                            return DevcelResponse::Error(
                                "Failed to get the project directory".into(),
                            )
                        }
                    };
                    let tables_dir = project_dir.join("Tables");
                    let full_path = match proj
                        .resolve_table_path(&std::path::PathBuf::from(&normalized_path))
                    {
                        Ok(path) => path,
                        Err(error) => return DevcelResponse::Error(error.into()),
                    };
                    if let Some(parent) = full_path.parent() {
                        if !parent.exists() {
                            if let Err(e) = std::fs::create_dir_all(parent) {
                                return DevcelResponse::Error(
                                    (format!("Failed to create the directory: {e}")).into(),
                                );
                            }
                        }
                    }

                    let desc = if description.is_empty() {
                        None
                    } else {
                        Some(description)
                    };
                    let interface = crate::interface::Interface::new(name, desc);
                    let interface_uuid = interface.uuid;
                    let relative_path = full_path
                        .strip_prefix(&tables_dir)
                        .unwrap_or(&full_path)
                        .to_string_lossy()
                        .to_string();

                    if let Err(e) = proj
                        .interface_registry
                        .add_interface_with_path(relative_path, interface)
                    {
                        return DevcelResponse::Error(e.into());
                    }
                    if let Some(iface) = proj.get_interface(&interface_uuid) {
                        if let Err(e) = proj.save_interface(iface) {
                            return DevcelResponse::Error(e.into());
                        }
                    }
                    DevcelResponse::Ok(serde_json::json!({
                        "interface_uuid": interface_uuid.to_string()
                    }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            DeleteInterface { interface_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    match proj.remove_interface(&uuid) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            AddInterfaceColumn {
                interface_uuid,
                column_name,
                column_type,
                default_value,
                required,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let value_type = match crate::operations::value_type_from_string(&column_type) {
                        Ok(vt) => vt,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let mut column = crate::column::ColumnSchema {
                        data_name: column_name.clone(),
                        display_name: column_name,
                        data_type: value_type,
                        default_value,
                        ..Default::default()
                    };
                    if required {
                        column.required = Some(true);
                    }
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::AddColumn { column },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RemoveInterfaceColumn {
                interface_uuid,
                column_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::RemoveColumn { column_name },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RenameInterfaceColumn {
                interface_uuid,
                old_name,
                new_name,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::RenameColumn { old_name, new_name },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetInterfaceColumnType {
                interface_uuid,
                column_name,
                new_type,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let new_value_type = match crate::operations::value_type_from_string(&new_type)
                    {
                        Ok(vt) => vt,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let old_type = match interface_column_value_type(proj, &uuid, &column_name) {
                        Some(t) => t,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Column not found: {column_name}")).into(),
                            )
                        }
                    };
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::ModifyColumn {
                            column_name,
                            old_type,
                            new_type: new_value_type,
                        },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetInterfaceColumnDefault {
                interface_uuid,
                column_name,
                default_value,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let new_default = if default_value.is_empty() {
                        None
                    } else {
                        Some(default_value)
                    };
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::ChangeDefault {
                            column_name,
                            new_default,
                        },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetInterfaceColumnRequired {
                interface_uuid,
                column_name,
                required,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::ChangeRequired {
                            column_name,
                            required,
                        },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetInterfaceColumnConstraints {
                interface_uuid,
                column_name,
                unique,
                min_value,
                max_value,
                pattern,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let constraints = crate::column::ColumnConstraints {
                        unique,
                        min_value,
                        max_value,
                        pattern,
                    };
                    let new_constraints = if constraints.is_empty() {
                        None
                    } else {
                        Some(constraints)
                    };
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::ChangeConstraints {
                            column_name,
                            new_constraints,
                        },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            SetInterfaceExtends {
                interface_uuid,
                parent_uuids,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let mut parsed = Vec::with_capacity(parent_uuids.len());
                    for p in &parent_uuids {
                        match parse_interface_uuid(p) {
                            Ok(u) => parsed.push(u),
                            Err(e) => return DevcelResponse::Error(e.into()),
                        }
                    }
                    run_interface_change(
                        proj,
                        &interface_uuid,
                        crate::interface::InterfaceChange::ModifyExtends {
                            new_extends: parsed,
                        },
                    )
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ApplyInterfaceToTable {
                table_uuid,
                interface_uuid,
                auto_add_columns,
                acknowledgement,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    match crate::table_mutation::apply_interface_checked(
                        proj,
                        &table_uuid,
                        &uuid,
                        auto_add_columns,
                        acknowledgement,
                        None,
                    ) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RemoveInterfaceFromTable {
                table_uuid,
                interface_uuid,
                acknowledgement,
            } => {
                let mut guard = self.project.lock().await;
                let Some(project) = guard.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let id = match parse_interface_uuid(&interface_uuid) {
                    Ok(id) => id,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                match crate::table_mutation::remove_interface_checked(
                    project,
                    &table_uuid,
                    &id,
                    acknowledgement,
                    None,
                ) {
                    Ok(result) => DevcelResponse::Ok(
                        serde_json::json!({"success": true, "columns_removed": result.columns_to_remove}),
                    ),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }
            SyncTableWithInterface {
                table_uuid,
                interface_uuid,
                acknowledgement,
            } => {
                let mut guard = self.project.lock().await;
                let Some(project) = guard.as_mut() else {
                    return DevcelResponse::Error("No project open".into());
                };
                if let Err(error) = project.ensure_table_loaded_by_uuid(&table_uuid) {
                    return DevcelResponse::Error(error.into());
                }
                let id = match parse_interface_uuid(&interface_uuid) {
                    Ok(id) => id,
                    Err(e) => return DevcelResponse::Error(e.into()),
                };
                match crate::table_mutation::sync_interface_checked(
                    project,
                    &table_uuid,
                    &id,
                    true,
                    true,
                    acknowledgement,
                    None,
                ) {
                    Ok(result) => DevcelResponse::Ok(
                        serde_json::json!({"success": true, "columns_added": result.columns_added, "columns_removed": result.columns_to_remove, "warnings": result.warnings}),
                    ),
                    Err(error) => DevcelResponse::Error(error.into()),
                }
            }

            ValidateInterfaceImplementation {
                table_uuid,
                interface_uuid,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let interface = match proj.get_interface(&uuid) {
                        Some(i) => i,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Interface not found: {interface_uuid}")).into(),
                            )
                        }
                    };
                    let table = match proj
                        .tables_data
                        .values()
                        .find(|t| t.data.uuid == table_uuid)
                    {
                        Some(t) => t,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Table not found: {table_uuid}")).into(),
                            )
                        }
                    };
                    match table.validate_interface(interface, &proj.interface_registry) {
                        Ok(v) => DevcelResponse::Ok(serde_json::json!({
                            "interface_uuid": v.interface_uuid.to_string(),
                            "is_valid": v.is_valid,
                            "missing_columns": v.missing_columns,
                            "type_mismatches": v.type_mismatches.iter().map(|m| serde_json::json!({
                                "column_name": m.column_name,
                                "expected_type": format!("{:?}", m.expected_type),
                                "actual_type": format!("{:?}", m.actual_type),
                            })).collect::<Vec<_>>(),
                            "constraint_violations": v.constraint_violations.iter().map(|c| serde_json::json!({
                                "column_name": c.column_name,
                                "constraint_type": c.constraint_type,
                                "diagnostic": c.diagnostic,
                                "record_uuid": c.record_uuid,
                            })).collect::<Vec<_>>(),
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetTableInterfaces { table_uuid } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    if let Err(error) = proj.ensure_table_loaded_by_uuid(&table_uuid) {
                        return DevcelResponse::Error(error.into());
                    }
                    let table = match proj
                        .tables_data
                        .values()
                        .find(|t| t.data.uuid == table_uuid)
                    {
                        Some(t) => t,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Table not found: {table_uuid}")).into(),
                            )
                        }
                    };
                    let impls: Vec<serde_json::Value> = table
                        .data
                        .interface_implementations
                        .values()
                        .map(|info| {
                            serde_json::json!({
                                "interface_uuid": info.interface_uuid.to_string(),
                                "synced_version_id": info.synced_version_id.to_string(),
                                "last_sync_date": info.last_sync_date.to_rfc3339(),
                            })
                        })
                        .collect();
                    DevcelResponse::Ok(serde_json::json!({ "interfaces": impls }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            GetInterfaceBranches { interface_uuid } => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let interface = match proj.get_interface(&uuid) {
                        Some(i) => i,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Interface not found: {interface_uuid}")).into(),
                            )
                        }
                    };
                    let branches: Vec<serde_json::Value> = interface
                        .get_branch_heads()
                        .into_iter()
                        .map(|head| {
                            let v = interface.history.get(&head);
                            serde_json::json!({
                                "id": head.to_string(),
                                "timestamp": v.map(|x| x.timestamp.to_rfc3339()).unwrap_or_default(),
                                "author": v.and_then(|x| x.author.clone()),
                                "comment": v.and_then(|x| x.comment.clone()),
                                "is_current": head == interface.current_version_id,
                            })
                        })
                        .collect();
                    DevcelResponse::Ok(serde_json::json!({ "branches": branches }))
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            PreviewInterfaceMerge {
                interface_uuid,
                ours_version,
                theirs_version,
            } => {
                let project = self.project.lock().await;
                if let Some(ref proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let ours = match parse_interface_uuid(&ours_version) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let theirs = match parse_interface_uuid(&theirs_version) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let interface = match proj.get_interface(&uuid) {
                        Some(i) => i,
                        None => {
                            return DevcelResponse::Error(
                                (format!("Interface not found: {interface_uuid}")).into(),
                            )
                        }
                    };
                    match interface.preview_merge_conflicts(ours, theirs) {
                        Ok(conflicts) => DevcelResponse::Ok(serde_json::json!({
                            "conflicts": conflicts.iter().map(|c| serde_json::json!({
                                "column_name": c.column_name,
                                "resolution_type": format!("{:?}", c.resolution_type),
                                "description": c.description,
                            })).collect::<Vec<_>>(),
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            MergeInterfaceBranches {
                interface_uuid,
                ours_version,
                theirs_version,
                resolutions,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let ours = match parse_interface_uuid(&ours_version) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let theirs = match parse_interface_uuid(&theirs_version) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let mut resolution_map = std::collections::HashMap::new();
                    for r in resolutions {
                        let rt = match r.resolution.as_str() {
                            "TakeOurs" => crate::interface::ResolutionType::TakeOurs,
                            "TakeTheirs" => crate::interface::ResolutionType::TakeTheirs,
                            other => {
                                return DevcelResponse::Error(
                                    (format!(
                                "Invalid resolution for column {}: {other} (TakeOurs/TakeTheirs)",
                                r.column_name
                            ))
                                    .into(),
                                )
                            }
                        };
                        resolution_map.insert(r.column_name, rt);
                    }
                    let cmd = crate::commands::MergeInterfaceCommand::new(
                        uuid,
                        ours,
                        theirs,
                        resolution_map,
                        Some("cli".to_string()),
                        None,
                    );
                    match proj.execute_command(cmd, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            RevertInterfaceToVersion {
                interface_uuid,
                target_version,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let target = match parse_interface_uuid(&target_version) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let cmd = crate::commands::RevertInterfaceCommand::new(
                        uuid,
                        target,
                        Some("cli".to_string()),
                    );
                    match proj.execute_command(cmd, None) {
                        Ok(_) => DevcelResponse::Ok(serde_json::json!({ "success": true })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ImportInterfaceHistory {
                interface_uuid,
                source_path,
            } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    let uuid = match parse_interface_uuid(&interface_uuid) {
                        Ok(u) => u,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    let source = match crate::interface::Interface::load_from_file(
                        std::path::Path::new(&source_path),
                    ) {
                        Ok(s) => s,
                        Err(e) => return DevcelResponse::Error(e.into()),
                    };
                    match proj.import_interface_history(&uuid, &source) {
                        Ok(absorbed) => {
                            DevcelResponse::Ok(serde_json::json!({"absorbed": absorbed}))
                        }
                        Err(error) => DevcelResponse::Error(error.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }

            ExecuteBatch { operations } => {
                let mut project = self.project.lock().await;
                if let Some(ref mut proj) = *project {
                    // Convert operations to commands and execute as a transaction
                    let result = self.execute_batch_operations(proj, operations).await;
                    match result {
                        Ok(responses) => DevcelResponse::Ok(serde_json::json!({
                            "responses": responses
                        })),
                        Err(e) => DevcelResponse::Error(e.into()),
                    }
                } else {
                    DevcelResponse::Error("No project open".into())
                }
            }
        }
    }
}

#[cfg(feature = "p2p")]
#[async_trait]
impl OperationHandler for RemoteOperationHandler {
    async fn handle_operation(&self, operation: DevcelOperation) -> DevcelResponse {
        // Forward all operations to the server through the client connection
        let client_guard = self.client.read().await;
        if let Some(ref client) = *client_guard {
            match client.send_operation(operation).await {
                Ok(response) => response,
                Err(e) => DevcelResponse::Error(e),
            }
        } else {
            DevcelResponse::Error(crate::AppError::code(
                "p2p.notConnected",
                serde_json::json!({}),
            ))
        }
    }
}
