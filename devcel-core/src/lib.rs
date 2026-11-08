pub mod authoring_format;
pub mod cell_rules;
pub mod change_detection;
pub mod codegen;
pub mod color;
pub mod color_swatches;
pub mod column;
pub mod column_editor;
pub mod commands;
pub mod curve;
pub mod duplicate;
pub mod edit_controls;
pub mod file_save_queue;
pub mod formula_context;
pub mod formula_diagnostics;
pub mod formula_engine;
#[doc(hidden)]
pub mod formula_memory;
pub mod importer_pull;
pub mod interface;
mod internal_artifacts;
pub mod json_export;
#[cfg(feature = "localization")]
pub mod localization;
pub mod msgpack_framing;
pub mod operation_handler;
pub mod operations;
mod ordered_map;
mod private_files;
pub mod project_impl;
mod project_paths;
pub mod project_tags;
pub mod record;
mod reference_integrity;
pub mod table;
mod table_catalog;
mod table_file_revision;
pub mod table_loading;
pub mod table_mutation;
mod table_storage;
pub mod tag_filter;
mod tag_transaction_journal;
pub mod types;
pub mod utils;
#[doc(hidden)]
pub mod write_locks;

#[cfg(feature = "p2p")]
pub mod discovery;
#[cfg(feature = "p2p")]
pub mod p2p_auth;
#[cfg(feature = "p2p")]
mod p2p_diagnostics;
#[cfg(feature = "p2p")]
pub mod p2p_errors;
#[cfg(feature = "p2p")]
pub mod p2p_manager;
#[cfg(feature = "p2p")]
pub mod p2p_messages;
#[cfg(feature = "p2p")]
pub mod port_manager;
#[cfg(feature = "p2p")]
pub use p2p_manager::ReconnectConfig;
#[cfg(feature = "p2p")]
pub mod conflict_resolution;
#[cfg(feature = "p2p")]
pub mod msgpack_client;
#[cfg(feature = "p2p")]
pub mod msgpack_server;
#[cfg(feature = "p2p")]
pub mod reconnection_manager;
#[cfg(feature = "p2p")]
pub mod registry;

pub use color::{Color32, ColorFloat};
pub use color_swatches::{
    apply_color_swatch, normalize_color_swatches, validate_color_swatches, ColorSwatch,
};
pub use column::{ColumnConstraints, ColumnSchema};
pub use commands::{
    AddColumnCommand, AddRecordCommand, AddRecordTagCommand, ApplyInterfaceCommand, CommandData,
    CommandExecutionResult, CreateInterfaceCommand, InsertColumnCommand, InsertRecordCommand,
    MergeInterfaceCommand, MoveColumnCommand, RemoveColumnCommand, RemoveRecordCommand,
    RemoveRecordTagCommand, RenameColumnCommand, RenameTableDataNameCommand,
    RenameTableDisplayNameCommand, RevertInterfaceCommand, SavePriority, SetColumnColorCommand,
    SetColumnDefaultValueCommand, SetColumnMemoTextCommand, SetColumnTooltipCommand,
    SetRecordLabelCommand, SetRecordMemoTextCommand, SetRecordMinVersionCommand,
    SetRecordParentUuidCommand, SetRecordValueCommand, TransactionCommand, UpdateInterfaceCommand,
};
pub use formula_diagnostics::{
    FormulaCellIdentity, FormulaDiagnostic, FormulaDiagnosticFrame, FormulaSourceLocation,
    FormulaSourceSpan,
};
pub use formula_engine::FormulaEngine;
pub use project_impl::Project;
pub use record::Record;
pub use table::{Table, TableData, TableEditPermissions, TableMetadata, TableSchema};
pub use types::*;
pub use utils::validate_data_name;

mod app_error;
pub use app_error::AppError;

use thiserror::Error;

#[derive(Error, Debug)]
pub enum DevcelError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("TOML error: {0}")]
    Toml(#[from] toml::de::Error),

    #[error("Input validation failed")]
    InputValidation(crate::cell_rules::ValidationReport),

    #[error("{}", display_diagnostics(.0))]
    Diagnostics(Vec<crate::types::Diagnostic>),

    #[error("Validation error: {0}")]
    Validation(String),

    #[error("Not found: {0}")]
    NotFound(String),

    #[error("Already exists: {0}")]
    AlreadyExists(String),

    #[error("Invalid operation: {0}")]
    InvalidOperation(String),

    #[error("Project error: {0}")]
    Project(String),

    #[error("Table error: {0}")]
    Table(String),

    #[error("Command error: {0}")]
    Command(String),
}

// CLI/log formatting keeps diagnostic identity and parameters. Native/frontend
// boundaries still serialize AppError::Diagnostics without using this text.
fn display_diagnostics(diagnostics: &[crate::types::Diagnostic]) -> String {
    diagnostics
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

pub type Result<T> = std::result::Result<T, DevcelError>;

// Operation and validation helpers return String errors; preserve their conversion.
impl From<String> for DevcelError {
    fn from(msg: String) -> Self {
        DevcelError::InvalidOperation(msg)
    }
}

// Editing C ABI exports.
#[cfg(feature = "ffi")]
pub mod ffi;
#[cfg(all(feature = "ffi", feature = "p2p"))]
pub mod ffi_p2p;
#[cfg(feature = "ffi")]
pub mod ffi_unified;

// Re-export for convenience
pub use json_export::{export_all_tables_as_json, export_table_as_json, ExportMode};

// Interface types
pub use interface::{
    ApplyResult, ConflictResolution, FieldConflict, Interface, InterfaceChange,
    InterfaceImplementation, InterfaceRegistry, InterfaceValidation, InterfaceVersion, MergeInfo,
    ResolutionType, EXTENDS_CONFLICT_KEY,
};

/// Authoritative, validated snapshots for local multi-editor replication.
pub mod replication;

pub mod plugin_data;

pub mod column_config;

pub mod export_validation;

#[cfg(feature = "localization")]
pub mod app_catalog;
#[cfg(feature = "localization")]
pub mod plugin_resource_registry;
#[cfg(feature = "localization")]
pub mod plugin_resources;
#[cfg(feature = "localization")]
pub mod theme_schema;

#[cfg(feature = "localization")]
pub mod app_settings_migration;
