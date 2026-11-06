//! devcel: a CLI for working with Devcel projects
//!
//! An interface for AI agents and automation scripts to read and write
//! Devcel data. Connects as a client when a P2P server (Devcel Studio or
//! `devcel serve`) is running, with changes propagated to every instance
//! in real time. Otherwise, opens and edits project files directly.
//!
//! Always outputs one JSON object (`{"ok":true,"data":...}` or
//! `{"ok":false,"error":{"kind":"text","text":"..."}}`). Exit codes: success 0, failure 1.

mod importer_ui;
mod managed_watch;
mod process_lifetime;
mod wolf_export;

use clap::{Parser, Subcommand};
use devcel_core::msgpack_client::MsgPackClient;
use devcel_core::operation_handler::{LocalOperationHandler, OperationHandler};
use devcel_core::operations::{DevcelOperation, DevcelResponse};
use devcel_core::p2p_manager::DevcelClient;
use devcel_core::registry::FileBasedRegistry;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;

#[derive(Parser)]
#[command(
    name = "devcel",
    about = "CLI for working with Devcel projects (AI agents and automation)",
    long_about = "CLI for working with Devcel projects.\n\
        Connects as a client when a P2P server (Devcel Studio / devcel serve) is running,\n\
        propagating changes to every instance in real time.\n\
        Always outputs one JSON object (ok/data or ok/error)."
)]
struct Cli {
    /// Project file (.devcelproj.toml) or the directory containing it
    #[arg(short, long, env = "DEVCEL_PROJECT", global = true)]
    project: Option<String>,

    /// Connection mode: auto=connect if a server exists, otherwise local; client=require P2P; local=edit files directly
    #[arg(long, default_value = "auto", global = true, value_parser = ["auto", "client", "local"])]
    mode: String,

    /// Pretty-print JSON (the default is a single line)
    #[arg(long, global = true)]
    pretty: bool,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Create a project
    Init {
        /// Project name
        name: String,
        /// Destination directory (<name>/ is created inside it)
        #[arg(long, default_value = ".")]
        dir: String,
        /// Project description
        #[arg(long, default_value = "")]
        description: String,
        /// Header color
        #[arg(long, default_value = devcel_core::project_impl::DEFAULT_PROJECT_HEADER_COLOR)]
        header_color: String,
    },
    /// Read saved project tag presets without connecting to a running editor
    TagPresets,
    /// Show P2P server status
    Status,
    /// Run as a headless P2P server (Ctrl+C to stop)
    Serve,
    /// Show project information
    Info,
    /// List project entries (tables, directories, etc.)
    Entries,
    /// Table operations
    Table {
        #[command(subcommand)]
        cmd: TableCmd,
    },
    /// Cell operations
    Cell {
        #[command(subcommand)]
        cmd: CellCmd,
    },
    /// Record operations
    Record {
        #[command(subcommand)]
        cmd: RecordCmd,
    },
    /// Column operations
    Column {
        #[command(subcommand)]
        cmd: ColumnCmd,
    },
    /// Interface operations (define and apply shared column structures across tables)
    Interface {
        #[command(subcommand)]
        cmd: InterfaceCmd,
    },
    /// Export runtime distribution JSON (for code generation and DLL readers)
    Export {
        #[command(subcommand)]
        cmd: ExportCmd,
    },
    /// Import multiple saved sources using the game project's settings (Studio is not required)
    Pull {
        #[arg(long, default_value = "devcel.import.json")]
        config: PathBuf,
        /// Reimport or check the status of a single source ID
        #[arg(long)]
        source: Option<String>,
        /// Read source/output status without changing files
        #[arg(long)]
        status: bool,
    },
    /// Validate and safely save import settings
    PullConfigSave {
        #[arg(long)]
        config: PathBuf,
        #[arg(long)]
        input: PathBuf,
        /// Settings SHA256 at load time; use missing for initial creation. Rejects overwrites from stale views.
        #[arg(long)]
        expected_revision: Option<String>,
    },
    /// Open the bundled browser settings UI on localhost (Ctrl+C to stop)
    ImporterUi {
        #[arg(long, value_parser = ["gamemaker", "wolf"], default_value = "gamemaker")]
        engine: String,
        #[arg(long, default_value = ".")]
        root: PathBuf,
        #[arg(long, default_value_t = 0)]
        port: u16,
        #[arg(long)]
        no_open: bool,
    },
    /// Convert saved WOLF runtime data to the official CSV import format
    WolfExport {
        #[arg(long, default_value = "devcel.import.json")]
        config: PathBuf,
        #[arg(long)]
        source: Option<String>,
    },
    /// Validate and generate Studio settings and theme sources
    AppCatalog {
        #[command(subcommand)]
        cmd: AppCatalogCmd,
    },
    /// Validate and generate Studio localization sources (using the saved database)
    Localization {
        #[command(subcommand)]
        cmd: LocalizationCmd,
    },
    /// Undo for a table
    Undo {
        /// Table (UUID, path, or name)
        table: String,
    },
    /// Redo for a table
    Redo {
        /// Table (UUID, path, or name)
        table: String,
    },
    /// Execute any DevcelOperation as JSON (an escape hatch supporting all operations)
    ///
    /// JSON uses adjacent tags: {"op": "operation_name", "data": {fields...}}
    /// Example: devcel op '{"op":"SetRecordValue","data":{"table_uuid":"..","record_uuid":"..","column_name":"hp","value":"100"}}'
    /// Use "-" to read JSON from standard input and avoid shell quoting issues
    Op {
        /// DevcelOperation JSON ("-" reads from stdin)
        json: String,
    },
    /// Subscribe to server broadcasts and output JSON Lines (Ctrl+C to stop)
    Watch {
        /// Reuse an existing server, or automatically start a shared server on demand
        #[arg(long)]
        ensure_server: bool,
        /// Exit when the caller's stdin pipe closes (for importers)
        #[arg(long)]
        parent_stdin: bool,
    },
    #[command(name = "__serve-managed", hide = true)]
    ManagedServe,
}

#[derive(Subcommand)]
enum AppCatalogCmd {
    Validate,
    Export {
        #[arg(long)]
        out: PathBuf,
        #[arg(long)]
        check: bool,
    },
}

#[derive(Subcommand)]
enum LocalizationCmd {
    /// Create the three standard localization tables and a minimal shared set of ja/en keys
    Init {
        #[arg(long, default_value = "localization")]
        dir: PathBuf,
        #[arg(long, default_value = "studio")]
        name: String,
    },
    /// Upsert a JSON array of source messages and translations [{key,ja,en?,context?,usage?}]
    Import { file: PathBuf },
    /// Update saved source revisions and mark changed translations as needs_review
    Reconcile,
    /// Validate source structure, references, required translations, review status, and ICU syntax
    Validate,
    /// Generate deterministic catalog.json / keys.ts after validation
    Export {
        #[arg(long, default_value = "devcel-studio/src/app/i18n/generated")]
        out: PathBuf,
        /// Check that generated output is up to date without writing files
        #[arg(long)]
        check: bool,
    },
}

#[derive(Subcommand)]
enum TableCmd {
    /// List tables
    List,
    /// Get table data (schema and all records)
    Get {
        /// Table (UUID, path, or name)
        table: String,
    },
    /// Create a table
    Create {
        /// Data name (used for filenames and identifiers)
        name: String,
        /// Display name (defaults to the data name)
        #[arg(long)]
        display_name: Option<String>,
        /// Parent directory (relative to the project root; defaults to the root)
        #[arg(long, default_value = "")]
        parent: String,
    },
}

#[derive(Subcommand)]
enum CellCmd {
    /// Set a cell value
    Set {
        /// Table (UUID, path, or name)
        table: String,
        /// Record UUID
        record: String,
        /// Column name (data_name)
        column: String,
        /// Value to set (formulas use the "=A1+B2" format)
        value: String,
    },
}

#[derive(Subcommand)]
enum RecordCmd {
    /// Set or change a same-table record parent (cycles are rejected)
    Parent {
        table: String,
        record: String,
        parent: String,
    },
    /// Remove the parent while preserving effective raw inputs and formulas
    Detach { table: String, record: String },
    /// Add a record (UUID is generated automatically or supplied with --uuid)
    Add {
        /// Table (UUID, path, or name)
        table: String,
        /// Record UUID (generated automatically if omitted)
        #[arg(long)]
        uuid: Option<String>,
    },
    /// Delete a record
    Delete {
        /// Table (UUID, path, or name)
        table: String,
        /// Record UUID
        record: String,
    },
}

#[derive(Subcommand)]
enum ColumnCmd {
    /// Set curve endpoints (identify the column by name or UUID)
    CurveConfig {
        table: String,
        column: String,
        #[arg(long, allow_hyphen_values = true)]
        start: f64,
        #[arg(long, allow_hyphen_values = true)]
        end: f64,
    },
    /// Set the interface required by a TableRef
    TableRefConfig {
        table: String,
        column: String,
        interface: String,
    },
    /// Set Select options as JSON {"options":[{"value":"v","label":"Label"}]}; use null to clear
    SelectConfig {
        table: String,
        column: String,
        config: String,
    },

    /// Add a column
    Add {
        /// Table (UUID, path, or name)
        table: String,
        /// Column name (data_name)
        name: String,
        /// Type: String/I32/I64/F32/F64/Boolean/Color32/ColorFloat/Select/DateTime/Reference, etc.
        #[arg(default_value = "String")]
        column_type: String,
    },
    /// Delete a column
    Remove {
        /// Table (UUID, path, or name)
        table: String,
        /// Column name (data_name)
        name: String,
    },
}

#[derive(Subcommand)]
enum InterfaceCmd {
    /// List interfaces
    List,
    /// Get interface details (columns, inheritance, history, and implementing tables)
    Get {
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Create an interface
    Create {
        /// Path relative to the Tables directory (e.g. common or common.interface.toml)
        path: String,
        /// Description
        #[arg(long, default_value = "")]
        description: String,
    },
    /// Delete an interface
    Delete {
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Interface column operations
    Column {
        #[command(subcommand)]
        cmd: InterfaceColumnCmd,
    },
    /// Set parent interfaces (replace all existing parents)
    Extends {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Parent interface UUIDs (none removes inheritance)
        parents: Vec<String>,
    },
    /// Apply an interface to a table
    Apply {
        /// Table (UUID, path, or name)
        table: String,
        /// Interface (UUID, name, or path)
        interface: String,
        /// Do not automatically add missing columns
        #[arg(long)]
        no_auto_add: bool,
    },
    /// Remove an interface from a table
    Unapply {
        /// Table (UUID, path, or name)
        table: String,
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Fully align a table with its interface definition
    Sync {
        /// Table (UUID, path, or name)
        table: String,
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Validate a table's interface implementation
    Validate {
        /// Table (UUID, path, or name)
        table: String,
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Get the interfaces implemented by a table
    TableList {
        /// Table (UUID, path, or name)
        table: String,
    },
    /// List interface branches (divergent versions)
    Branches {
        /// Interface (UUID, name, or path)
        interface: String,
    },
    /// Preview conflicts that would occur during a merge
    PreviewMerge {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Our version ID
        ours: String,
        /// Their version ID
        theirs: String,
    },
    /// Merge divergent histories
    Merge {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Our version ID
        ours: String,
        /// Their version ID
        theirs: String,
        /// Conflict resolution ("column_name=TakeOurs" format; repeatable)
        #[arg(long = "resolve")]
        resolve: Vec<String>,
    },
    /// Restore a previous version's content as a new version
    Revert {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Version ID to restore
        version: String,
    },
    /// Import history from another interface file
    Import {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Absolute path to the source interface file
        source_path: String,
    },
}

#[derive(Subcommand)]
enum InterfaceColumnCmd {
    /// Set Curve endpoints (preserving UUID and column order)
    CurveConfig {
        interface: String,
        name: String,
        #[arg(long, allow_hyphen_values = true)]
        start: f64,
        #[arg(long, allow_hyphen_values = true)]
        end: f64,
    },
    /// Set the interface required by a TableRef
    TableRefConfig {
        interface: String,
        name: String,
        target_interface: String,
    },
    /// Set Select options JSON or null
    SelectConfig {
        interface: String,
        name: String,
        config: String,
    },

    /// Add a column
    Add {
        /// Interface (UUID, name, or path)
        interface: String,
        /// Column name (data_name)
        name: String,
        /// Type: String/I32/I64/F32/F64/Boolean/Color32/ColorFloat/Select/DateTime/Reference, etc.
        #[arg(default_value = "String")]
        column_type: String,
        /// Default value
        #[arg(long, default_value = "")]
        default: String,
        /// Make the column required
        #[arg(long)]
        required: bool,
    },
    /// Delete a column
    Remove {
        interface: String,
        /// Column name (data_name)
        name: String,
    },
    /// Rename a column (preserving values in implementing tables)
    Rename {
        interface: String,
        /// Current column name
        old_name: String,
        /// New column name
        new_name: String,
    },
    /// Change a column's type
    Type {
        interface: String,
        /// Column name (data_name)
        name: String,
        /// New type
        new_type: String,
    },
    /// Change a column's default value
    Default {
        interface: String,
        /// Column name (data_name)
        name: String,
        /// Default value (an empty string clears it)
        value: String,
    },
    /// Change a column's required flag
    Required {
        interface: String,
        /// Column name (data_name)
        name: String,
        /// true / false
        #[arg(action = clap::ArgAction::Set)]
        required: bool,
    },
    /// Set column constraints (unspecified constraints are cleared)
    Constraints {
        interface: String,
        /// Column name (data_name)
        name: String,
        /// Require unique values
        #[arg(long)]
        unique: bool,
        /// Numeric lower bound
        #[arg(long)]
        min: Option<f64>,
        /// Numeric upper bound
        #[arg(long)]
        max: Option<f64>,
        /// Regular expression pattern
        #[arg(long)]
        pattern: Option<String>,
    },
}

/// Tag names are exact; repeat each flag for multiple names. Includes use OR; exclusions win.
#[derive(clap::Args, Default)]
struct TagFilterArgs {
    #[arg(long = "row-include-tag")]
    row_include_tags: Vec<String>,
    #[arg(long = "row-exclude-tag")]
    row_exclude_tags: Vec<String>,
    #[arg(long = "column-include-tag")]
    column_include_tags: Vec<String>,
    #[arg(long = "column-exclude-tag")]
    column_exclude_tags: Vec<String>,
}
impl From<TagFilterArgs> for devcel_core::tag_filter::TagFilter {
    fn from(value: TagFilterArgs) -> Self {
        Self {
            row_include_tags: value.row_include_tags,
            row_exclude_tags: value.row_exclude_tags,
            column_include_tags: value.column_include_tags,
            column_exclude_tags: value.column_exclude_tags,
        }
    }
}

#[derive(Subcommand)]
enum ExportCmd {
    /// Export a runtime distribution bundle (manifest and tables) as JSON
    ///
    /// The manifest includes a content_hash that consumers (DLL/Unity/UE)
    /// use to detect data updates during hot reload.
    Runtime {
        /// Export the minimal format (including default values). The default is full.
        #[arg(long)]
        minimal: bool,
        /// Explicitly allow export after acknowledging constraint violations
        #[arg(long)]
        allow_invalid: bool,
        /// Content version; when set, export only columns and records with min_version <= N
        #[arg(long)]
        version: Option<u32>,
        #[command(flatten)]
        filters: TagFilterArgs,
        /// Output file (if omitted, include data in stdout JSON)
        #[arg(long)]
        out: Option<String>,
    },
    /// Generate type-safe access code from the schema (codegen)
    Code {
        /// Target language: csharp (Unity) / cpp (Unreal)
        #[arg(value_parser = ["csharp", "cpp", "typescript"])]
        target: String,
        /// Output file (if omitted, include code in stdout JSON)
        #[arg(long)]
        out: Option<String>,
        /// Output namespace (language default if omitted: C# Devcel.Generated / C++ devcel)
        #[arg(long)]
        namespace: Option<String>,
        /// Content version; when set, generate only columns with min_version <= N
        #[arg(long)]
        version: Option<u32>,
        #[command(flatten)]
        filters: TagFilterArgs,
    },
    /// Batch-export runtime bundles and code using a configuration file
    ///
    /// Entry point for game-engine editor extensions (Unity/Unreal) to generate
    /// all configured destinations, versions, and targets with a single button.
    /// Example configuration file (TOML):
    ///   [[runtime]]
    ///   out = "Assets/StreamingAssets/master.json"
    ///   mode = "full"   # full | minimal (defaults to full)
    ///   version = 3      # all records if omitted
    ///
    ///   [[code]]
    ///   out = "Assets/Scripts/Generated/Devcel.cs"
    ///   target = "csharp"  # csharp | cpp
    ///   version = 3      # match the associated runtime version; all columns if omitted
    /// Relative out paths are resolved from the configuration file's directory.
    Run {
        /// Configuration path (if omitted, search for devcel.export.toml in the project root, then the current directory)
        #[arg(long)]
        config: Option<String>,
    },
}

/// Configuration file (TOML) for `export run`.
#[derive(serde::Deserialize, Default)]
struct ExportConfig {
    /// Runtime bundle output definitions
    #[serde(default)]
    runtime: Vec<RuntimeEntry>,
    /// Code generation definitions
    #[serde(default)]
    code: Vec<CodeEntry>,
}

#[derive(serde::Deserialize)]
struct RuntimeEntry {
    /// Output destination (absolute or relative to the configuration file)
    out: String,
    /// "full" / "minimal" (defaults to full)
    #[serde(default)]
    mode: Option<String>,
    /// Content version (all records if omitted)
    #[serde(default)]
    version: Option<u32>,
    #[serde(default)]
    allow_invalid: bool,
    #[serde(default, flatten)]
    filters: devcel_core::tag_filter::TagFilter,
}

#[derive(serde::Deserialize)]
struct CodeEntry {
    /// Output destination (absolute or relative to the configuration file)
    out: String,
    /// "csharp" / "cpp"
    target: String,
    /// Output namespace (language default if omitted)
    #[serde(default)]
    namespace: Option<String>,
    /// Content version (match the associated runtime version; all columns if omitted)
    #[serde(default)]
    version: Option<u32>,
    #[serde(default, flatten)]
    filters: devcel_core::tag_filter::TagFilter,
}

/// Handler that ignores broadcasts (for command-execution clients)
struct NoopHandler;

#[async_trait::async_trait]
impl OperationHandler for NoopHandler {
    async fn apply_server_snapshot(&self, _snapshot: serde_json::Value) -> DevcelResponse {
        DevcelResponse::Ok(serde_json::Value::Null)
    }
    async fn handle_operation(&self, _operation: DevcelOperation) -> DevcelResponse {
        DevcelResponse::Ok(serde_json::json!({ "ignored": true }))
    }
}

/// Handler that writes broadcasts to stdout as JSON Lines (for watch)
struct PrintHandler;

#[async_trait::async_trait]
impl OperationHandler for PrintHandler {
    async fn apply_server_snapshot(&self, snapshot: serde_json::Value) -> DevcelResponse {
        let line = serde_json::json!({ "event": "snapshot", "project_state": snapshot });
        println!("{line}");
        DevcelResponse::Ok(serde_json::json!({ "printed": true }))
    }
    async fn handle_operation(&self, _operation: DevcelOperation) -> DevcelResponse {
        DevcelResponse::Error("Watch accepts committed snapshots only".into())
    }
}

/// Operation execution target (P2P client or local project)
enum Backend {
    Client(MsgPackClient),
    Local(LocalOperationHandler),
}

impl Backend {
    async fn execute(&self, op: DevcelOperation) -> DevcelResponse {
        match self {
            Backend::Client(client) => match DevcelClient::send_operation(client, op).await {
                Ok(resp) => resp,
                Err(e) => DevcelResponse::Error(e),
            },
            Backend::Local(handler) => handler.handle_operation(op).await,
        }
    }

    /// Local exports write without building a bundle; P2P uses the current bundle response.
    async fn export_runtime_file(
        &self,
        mode: &str,
        version: Option<u32>,
        allow_invalid: bool,
        filters: &devcel_core::tag_filter::TagFilter,
        path: &str,
    ) -> Result<serde_json::Value, devcel_core::AppError> {
        if let Backend::Local(handler) = self {
            use devcel_core::json_export::{
                export_runtime_bundle_to_file_with_filters, ExportMode,
            };

            let mut guard = handler.project.lock().await;
            let project = guard
                .as_mut()
                .ok_or_else(|| devcel_core::AppError::text("No project open"))?;
            let export_mode = match mode.to_lowercase().as_str() {
                "minimal" => ExportMode::Minimal,
                "full" => ExportMode::Full,
                other => {
                    return Err(devcel_core::AppError::text(format!(
                        "Invalid export mode: {other} (specify full or minimal)"
                    )))
                }
            };
            let summary = export_runtime_bundle_to_file_with_filters(
                project,
                export_mode,
                version,
                allow_invalid,
                filters,
                path,
            )?;
            return Ok(serde_json::json!({
                "out": path,
                "manifest": summary.manifest,
                "table_count": summary.table_count,
                "record_count": summary.record_count,
            }));
        }

        let bundle = match self
            .execute(DevcelOperation::ExportRuntimeBundle {
                mode: mode.to_string(),
                version,
                allow_invalid,
                filters: filters.clone(),
            })
            .await
        {
            DevcelResponse::Ok(bundle) => bundle,
            DevcelResponse::Error(error) => return Err(error),
        };
        let json = serde_json::to_string_pretty(&bundle).map_err(|e| {
            devcel_core::AppError::text(format!("Failed to format the bundle: {e}"))
        })?;
        devcel_core::json_export::write_export_file(path, &json).map_err(|e| {
            devcel_core::AppError::text(format!("Failed to write the file ({path}): {e}"))
        })?;
        let table_count = bundle["tables"].as_array().map(|t| t.len()).unwrap_or(0);
        let record_count: usize = bundle["tables"]
            .as_array()
            .map(|tables| {
                tables
                    .iter()
                    .map(|t| t["records"].as_array().map(|r| r.len()).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0);
        Ok(serde_json::json!({
            "out": path,
            "manifest": bundle["manifest"].clone(),
            "table_count": table_count,
            "record_count": record_count,
        }))
    }

    async fn shutdown(self) {
        if let Backend::Client(mut client) = self {
            DevcelClient::disconnect(&mut client).await;
        }
    }
}

fn emit(pretty: bool, value: &serde_json::Value) {
    let text = if pretty {
        serde_json::to_string_pretty(value)
    } else {
        serde_json::to_string(value)
    };
    println!("{}", text.unwrap_or_else(|_| "{}".to_string()));
}

fn succeed(pretty: bool, data: serde_json::Value) -> ! {
    emit(pretty, &serde_json::json!({ "ok": true, "data": data }));
    std::process::exit(0);
}

fn bail(pretty: bool, error: impl Into<devcel_core::AppError>) -> ! {
    let error: devcel_core::AppError = error.into();
    emit(pretty, &serde_json::json!({ "ok": false, "error": error }));
    std::process::exit(1);
}

/// Extract response data, or exit on error
fn unwrap_response(pretty: bool, resp: DevcelResponse) -> serde_json::Value {
    match resp {
        DevcelResponse::Ok(v) => v,
        DevcelResponse::Error(e) => bail(pretty, e),
    }
}

/// Resolve the project file (.devcelproj.toml) path
/// Search inside the supplied directory, if applicable
fn resolve_project_path(input: Option<&str>) -> Result<String, String> {
    let raw = input.ok_or(
        "No project specified. Set --project <path> or the DEVCEL_PROJECT environment variable",
    )?;
    let path = Path::new(raw);

    if path.is_file() {
        return Ok(raw.to_string());
    }
    if path.is_dir() {
        let found = std::fs::read_dir(path)
            .map_err(|e| format!("Could not read the directory: {e}"))?
            .flatten()
            .map(|e| e.path())
            .find(|p| {
                p.file_name()
                    .map(|n| n.to_string_lossy().ends_with(".devcelproj.toml"))
                    .unwrap_or(false)
            });
        return match found {
            Some(p) => Ok(p.to_string_lossy().to_string()),
            None => Err(format!("No .devcelproj.toml found in {raw}")),
        };
    }
    Err(format!("Project not found: {raw}"))
}

/// Find an active server in the registry
fn find_server(project_path: &str) -> Option<devcel_core::discovery::ServiceInfo> {
    let registry = FileBasedRegistry::new().ok()?;
    registry.find_active_server(project_path)
}

/// Open the project locally. File exports read tables sequentially, so do not preload them.
fn open_local_project(
    project_path: &str,
    preload_tables: bool,
) -> Result<devcel_core::Project, String> {
    let mut project = devcel_core::Project::open_project(project_path)
        .map_err(|e| format!("Could not open the project: {e}"))?;

    if !preload_tables {
        return Ok(project);
    }

    // Load all tables for ordinary CLI operations so reads always work
    let entries = project.get_project_entries().unwrap_or_default();
    for entry in entries {
        if entry.entry_type == devcel_core::ProjectEntryType::Table {
            // Resolve entry.path to an absolute path because it is relative to Tables
            if let Ok(full_path) = project.resolve_table_path(&PathBuf::from(&entry.path)) {
                let _ = project.load_table(&full_path);
            }
        }
    }
    Ok(project)
}

/// Build the Backend according to the connection mode
async fn connect_backend(
    project_path: &str,
    mode: &str,
    preload_tables: bool,
) -> Result<(Backend, &'static str), String> {
    let server = find_server(project_path);

    match (mode, server) {
        ("local", server) => {
            if server.is_some() {
                eprintln!(
                    "[devcel] Warning: a P2P server is running. Local-mode writes may conflict"
                );
            }
            let project = open_local_project(project_path, preload_tables)?;
            let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
            Ok((Backend::Local(handler), "local"))
        }
        ("client", None) => Err(
            "No P2P server found (--mode client). Start Devcel Studio or run `devcel serve`"
                .to_string(),
        ),
        (_, Some(server)) => {
            let mut client = MsgPackClient::new();
            client.set_operation_handler(Arc::new(NoopHandler));
            DevcelClient::connect(&mut client, server.address)
                .await
                .map_err(|e| format!("Failed to connect to server {}: {e}", server.address))?;
            Ok((Backend::Client(client), "client"))
        }
        ("auto", None) => {
            let project = open_local_project(project_path, preload_tables)?;
            let handler = LocalOperationHandler::new(Arc::new(Mutex::new(Some(project))));
            Ok((Backend::Local(handler), "local"))
        }
        _ => unreachable!(),
    }
}

/// Resolve a table identifier (UUID, path, or name) to its UUID
/// Load unloaded tables before resolving them
async fn resolve_table_uuid(pretty: bool, backend: &Backend, ident: &str) -> (String, String) {
    let entries = unwrap_response(
        pretty,
        backend.execute(DevcelOperation::GetProjectEntries).await,
    );
    let empty = vec![];
    let list = entries["entries"].as_array().unwrap_or(&empty);

    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let needle = norm(ident);

    let tables: Vec<&serde_json::Value> = list.iter().filter(|e| e["type"] == "table").collect();

    let matches: Vec<&&serde_json::Value> = tables
        .iter()
        .filter(|e| {
            let path = e["path"].as_str().unwrap_or("");
            let uuid = e["uuid"].as_str().unwrap_or("");
            uuid == ident || norm(path) == needle || norm(path).contains(&needle)
        })
        .collect();

    let entry = match matches.len() {
        0 => bail(
            pretty,
            format!(
                "Table not found: {ident} (candidates: {})",
                tables
                    .iter()
                    .map(|e| e["path"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ),
        1 => matches[0],
        _ => bail(
            pretty,
            format!(
                "Ambiguous table identifier: {ident} (matches: {})",
                matches
                    .iter()
                    .map(|e| e["path"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ),
    };

    let path = entry["path"].as_str().unwrap_or("").to_string();

    // Use the UUID if the table is already loaded
    // (LoadTable clears undo history, so avoid unnecessary reloads)
    let uuid_field = entry["uuid"].as_str().unwrap_or("");
    if !uuid_field.is_empty() && uuid_field != path {
        return (uuid_field.to_string(), path);
    }

    // Load only if not already loaded
    let _ = backend
        .execute(DevcelOperation::LoadTable {
            table_path: path.clone(),
        })
        .await;

    // Fetch again after loading to obtain the UUID (unloaded entries fall back to uuid == path)
    let entries = unwrap_response(
        pretty,
        backend.execute(DevcelOperation::GetProjectEntries).await,
    );
    let uuid = entries["entries"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .find(|e| e["type"] == "table" && e["path"] == path.as_str())
        .and_then(|e| e["uuid"].as_str())
        .unwrap_or("")
        .to_string();

    if uuid.is_empty() || uuid == path {
        bail(pretty, format!("Failed to load the table: {path}"));
    }
    (uuid, path)
}

/// Resolve an interface identifier (UUID, name, or path) to its UUID
async fn resolve_interface_uuid(pretty: bool, backend: &Backend, ident: &str) -> String {
    let resp = backend.execute(DevcelOperation::ListInterfaces).await;
    let data = unwrap_response(pretty, resp);
    let empty = vec![];
    let list = data["interfaces"].as_array().unwrap_or(&empty);

    let norm = |s: &str| s.replace('\\', "/").to_lowercase();
    let needle = norm(ident);

    let matches: Vec<&serde_json::Value> = list
        .iter()
        .filter(|e| {
            let uuid = e["uuid"].as_str().unwrap_or("");
            let name = e["name"].as_str().unwrap_or("");
            let path = e["path"].as_str().unwrap_or("");
            uuid == ident
                || norm(name) == needle
                || norm(path) == needle
                || norm(path).contains(&needle)
        })
        .collect();

    match matches.len() {
        0 => bail(
            pretty,
            format!(
                "Interface not found: {ident} (candidates: {})",
                list.iter()
                    .map(|e| e["name"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ),
        1 => matches[0]["uuid"].as_str().unwrap_or("").to_string(),
        _ => bail(
            pretty,
            format!(
                "Ambiguous interface identifier: {ident} (matches: {})",
                matches
                    .iter()
                    .map(|e| e["name"].as_str().unwrap_or(""))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
        ),
    }
}

/// Resolve the configuration path for `export run`.
/// Use --config when supplied. Otherwise search for devcel.export.toml
/// in the project root, then the current directory.
fn resolve_export_config_path(pretty: bool, config: Option<&str>, project_path: &str) -> String {
    if let Some(c) = config {
        return c.to_string();
    }

    const NAME: &str = "devcel.export.toml";

    // Directory containing the project file
    if let Some(dir) = Path::new(project_path).parent() {
        let candidate = dir.join(NAME);
        if candidate.is_file() {
            return candidate.to_string_lossy().to_string();
        }
    }
    // Current directory
    let cwd_candidate = Path::new(NAME);
    if cwd_candidate.is_file() {
        return cwd_candidate.to_string_lossy().to_string();
    }

    bail(
        pretty,
        format!("Configuration file not found (specify --config <path> or create {NAME})"),
    )
}

/// Create the output file's parent directory if it does not exist.
fn ensure_parent_dir(pretty: bool, out_path: &str) {
    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).unwrap_or_else(|e| {
                bail(
                    pretty,
                    format!("Failed to create the directory ({}): {e}", parent.display()),
                )
            });
        }
    }
}

/// Common flow for executing an operation and printing its result
async fn run_simple(pretty: bool, backend: Backend, op: DevcelOperation) -> ! {
    let resp = backend.execute(op).await;
    backend.shutdown().await;
    let data = unwrap_response(pretty, resp);
    succeed(pretty, data)
}

fn main() {
    let cli = Cli::parse();
    process_lifetime::close_inherited_descriptors().unwrap_or_else(|e| bail(cli.pretty, e));
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .unwrap_or_else(|e| bail(cli.pretty, e.to_string()));
    runtime.block_on(run(cli));
}

async fn run(cli: Cli) {
    let pretty = cli.pretty;

    match cli.command {
        // === Commands that need no connection or require special handling ===
        Command::TagPresets => {
            let path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            let text =
                std::fs::read_to_string(&path).unwrap_or_else(|e| bail(pretty, e.to_string()));
            let data: devcel_core::project_impl::ProjectFileData = toml::from_str(&text)
                .unwrap_or_else(|e| bail(pretty, format!("Invalid project metadata: {e}")));
            succeed(pretty, serde_json::json!({"presets": data.tag_presets}));
        }
        Command::Init {
            name,
            dir,
            description,
            header_color,
        } => {
            let project =
                devcel_core::Project::create_project(&name, &dir, &description, &header_color)
                    .unwrap_or_else(|e| bail(pretty, format!("Failed to create the project: {e}")));
            succeed(
                pretty,
                serde_json::json!({
                    "project_path": project.get_project_path(),
                    "name": name,
                }),
            );
        }

        Command::PullConfigSave {
            config,
            input,
            expected_revision,
        } => {
            let bytes =
                std::fs::read(input).unwrap_or_else(|error| bail(pretty, error.to_string()));
            let settings = serde_json::from_slice(&bytes)
                .unwrap_or_else(|error| bail(pretty, error.to_string()));
            let revision = devcel_core::importer_pull::save_config_if_revision(
                &config,
                &settings,
                expected_revision.as_deref(),
            )
            .unwrap_or_else(|error| bail(pretty, error));
            succeed(
                pretty,
                serde_json::json!({"saved":true,"revision":revision}),
            );
        }
        Command::ImporterUi {
            engine,
            root,
            port,
            no_open,
        } => {
            importer_ui::serve(&root, &engine, port, !no_open)
                .unwrap_or_else(|error| bail(pretty, error));
        }
        Command::WolfExport { config, source } => {
            let result = wolf_export::export(&config, source.as_deref())
                .unwrap_or_else(|error| bail(pretty, error));
            succeed(pretty, result);
        }

        Command::Pull {
            config,
            source,
            status,
        } => {
            let report = devcel_core::importer_pull::run(&config, source.as_deref(), status)
                .unwrap_or_else(|error| bail(pretty, error));
            let success = report.success;
            emit(pretty, &serde_json::json!({"ok": success, "data": report}));
            std::process::exit(if success { 0 } else { 1 });
        }

        Command::AppCatalog { cmd } => {
            let path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            let project = devcel_core::localization::load(Path::new(&path))
                .unwrap_or_else(|e| bail(pretty, e));
            match cmd {
                AppCatalogCmd::Validate => {
                    devcel_core::app_catalog::generate(&project)
                        .unwrap_or_else(|e| bail(pretty, e));
                }
                AppCatalogCmd::Export { out, check } => {
                    devcel_core::app_catalog::export(&project, &out, check)
                        .unwrap_or_else(|e| bail(pretty, e))
                }
            }
            succeed(pretty, serde_json::json!({"valid": true}));
        }
        Command::Localization { cmd } => {
            use devcel_core::localization;
            if let LocalizationCmd::Init { dir, name } = &cmd {
                let path = localization::init(dir, name).unwrap_or_else(|e| bail(pretty, e));
                succeed(pretty, serde_json::json!({"project_path": path}));
            }
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            if matches!(
                cmd,
                LocalizationCmd::Import { .. } | LocalizationCmd::Reconcile
            ) && find_server(&project_path).is_some()
            {
                bail(
                    pretty,
                    "Close any Studio/serve instance using this source before importing or reconciling translations",
                );
            }
            let mut project =
                localization::load(Path::new(&project_path)).unwrap_or_else(|e| bail(pretty, e));
            let data = match cmd {
                LocalizationCmd::Import { file } => {
                    let bytes = std::fs::read(file).unwrap_or_else(|e| bail(pretty, e));
                    let entries: Vec<localization::ImportMessage> =
                        serde_json::from_slice(&bytes).unwrap_or_else(|e| bail(pretty, e));
                    let count = localization::import(&mut project, &entries)
                        .unwrap_or_else(|e| bail(pretty, e));
                    serde_json::json!({"imported": count})
                }
                LocalizationCmd::Reconcile => {
                    let count =
                        localization::reconcile(&mut project).unwrap_or_else(|e| bail(pretty, e));
                    serde_json::json!({"reconciled": count})
                }
                LocalizationCmd::Validate => {
                    let generated =
                        localization::validate(&project).unwrap_or_else(|e| bail(pretty, e));
                    serde_json::json!({"valid": true, "hash": generated.catalog.hash,
                        "messages": generated.catalog.messages["ja"].len()})
                }
                LocalizationCmd::Export { out, check } => {
                    let hash = localization::export(&project, &out, check)
                        .unwrap_or_else(|e| bail(pretty, e));
                    serde_json::json!({"out": out, "check": check, "hash": hash})
                }
                LocalizationCmd::Init { .. } => unreachable!(),
            };
            succeed(pretty, data);
        }

        Command::Status => {
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            match find_server(&project_path) {
                Some(server) => succeed(
                    pretty,
                    serde_json::json!({
                        "server_running": true,
                        "address": server.address.to_string(),
                        "app_type": server.app_type,
                        "project_path": server.project_path,
                    }),
                ),
                None => succeed(pretty, serde_json::json!({ "server_running": false })),
            }
        }

        Command::Serve => {
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));

            use devcel_core::msgpack_server::MsgPackServer;
            use devcel_core::p2p_manager::{ConnectionMode, P2PManager};

            let mut manager = P2PManager::new();
            manager.set_preload_server_tables(true);
            manager
                .set_client_impl(Box::new(MsgPackClient::new()))
                .await;
            manager.set_server_impl(Box::new(MsgPackServer::new(manager.project_ref())));

            let mode = manager
                .open_project_p2p(&project_path, "devcel-cli", 0)
                .await
                .unwrap_or_else(|e| bail(pretty, e));

            match &mode {
                ConnectionMode::Server { listening_addr } => {
                    emit(
                        pretty,
                        &serde_json::json!({
                            "ok": true,
                            "data": { "mode": "server", "address": listening_addr.to_string() }
                        }),
                    );
                    eprintln!("[devcel] Server running (Ctrl+C to stop)");
                }
                ConnectionMode::Client { server_addr } => {
                    emit(
                        pretty,
                        &serde_json::json!({
                            "ok": true,
                            "data": {
                                "mode": "client",
                                "server": server_addr.to_string(),
                                "note": "Connected as a client because a server is already running"
                            }
                        }),
                    );
                    eprintln!("[devcel] Connected to the existing server (Ctrl+C to stop)");
                }
            }

            let _ = tokio::signal::ctrl_c().await;
            let _ = manager.disconnect().await;
            std::process::exit(0);
        }

        Command::Watch {
            ensure_server,
            parent_stdin,
        } => {
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            if let Err(error) =
                managed_watch::watch(&project_path, ensure_server, parent_stdin).await
            {
                bail(pretty, error);
            }
            std::process::exit(0);
        }
        Command::ManagedServe => {
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            if let Err(error) = managed_watch::serve(&project_path).await {
                bail(pretty, error);
            }
            std::process::exit(0);
        }

        // === Ordinary operation commands ===
        command => {
            let project_path =
                resolve_project_path(cli.project.as_deref()).unwrap_or_else(|e| bail(pretty, e));
            let preload_tables = !matches!(
                &command,
                Command::Export {
                    cmd: ExportCmd::Runtime { out: Some(_), .. } | ExportCmd::Run { .. }
                }
            );
            let (backend, mode) = connect_backend(&project_path, &cli.mode, preload_tables)
                .await
                .unwrap_or_else(|e| bail(pretty, e));
            eprintln!("[devcel] mode={mode}");

            match command {
                Command::Info => {
                    run_simple(pretty, backend, DevcelOperation::GetProjectInfo).await;
                }
                Command::Entries => {
                    run_simple(pretty, backend, DevcelOperation::GetProjectEntries).await;
                }
                Command::Table { cmd } => match cmd {
                    TableCmd::List => {
                        let resp = backend.execute(DevcelOperation::GetProjectEntries).await;
                        backend.shutdown().await;
                        let data = unwrap_response(pretty, resp);
                        let empty = vec![];
                        let tables: Vec<&serde_json::Value> = data["entries"]
                            .as_array()
                            .unwrap_or(&empty)
                            .iter()
                            .filter(|e| e["type"] == "table")
                            .collect();
                        succeed(pretty, serde_json::json!({ "tables": tables }));
                    }
                    TableCmd::Get { table } => {
                        let (uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::GetTableData { table_uuid: uuid },
                        )
                        .await;
                    }
                    TableCmd::Create {
                        name,
                        display_name,
                        parent,
                    } => {
                        let display = display_name.unwrap_or_else(|| name.clone());
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::CreateTable {
                                parent_path: parent,
                                data_name: name,
                                display_name: display,
                            },
                        )
                        .await;
                    }
                },
                Command::Cell { cmd } => match cmd {
                    CellCmd::Set {
                        table,
                        record,
                        column,
                        value,
                    } => {
                        let (uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetRecordValue {
                                table_uuid: uuid,
                                record_uuid: record,
                                column_name: column,
                                value,
                            },
                        )
                        .await;
                    }
                },
                Command::Record { cmd } => match cmd {
                    RecordCmd::Parent {
                        table,
                        record,
                        parent,
                    } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetRecordParentUuid {
                                table_uuid,
                                record_uuid: record,
                                parent_uuid: parent,
                            },
                        )
                        .await;
                    }
                    RecordCmd::Detach { table, record } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetRecordParentUuid {
                                table_uuid,
                                record_uuid: record,
                                parent_uuid: String::new(),
                            },
                        )
                        .await;
                    }
                    RecordCmd::Add { table, uuid } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        let record_uuid = uuid.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
                        let resp = backend
                            .execute(DevcelOperation::AddRecord {
                                table_uuid,
                                record_uuid: record_uuid.clone(),
                            })
                            .await;
                        backend.shutdown().await;
                        let _ = unwrap_response(pretty, resp);
                        succeed(pretty, serde_json::json!({ "record_uuid": record_uuid }));
                    }
                    RecordCmd::Delete { table, record } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::DeleteRecord {
                                table_uuid,
                                record_uuid: record,
                            },
                        )
                        .await;
                    }
                },
                Command::Column { cmd } => match cmd {
                    ColumnCmd::CurveConfig {
                        table,
                        column,
                        start,
                        end,
                    } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetColumnCurveConfig {
                                table_uuid,
                                column_name: column,
                                config: devcel_core::CurveConfig {
                                    start_value: start,
                                    end_value: end,
                                },
                            },
                        )
                        .await;
                    }
                    ColumnCmd::TableRefConfig {
                        table,
                        column,
                        interface,
                    } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        let interface_uuid =
                            resolve_interface_uuid(pretty, &backend, &interface).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetColumnTableRefConfig {
                                table_uuid,
                                column_name: column,
                                config: devcel_core::TableRefConfig { interface_uuid },
                            },
                        )
                        .await;
                    }
                    ColumnCmd::SelectConfig {
                        table,
                        column,
                        config,
                    } => {
                        let config: Option<devcel_core::SelectConfig> =
                            serde_json::from_str(&config).unwrap_or_else(|e| {
                                bail(pretty, format!("Invalid Select config: {e}"))
                            });
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::SetColumnSelectConfig {
                                table_uuid,
                                column_name: column,
                                config,
                            },
                        )
                        .await;
                    }

                    ColumnCmd::Add {
                        table,
                        name,
                        column_type,
                    } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::AddColumn {
                                table_uuid,
                                column_name: name,
                                column_type,
                            },
                        )
                        .await;
                    }
                    ColumnCmd::Remove { table, name } => {
                        let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                        run_simple(
                            pretty,
                            backend,
                            DevcelOperation::RemoveColumn {
                                table_uuid,
                                column_name: name,
                            },
                        )
                        .await;
                    }
                },
                Command::Interface { cmd } => {
                    use devcel_core::operations::InterfaceResolution;
                    match cmd {
                        InterfaceCmd::List => {
                            run_simple(pretty, backend, DevcelOperation::ListInterfaces).await;
                        }
                        InterfaceCmd::Get { interface } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::GetInterfaceDetails {
                                    interface_uuid: uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Create { path, description } => {
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::CreateInterface { path, description },
                            )
                            .await;
                        }
                        InterfaceCmd::Delete { interface } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::DeleteInterface {
                                    interface_uuid: uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Column { cmd } => {
                            let op = match cmd {
                                InterfaceColumnCmd::CurveConfig {
                                    interface,
                                    name,
                                    start,
                                    end,
                                } => {
                                    let interface_uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::SetInterfaceColumnCurveConfig {
                                        interface_uuid,
                                        column_name: name,
                                        config: devcel_core::CurveConfig {
                                            start_value: start,
                                            end_value: end,
                                        },
                                    }
                                }
                                InterfaceColumnCmd::TableRefConfig {
                                    interface,
                                    name,
                                    target_interface,
                                } => {
                                    let interface_uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    let target =
                                        resolve_interface_uuid(pretty, &backend, &target_interface)
                                            .await;
                                    DevcelOperation::SetInterfaceColumnTableRefConfig {
                                        interface_uuid,
                                        column_name: name,
                                        config: devcel_core::TableRefConfig {
                                            interface_uuid: target,
                                        },
                                    }
                                }
                                InterfaceColumnCmd::SelectConfig {
                                    interface,
                                    name,
                                    config,
                                } => {
                                    let interface_uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    let config =
                                        serde_json::from_str(&config).unwrap_or_else(|e| {
                                            bail(pretty, format!("Invalid Select config: {e}"))
                                        });
                                    DevcelOperation::SetInterfaceColumnSelectConfig {
                                        interface_uuid,
                                        column_name: name,
                                        config,
                                    }
                                }
                                InterfaceColumnCmd::Add {
                                    interface,
                                    name,
                                    column_type,
                                    default,
                                    required,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::AddInterfaceColumn {
                                        interface_uuid: uuid,
                                        column_name: name,
                                        column_type,
                                        default_value: default,
                                        required,
                                    }
                                }
                                InterfaceColumnCmd::Remove { interface, name } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::RemoveInterfaceColumn {
                                        interface_uuid: uuid,
                                        column_name: name,
                                    }
                                }
                                InterfaceColumnCmd::Rename {
                                    interface,
                                    old_name,
                                    new_name,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::RenameInterfaceColumn {
                                        interface_uuid: uuid,
                                        old_name,
                                        new_name,
                                    }
                                }
                                InterfaceColumnCmd::Type {
                                    interface,
                                    name,
                                    new_type,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::SetInterfaceColumnType {
                                        interface_uuid: uuid,
                                        column_name: name,
                                        new_type,
                                    }
                                }
                                InterfaceColumnCmd::Default {
                                    interface,
                                    name,
                                    value,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::SetInterfaceColumnDefault {
                                        interface_uuid: uuid,
                                        column_name: name,
                                        default_value: value,
                                    }
                                }
                                InterfaceColumnCmd::Required {
                                    interface,
                                    name,
                                    required,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::SetInterfaceColumnRequired {
                                        interface_uuid: uuid,
                                        column_name: name,
                                        required,
                                    }
                                }
                                InterfaceColumnCmd::Constraints {
                                    interface,
                                    name,
                                    unique,
                                    min,
                                    max,
                                    pattern,
                                } => {
                                    let uuid =
                                        resolve_interface_uuid(pretty, &backend, &interface).await;
                                    DevcelOperation::SetInterfaceColumnConstraints {
                                        interface_uuid: uuid,
                                        column_name: name,
                                        unique: if unique { Some(true) } else { None },
                                        min_value: min,
                                        max_value: max,
                                        pattern,
                                    }
                                }
                            };
                            run_simple(pretty, backend, op).await;
                        }
                        InterfaceCmd::Extends { interface, parents } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::SetInterfaceExtends {
                                    interface_uuid: uuid,
                                    parent_uuids: parents,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Apply {
                            table,
                            interface,
                            no_auto_add,
                        } => {
                            let (table_uuid, _) =
                                resolve_table_uuid(pretty, &backend, &table).await;
                            let interface_uuid =
                                resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::ApplyInterfaceToTable {
                                    acknowledgement: None,
                                    table_uuid,
                                    interface_uuid,
                                    auto_add_columns: !no_auto_add,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Unapply { table, interface } => {
                            let (table_uuid, _) =
                                resolve_table_uuid(pretty, &backend, &table).await;
                            let interface_uuid =
                                resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::RemoveInterfaceFromTable {
                                    acknowledgement: None,
                                    table_uuid,
                                    interface_uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Sync { table, interface } => {
                            let (table_uuid, _) =
                                resolve_table_uuid(pretty, &backend, &table).await;
                            let interface_uuid =
                                resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::SyncTableWithInterface {
                                    acknowledgement: None,
                                    table_uuid,
                                    interface_uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Validate { table, interface } => {
                            let (table_uuid, _) =
                                resolve_table_uuid(pretty, &backend, &table).await;
                            let interface_uuid =
                                resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::ValidateInterfaceImplementation {
                                    table_uuid,
                                    interface_uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::TableList { table } => {
                            let (table_uuid, _) =
                                resolve_table_uuid(pretty, &backend, &table).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::GetTableInterfaces { table_uuid },
                            )
                            .await;
                        }
                        InterfaceCmd::Branches { interface } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::GetInterfaceBranches {
                                    interface_uuid: uuid,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::PreviewMerge {
                            interface,
                            ours,
                            theirs,
                        } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::PreviewInterfaceMerge {
                                    interface_uuid: uuid,
                                    ours_version: ours,
                                    theirs_version: theirs,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Merge {
                            interface,
                            ours,
                            theirs,
                            resolve,
                        } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            let mut resolutions = Vec::new();
                            for r in &resolve {
                                match r.split_once('=') {
                                    Some((col, res)) => resolutions.push(InterfaceResolution {
                                        column_name: col.to_string(),
                                        resolution: res.to_string(),
                                    }),
                                    None => bail(
                                        pretty,
                                        format!("--resolve requires the \"column_name=TakeOurs\" format: {r}"),
                                    ),
                                }
                            }
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::MergeInterfaceBranches {
                                    interface_uuid: uuid,
                                    ours_version: ours,
                                    theirs_version: theirs,
                                    resolutions,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Revert { interface, version } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::RevertInterfaceToVersion {
                                    interface_uuid: uuid,
                                    target_version: version,
                                },
                            )
                            .await;
                        }
                        InterfaceCmd::Import {
                            interface,
                            source_path,
                        } => {
                            let uuid = resolve_interface_uuid(pretty, &backend, &interface).await;
                            run_simple(
                                pretty,
                                backend,
                                DevcelOperation::ImportInterfaceHistory {
                                    interface_uuid: uuid,
                                    source_path,
                                },
                            )
                            .await;
                        }
                    }
                }
                Command::Export { cmd } => match cmd {
                    ExportCmd::Runtime {
                        minimal,
                        allow_invalid,
                        version,
                        filters,
                        out,
                    } => {
                        let filters = filters.into();
                        let mode = if minimal { "minimal" } else { "full" }.to_string();
                        if let Some(path) = out {
                            let result = backend
                                .export_runtime_file(&mode, version, allow_invalid, &filters, &path)
                                .await;
                            backend.shutdown().await;
                            succeed(pretty, result.unwrap_or_else(|e| bail(pretty, e)));
                        }

                        let resp = backend
                            .execute(DevcelOperation::ExportRuntimeBundle {
                                mode,
                                version,
                                allow_invalid,
                                filters,
                            })
                            .await;
                        backend.shutdown().await;
                        succeed(pretty, unwrap_response(pretty, resp));
                    }
                    ExportCmd::Code {
                        target,
                        out,
                        namespace,
                        version,
                        filters,
                    } => {
                        let resp = backend
                            .execute(DevcelOperation::ExportCode {
                                target: target.clone(),
                                namespace,
                                version,
                                filters: filters.into(),
                            })
                            .await;
                        backend.shutdown().await;
                        let data = unwrap_response(pretty, resp);
                        let code = data["code"].as_str().unwrap_or("");

                        match out {
                            Some(path) => {
                                devcel_core::json_export::write_export_file(&path, code)
                                    .unwrap_or_else(|e| {
                                        bail(
                                            pretty,
                                            format!("Failed to write the file ({path}): {e}"),
                                        )
                                    });
                                succeed(
                                    pretty,
                                    serde_json::json!({
                                        "out": path,
                                        "target": target,
                                        "version": version,
                                        "bytes": code.len(),
                                    }),
                                );
                            }
                            None => succeed(pretty, data),
                        }
                    }
                    ExportCmd::Run { config } => {
                        // Resolve the configuration file
                        let config_path =
                            resolve_export_config_path(pretty, config.as_deref(), &project_path);
                        let config_text =
                            std::fs::read_to_string(&config_path).unwrap_or_else(|e| {
                                bail(
                                    pretty,
                                    format!("Could not read the configuration file ({config_path}): {e}"),
                                )
                            });
                        let cfg: ExportConfig = toml::from_str(&config_text).unwrap_or_else(|e| {
                            bail(
                                pretty,
                                format!(
                                    "Failed to parse the configuration file ({config_path}): {e}"
                                ),
                            )
                        });

                        // Resolve relative out paths from the configuration file's directory
                        let base_dir = Path::new(&config_path)
                            .parent()
                            .map(|p| p.to_path_buf())
                            .unwrap_or_else(|| PathBuf::from("."));
                        let resolve_out = |out: &str| -> String {
                            let p = Path::new(out);
                            if p.is_absolute() {
                                out.to_string()
                            } else {
                                base_dir.join(p).to_string_lossy().to_string()
                            }
                        };

                        let mut outputs: Vec<serde_json::Value> = Vec::new();

                        // Runtime bundle
                        for entry in &cfg.runtime {
                            let mode = entry.mode.clone().unwrap_or_else(|| "full".to_string());
                            let out_path = resolve_out(&entry.out);
                            ensure_parent_dir(pretty, &out_path);
                            let summary = backend
                                .export_runtime_file(
                                    &mode,
                                    entry.version,
                                    entry.allow_invalid,
                                    &entry.filters,
                                    &out_path,
                                )
                                .await
                                .unwrap_or_else(|e| bail(pretty, e));
                            outputs.push(serde_json::json!({
                                "kind": "runtime",
                                "out": out_path,
                                "mode": mode,
                                "version": entry.version,
                                "content_hash": summary["manifest"]["content_hash"].clone(),
                            }));
                        }

                        // Code generation
                        for entry in &cfg.code {
                            let resp = backend
                                .execute(DevcelOperation::ExportCode {
                                    target: entry.target.clone(),
                                    namespace: entry.namespace.clone(),
                                    version: entry.version,
                                    filters: entry.filters.clone(),
                                })
                                .await;
                            let data = unwrap_response(pretty, resp);
                            let code = data["code"].as_str().unwrap_or("");
                            let out_path = resolve_out(&entry.out);
                            ensure_parent_dir(pretty, &out_path);
                            devcel_core::json_export::write_export_file(&out_path, code)
                                .unwrap_or_else(|e| {
                                    bail(
                                        pretty,
                                        format!("Failed to write the file ({out_path}): {e}"),
                                    )
                                });
                            outputs.push(serde_json::json!({
                                "kind": "code",
                                "out": out_path,
                                "target": entry.target,
                                "version": entry.version,
                                "bytes": code.len(),
                            }));
                        }

                        backend.shutdown().await;
                        succeed(
                            pretty,
                            serde_json::json!({
                                "config": config_path,
                                "outputs": outputs,
                            }),
                        );
                    }
                },
                Command::Undo { table } => {
                    let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                    run_simple(pretty, backend, DevcelOperation::UndoCommand { table_uuid }).await;
                }
                Command::Redo { table } => {
                    let (table_uuid, _) = resolve_table_uuid(pretty, &backend, &table).await;
                    run_simple(pretty, backend, DevcelOperation::RedoCommand { table_uuid }).await;
                }
                Command::Op { json } => {
                    // Read from stdin for "-" to avoid shell quoting issues
                    let json = if json == "-" {
                        let mut buf = String::new();
                        use std::io::Read;
                        std::io::stdin()
                            .read_to_string(&mut buf)
                            .unwrap_or_else(|e| bail(pretty, format!("Could not read stdin: {e}")));
                        buf
                    } else {
                        json
                    };
                    let op: DevcelOperation = serde_json::from_str(&json).unwrap_or_else(|e| {
                        bail(pretty, format!("Could not parse the operation JSON: {e}"))
                    });
                    run_simple(pretty, backend, op).await;
                }
                // Handled by the match above
                Command::Init { .. }
                | Command::TagPresets
                | Command::Pull { .. }
                | Command::ImporterUi { .. }
                | Command::PullConfigSave { .. }
                | Command::WolfExport { .. }
                | Command::AppCatalog { .. }
                | Command::Localization { .. }
                | Command::Status
                | Command::Serve
                | Command::Watch { .. }
                | Command::ManagedServe => {
                    unreachable!()
                }
            }
        }
    }
}

#[cfg(test)]
mod interface_required_cli_tests {
    use super::*;
    use clap::{error::ErrorKind, CommandFactory};

    #[test]
    fn positional_required_boolean_and_help_are_valid() {
        Cli::command().debug_assert();
        for (raw, expected) in [("true", true), ("false", false)] {
            let cli = Cli::try_parse_from([
                "devcel",
                "interface",
                "column",
                "required",
                "common",
                "hp",
                raw,
            ])
            .unwrap();
            match cli.command {
                Command::Interface {
                    cmd:
                        InterfaceCmd::Column {
                            cmd:
                                InterfaceColumnCmd::Required {
                                    interface,
                                    name,
                                    required,
                                },
                        },
                } => {
                    assert_eq!(
                        (interface.as_str(), name.as_str(), required),
                        ("common", "hp", expected)
                    );
                }
                _ => panic!("unexpected command"),
            }
        }
        for raw in ["yes", "1", ""] {
            let error = Cli::try_parse_from([
                "devcel",
                "interface",
                "column",
                "required",
                "common",
                "hp",
                raw,
            ])
            .err()
            .expect("invalid boolean must fail");
            assert_eq!(error.kind(), ErrorKind::InvalidValue);
        }
        assert!(
            Cli::try_parse_from(["devcel", "interface", "column", "required", "common", "hp"])
                .is_err()
        );
        let help = Cli::try_parse_from(["devcel", "interface", "column", "required", "--help"])
            .err()
            .unwrap();
        assert_eq!(help.kind(), ErrorKind::DisplayHelp);
    }
}

#[cfg(test)]
mod record_inheritance_cli_tests {
    use super::*;

    #[test]
    fn parses_parent_change_detach_and_rejects_obsolete_modes() {
        for mode in ["inherit", "local", "default"] {
            let args =
                Cli::try_parse_from(["devcel", "cell", "mode", "table", "record", "column", mode]);
            assert!(args.is_err(), "obsolete mode {mode}");
        }
        assert!(Cli::try_parse_from([
            "devcel",
            "cell",
            "mode",
            "table",
            "record",
            "column",
            "automatic"
        ])
        .is_err());
        assert!(
            Cli::try_parse_from(["devcel", "record", "parent", "table", "child", "parent"]).is_ok()
        );
        assert!(Cli::try_parse_from(["devcel", "record", "detach", "table", "child"]).is_ok());
    }
}

#[cfg(test)]
mod tag_filter_cli_tests {
    use super::*;
    #[test]
    fn repeated_exact_tag_flags_and_saved_config() {
        let cli = Cli::try_parse_from([
            "devcel",
            "export",
            "code",
            "typescript",
            "--column-include-tag",
            "public",
            "--column-include-tag",
            "日本語 タグ",
            "--column-exclude-tag",
            "private",
            "--row-exclude-tag",
            "draft",
            "--version",
            "3",
        ])
        .unwrap();
        let Command::Export {
            cmd: ExportCmd::Code {
                filters, version, ..
            },
        } = cli.command
        else {
            panic!("wrong command")
        };
        assert_eq!(version, Some(3));
        assert_eq!(filters.column_include_tags, ["public", "日本語 タグ"]);
        assert_eq!(filters.row_exclude_tags, ["draft"]);
        let config: ExportConfig = toml::from_str(
            r#"
            [[runtime]]
            out = "data.json"
            row_include_tags = ["release"]
            column_exclude_tags = ["internal"]
            [[code]]
            out = "data.ts"
            target = "typescript"
            column_exclude_tags = ["internal"]
        "#,
        )
        .unwrap();
        assert_eq!(config.runtime[0].filters.row_include_tags, ["release"]);
        assert_eq!(config.code[0].filters.column_exclude_tags, ["internal"]);
        assert!(Cli::try_parse_from([
            "devcel",
            "tag-presets",
            "--project",
            "demo.devcelproj.toml",
            "--mode",
            "local"
        ])
        .is_ok());
    }
}
