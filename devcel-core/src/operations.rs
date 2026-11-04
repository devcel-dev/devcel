use crate::types::ValueType;
use serde::{Deserialize, Serialize};

/// Unified operation enum that replaces all protobuf definitions
/// This is the single source of truth for all Devcel operations
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", content = "data")]
pub enum DevcelOperation {
    // Project operations
    HasProject,
    GetProjectInfo,
    ReloadProjectTags,
    CreateProject {
        project_name: String,
        project_path: String,
        description: String,
        header_color: String,
    },
    OpenProject {
        project_path: String,
    },
    SaveProject,
    CloseProject,
    DeleteProject {
        project_path: String,
    },
    RenameProject {
        new_name: String,
    },
    UpdateProjectDescription {
        description: String,
    },
    UpdateProjectHeaderColor {
        color: String,
    },

    // Table operations
    CreateTable {
        parent_path: String,
        data_name: String,
        display_name: String,
    },
    InitializeEmptyTable {
        table_uuid: String,
    },
    DeleteTable {
        table_path: String,
    },
    MoveTable {
        table_path: String,
        new_parent_path: String,
    },
    DuplicateTable {
        table_path: String,
        new_data_name: String,
        new_display_name: String,
    },
    RenameTable {
        table_uuid: String,
        new_display_name: String,
    },
    LoadTable {
        table_path: String,
    },
    ReloadTable {
        table_uuid: String,
    },
    GetLoadedTables,
    GetProjectEntries,
    GetTableList {
        parent_path: String,
    },
    GetTableData {
        table_uuid: String,
    },
    GetTableDataRange {
        table_uuid: String,
        start_row: i32,
        end_row: i32,
    },
    GetTableDataByUuids {
        table_uuid: String,
        record_uuids: Vec<String>,
    },
    ExportTableData {
        table_uuid: String,
        export_mode: String,
    },
    SearchTableData {
        table_uuid: String,
        search_text: String,
        search_columns: Vec<String>,
    },

    // Column operations
    AddColumn {
        table_uuid: String,
        column_name: String,
        column_type: String,
    },
    InsertColumn {
        table_uuid: String,
        index: i32,
        column_name: String,
        column_type: String,
    },
    RemoveColumn {
        table_uuid: String,
        column_name: String,
    },
    RenameColumn {
        table_uuid: String,
        old_name: String,
        new_name: String,
    },
    SetColumnTooltip {
        table_uuid: String,
        column_name: String,
        tooltip: String,
    },
    SetColumnMemoText {
        table_uuid: String,
        column_name: String,
        memo_text: String,
    },
    SetColumnDefaultValue {
        table_uuid: String,
        column_name: String,
        default_value: String,
    },
    SetColumnColor {
        table_uuid: String,
        column_name: String,
        color: String,
    },
    /// Make a column a Reference and set its target table
    SetColumnReferenceConfig {
        table_uuid: String,
        column_name: String,
        /// Referenced table UUID
        target_table_uuid: String,
        /// Referenced column name for dropdown labels (empty means unspecified)
        display_column_name: String,
    },

    // Interface operations
    /// Get the interface list (read-only)
    ListInterfaces,
    /// Get interface details, including columns, inheritance, version history, and implementing tables (read-only)
    GetInterfaceDetails {
        interface_uuid: String,
    },
    /// Create an interface
    CreateInterface {
        /// Path relative to the Tables directory (e.g. "common.interface.toml")
        path: String,
        /// Description (may be empty)
        description: String,
    },
    /// Delete an interface
    DeleteInterface {
        interface_uuid: String,
    },
    /// Add an interface column and record a new version
    AddInterfaceColumn {
        interface_uuid: String,
        column_name: String,
        /// Type: String/I32/I64/F32/F64/Boolean/Color32/ColorFloat/Select/DateTime/Reference, etc.
        column_type: String,
        /// Default value (may be empty)
        default_value: String,
        /// Whether to make the column required
        required: bool,
    },
    /// Remove a column from an interface
    RemoveInterfaceColumn {
        interface_uuid: String,
        column_name: String,
    },
    /// Rename an interface column while preserving values in implementing tables
    RenameInterfaceColumn {
        interface_uuid: String,
        old_name: String,
        new_name: String,
    },
    /// Change an interface column's type
    SetInterfaceColumnType {
        interface_uuid: String,
        column_name: String,
        new_type: String,
    },
    /// Change an interface column's default value
    SetInterfaceColumnDefault {
        interface_uuid: String,
        column_name: String,
        default_value: String,
    },
    /// Change an interface column's required flag
    SetInterfaceColumnRequired {
        interface_uuid: String,
        column_name: String,
        required: bool,
    },
    /// Change an interface column's constraints (unspecified fields are cleared)
    SetInterfaceColumnConstraints {
        interface_uuid: String,
        column_name: String,
        unique: Option<bool>,
        min_value: Option<f64>,
        max_value: Option<f64>,
        pattern: Option<String>,
    },
    /// Set an interface's parents, replacing all existing parents
    SetInterfaceExtends {
        interface_uuid: String,
        parent_uuids: Vec<String>,
    },
    /// Apply an interface to a table
    ApplyInterfaceToTable {
        table_uuid: String,
        interface_uuid: String,
        /// Whether to automatically add missing columns
        auto_add_columns: bool,
        #[serde(default)]
        acknowledgement: Option<String>,
    },
    /// Detach an interface from a table, removing its columns and values
    RemoveInterfaceFromTable {
        table_uuid: String,
        interface_uuid: String,
        #[serde(default)]
        acknowledgement: Option<String>,
    },
    /// Fully align a table with its interface definition, including additions, removals, types, and defaults
    SyncTableWithInterface {
        table_uuid: String,
        interface_uuid: String,
        #[serde(default)]
        acknowledgement: Option<String>,
    },
    /// Validate a table's interface implementation (read-only)
    ValidateInterfaceImplementation {
        table_uuid: String,
        interface_uuid: String,
    },
    /// Get the interfaces implemented by a table (read-only)
    GetTableInterfaces {
        table_uuid: String,
    },
    /// Get interface branch heads (read-only)
    GetInterfaceBranches {
        interface_uuid: String,
    },
    /// Preview merge conflicts (read-only)
    PreviewInterfaceMerge {
        interface_uuid: String,
        ours_version: String,
        theirs_version: String,
    },
    /// Merge divergent interface histories
    MergeInterfaceBranches {
        interface_uuid: String,
        ours_version: String,
        theirs_version: String,
        /// Conflict resolutions (column name -> "TakeOurs"/"TakeTheirs")
        resolutions: Vec<InterfaceResolution>,
    },
    /// Restore an interface's content from a previous point as a new version
    RevertInterfaceToVersion {
        interface_uuid: String,
        target_version: String,
    },
    /// Import history from another interface file in preparation for merging
    ImportInterfaceHistory {
        interface_uuid: String,
        /// Absolute path to the source interface file
        source_path: String,
    },

    // Record operations
    AddRecord {
        table_uuid: String,
        record_uuid: String,
    },
    InsertRecord {
        table_uuid: String,
        index: i32,
        record_uuid: String,
    },
    DeleteRecord {
        table_uuid: String,
        record_uuid: String,
    },
    SetRecordValue {
        table_uuid: String,
        record_uuid: String,
        column_name: String,
        value: String,
    },
    /// Change inheritance behavior without replacing the effective raw input.
    SetRecordLabel {
        table_uuid: String,
        record_uuid: String,
        label: String,
    },
    SetRecordMemoText {
        table_uuid: String,
        record_uuid: String,
        /// Memo text is stored per cell (record x column)
        column_name: String,
        memo_text: String,
    },
    SetRecordMinVersion {
        table_uuid: String,
        record_uuid: String,
        min_version: String,
    },
    SetRecordParentUuid {
        table_uuid: String,
        record_uuid: String,
        parent_uuid: String,
    },
    AddRecordTag {
        table_uuid: String,
        record_uuid: String,
        tag: String,
    },
    RemoveRecordTag {
        table_uuid: String,
        record_uuid: String,
        tag: String,
    },

    // Directory operations
    CreateDirectory {
        parent_path: String,
        directory_name: String,
    },
    RenameDirectory {
        directory_path: String,
        new_name: String,
    },
    MoveDirectory {
        directory_path: String,
        new_parent_path: String,
    },
    DeleteDirectory {
        directory_path: String,
    },
    OpenInExplorer {
        path: String,
    },

    // Command operations
    UndoCommand {
        table_uuid: String,
    },
    RedoCommand {
        table_uuid: String,
    },

    // Validation
    LintProject {
        table_uuid: Option<String>,
        version: Option<u32>,
    },
    ExportAllTablesChecked {
        mode: String,
        #[serde(default)]
        allow_invalid: bool,
    },
    ValidateDataName {
        name: String,
    },

    // Server management
    Ping,
    GetServerInfo,
    Shutdown,

    // Additional Tauri-specific operations
    GetProjectName,
    GetProjectDescription,
    GetProjectPath,
    GetProjectHeaderColor,
    ClearTableUndoRedoStacks {
        table_uuid: String,
    },
    RenameTableDisplayName {
        table_uuid: String,
        new_display_name: String,
    },
    RenameTableDataName {
        table_uuid: String,
        new_data_name: String,
    },
    ReadMarkdownFile {
        file_path: String,
    },
    WriteMarkdownFile {
        file_path: String,
        content: String,
    },
    MoveMarkdownFile {
        old_path: String,
        new_path: String,
    },
    /// Export a runtime distribution bundle containing a manifest and version-filtered tables.
    /// `mode` is "full" / "minimal"; when `version` is Some(n), include only min_version <= n.
    /// Export the runtime distribution bundle (manifest + version-filtered tables).
    ExportRuntimeBundle {
        /// "full" or "minimal"
        mode: String,
        /// Content-version filter (None includes everything)
        version: Option<u32>,
        #[serde(default)]
        allow_invalid: bool,
        /// Output-only row and column tag projection.
        #[serde(default, flatten)]
        filters: crate::tag_filter::TagFilter,
    },
    /// Generate type-safe access code from definitions (codegen).
    /// `target` is "csharp" / "cpp".
    /// Generate type-safe accessor code from the schema.
    ExportCode {
        /// Target language ("csharp" / "cpp")
        target: String,
        /// Output namespace (None uses the language default; avoids collisions between projects)
        #[serde(default)]
        namespace: Option<String>,
        /// Content-version filter (None includes all columns)
        #[serde(default)]
        version: Option<u32>,
        /// Output-only row and column tag projection.
        #[serde(default, flatten)]
        filters: crate::tag_filter::TagFilter,
    },
    SetInterfaceColumnCurveConfig {
        interface_uuid: String,
        column_name: String,
        config: crate::types::CurveConfig,
    },
    SetInterfaceColumnTableRefConfig {
        interface_uuid: String,
        column_name: String,
        config: crate::types::TableRefConfig,
    },
    SetInterfaceColumnSelectConfig {
        interface_uuid: String,
        column_name: String,
        config: Option<crate::types::SelectConfig>,
    },
    SetColumnCurveConfig {
        table_uuid: String,
        column_name: String,
        config: crate::types::CurveConfig,
    },
    SetColumnTableRefConfig {
        table_uuid: String,
        column_name: String,
        config: crate::types::TableRefConfig,
    },
    SetColumnSelectConfig {
        table_uuid: String,
        column_name: String,
        config: Option<crate::types::SelectConfig>,
    },

    /// Read presentation and input diagnostics from the Rust evaluator.
    GetTablePresentation {
        table_uuid: String,
    },
    /// Allocate a stable row identity without editing or saving anything.
    PrepareRecordDraft {
        table_uuid: String,
    },
    /// Atomic UUID patches, initial-value row creation and per-operation warning acknowledgement.
    ApplyTableMutation {
        request: crate::table_mutation::TableMutation,
    },

    /// Dedicated settings-only history entries; values cannot accompany these requests.
    UpdateTableEditSettings {
        request: crate::edit_controls::TableEditSettingsRequest,
    },
    SetColumnReadOnly {
        request: crate::edit_controls::ColumnReadOnlyRequest,
    },

    /// Replace a table through the validated, atomic plugin update contract.
    UpdateTableData {
        table_uuid: String,
        expected_revision: String,
        data: serde_json::Value,
        #[serde(default)]
        acknowledgement: Option<String>,
    },

    // P2P Sync operations
    GetFullProjectState,
    /// Reload interface definitions after a confirmed shared-file write.
    ReloadInterfaces,

    // Operation with metadata for conflict resolution
    OperationWithMetadata {
        operation: Box<DevcelOperation>,
        metadata: OperationMetadata,
    },

    /// Execute a batch of operations atomically
    ExecuteBatch {
        operations: Vec<DevcelOperation>,
    },
}

impl DevcelOperation {
    /// Whether this operation is read-only and leaves project state unchanged
    pub fn is_read_only(&self) -> bool {
        use DevcelOperation::*;
        if let OperationWithMetadata { operation, .. } = self {
            return operation.is_read_only();
        }
        matches!(
            self,
            HasProject
                | GetProjectInfo
                | GetProjectName
                | GetProjectDescription
                | GetProjectPath
                | GetProjectHeaderColor
                | GetLoadedTables
                | GetProjectEntries
                | GetTableList { .. }
                | GetTableData { .. }
                | GetTablePresentation { .. }
                | PrepareRecordDraft { .. }
                | GetTableDataRange { .. }
                | GetTableDataByUuids { .. }
                | ExportTableData { .. }
                | ExportRuntimeBundle { .. }
                | ExportAllTablesChecked { .. }
                | LintProject { .. }
                | ExportCode { .. }
                | SearchTableData { .. }
                | ValidateDataName { .. }
                | Ping
                | GetServerInfo
                | GetFullProjectState
                | ReadMarkdownFile { .. }
                | ListInterfaces
                | GetInterfaceDetails { .. }
                | ValidateInterfaceImplementation { .. }
                | GetTableInterfaces { .. }
                | GetInterfaceBranches { .. }
                | PreviewInterfaceMerge { .. }
        )
    }
}

/// Conflict resolution specification for a merge
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct InterfaceResolution {
    /// Target column name ("(extends)" for inheritance conflicts)
    pub column_name: String,
    /// "TakeOurs" or "TakeTheirs"
    pub resolution: String,
}

/// Unified response type for all operations
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", content = "data")]
pub enum DevcelResponse {
    Ok(serde_json::Value),
    Error(crate::AppError),
}

/// Project information response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub name: String,
    pub description: String,
    pub path: String,
    pub header_color: String,
}

/// Server information response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerInfo {
    pub uptime_seconds: i64,
    pub connected_clients: i32,
    pub has_active_project: bool,
}

/// Ping response
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingResponse {
    pub timestamp: i64,
}

/// Full project state for P2P synchronization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FullProjectState {
    pub project_info: ProjectInfo,
    pub tables: Vec<TableInfo>,
    pub loaded_tables: Vec<String>, // UUIDs of loaded tables
}

/// Table information for P2P sync
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TableInfo {
    pub uuid: String,
    pub path: String,
    pub display_name: String,
    pub data_name: String,
    pub is_loaded: bool,
}

/// Operation metadata for conflict resolution
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OperationMetadata {
    /// Unique ID of the client that sent the operation
    pub client_id: u64,
    /// Timestamp when the operation was created (microseconds since epoch)
    pub timestamp: u64,
    /// Sequence number for this client
    pub sequence: u64,
    /// Hash of the previous operation for causality tracking
    pub previous_hash: Option<String>,
}

/// Convert ValueType to string for serialization
pub fn value_type_to_string(vt: &ValueType) -> String {
    match vt {
        ValueType::None => "None",
        ValueType::String => "String",
        ValueType::U8 => "U8",
        ValueType::I8 => "I8",
        ValueType::U16 => "U16",
        ValueType::I16 => "I16",
        ValueType::U32 => "U32",
        ValueType::I32 => "I32",
        ValueType::U64 => "U64",
        ValueType::I64 => "I64",
        ValueType::F32 => "F32",
        ValueType::F64 => "F64",
        ValueType::Boolean => "Boolean",
        ValueType::Color32 => "Color32",
        ValueType::ColorFloat => "ColorFloat",
        ValueType::Select => "Select",
        ValueType::DateTime => "DateTime",
        ValueType::Curve => "Curve",
        ValueType::Reference => "Reference",
        ValueType::TableRef => "TableRef",
    }
    .to_string()
}

pub fn value_type_from_string(s: &str) -> Result<ValueType, String> {
    match s {
        "None" => Ok(ValueType::None),
        "String" => Ok(ValueType::String),
        "U8" => Ok(ValueType::U8),
        "I8" => Ok(ValueType::I8),
        "U16" => Ok(ValueType::U16),
        "I16" => Ok(ValueType::I16),
        "U32" => Ok(ValueType::U32),
        "I32" => Ok(ValueType::I32),
        "U64" => Ok(ValueType::U64),
        "I64" => Ok(ValueType::I64),
        "F32" => Ok(ValueType::F32),
        "F64" => Ok(ValueType::F64),
        "Boolean" => Ok(ValueType::Boolean),
        "Color32" => Ok(ValueType::Color32),
        "ColorFloat" => Ok(ValueType::ColorFloat),
        "Select" => Ok(ValueType::Select),
        "DateTime" => Ok(ValueType::DateTime),
        "Curve" => Ok(ValueType::Curve),
        "Reference" => Ok(ValueType::Reference),
        "TableRef" => Ok(ValueType::TableRef),
        _ => Err(format!("Unknown value type: {s}")),
    }
}
