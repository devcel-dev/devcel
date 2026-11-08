//! Code generation from definitions (codegen).
//!
//! Generates **type-safe access code** from a project's table and interface
//! schemas, consuming the `devcel-runtime` C ABI FFI or the engine-independent
//! JavaScript runtime. Targets C#, C++, and TypeScript.
//!
//! Generated code design:
//! - Each table has an `XxxTable` (lookup) and an `XxxRow` (typed accessors).
//! - Native column indices are resolved by column name at construction and cached;
//!   JavaScript uses the runtime indices with the same names
//!   (bundle column names match the output of [`crate::json_export::build_export_keys`]).
//! - Interfaces map to the target language's interface/abstract types, implemented
//!   by the row types of implementing tables.
//! - `Reference` columns return rows from the referenced table (O(1) UUID resolution using runtime indices).

mod cpp;
mod csharp;
mod csharp_managed;
mod typescript;

use crate::column::ColumnSchema;
use crate::tag_filter::TagFilter;
use crate::types::ValueType;
use crate::{Project, Result};

/// Target language for code generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodegenTarget {
    /// C#(Unity)
    CSharp,
    /// C++(Unreal)
    Cpp,
    /// TypeScript(Cocos Creator / JavaScript)
    TypeScript,
}

impl CodegenTarget {
    /// Resolve a target from a string.
    pub fn from_name(s: &str) -> Option<CodegenTarget> {
        match s.to_lowercase().as_str() {
            "csharp" | "cs" | "c#" | "unity" => Some(CodegenTarget::CSharp),
            "cpp" | "c++" | "cxx" | "unreal" => Some(CodegenTarget::Cpp),
            "typescript" | "ts" => Some(CodegenTarget::TypeScript),
            _ => None,
        }
    }

    /// Recommended extension for the generated file.
    pub fn file_extension(&self) -> &'static str {
        match self {
            CodegenTarget::CSharp => "cs",
            CodegenTarget::Cpp => "h",
            CodegenTarget::TypeScript => "ts",
        }
    }
}

/// Language-independent intermediate representation for code generation.
#[derive(Debug, Clone)]
pub struct CgModel {
    pub project_name: String,
    pub tables: Vec<CgTable>,
    pub interfaces: Vec<CgInterface>,
}

/// Table to generate.
#[derive(Debug, Clone)]
pub struct CgTable {
    /// C# explicit interface members matched by column UUID, not display/data name.
    pub csharp_interfaces: Vec<(String, Vec<(String, CgColumn)>)>,
    pub uuid: String,
    /// Authored nonempty row labels and stable IDs; no values/native handles retained.
    pub labeled_records: Vec<(String, String)>,
    /// Table data name (matches the bundle's table name).
    pub data_name: String,
    /// Base type name (PascalCase).
    pub type_base: String,
    /// Columns.
    pub columns: Vec<CgColumn>,
    /// Type names (PascalCase) of interfaces implemented by this table.
    pub implements: Vec<String>,
}

/// Column to generate.
#[derive(Debug, Clone)]
pub struct CgColumn {
    /// Column name in the bundle (key used to resolve its index).
    pub key: String,
    /// Accessor name (PascalCase, unique within the table).
    pub accessor: String,
    /// Value type.
    pub value_type: ValueType,
    /// Base type name (PascalCase) of the referenced table, or None if unresolved.
    pub reference_target: Option<String>,
    /// Required interface UUID for TableRef (preserving the existing string accessor).
    pub table_ref_interface: Option<String>,
    /// Explicit Select options.
    pub select_options: Option<Vec<String>>,
}

/// Interface to generate.
#[derive(Debug, Clone)]
pub struct CgInterface {
    pub uuid: String,
    pub type_name: String,
    pub members: Vec<CgInterfaceMember>,
}

/// Interface members (properties).
#[derive(Debug, Clone)]
pub struct CgInterfaceMember {
    pub accessor: String,
    pub value_type: ValueType,
    pub reference_target: Option<String>,
    /// Required interface UUID for TableRef (preserving the existing string accessor).
    pub table_ref_interface: Option<String>,
    /// Original data name for collision detection.
    pub data_name: String,
}

/// Generate code for the specified target from a project.
/// Use the language's default namespace if `namespace_name` is `None` or whitespace only
/// (C#/TypeScript: `Devcel.Generated`, C++: `devcel`).
pub fn generate_code(
    project: &mut Project,
    target: CodegenTarget,
    namespace_name: Option<&str>,
) -> Result<String> {
    generate_code_with_class_name(project, target, namespace_name, None)
}

/// Generate type-safe access code for columns included in the specified content version.
/// `None` includes all columns; `Some(n)` includes columns with `min_version <= n`.
pub fn generate_code_for_version(
    project: &mut Project,
    target: CodegenTarget,
    namespace_name: Option<&str>,
    target_version: Option<u32>,
) -> Result<String> {
    generate_code_with_class_name_for_version(project, target, namespace_name, None, target_version)
}

/// Generate one schema with a configurable database owner class.
/// Omitted class_name keeps the existing target-specific name.
pub fn generate_code_with_class_name(
    project: &mut Project,
    target: CodegenTarget,
    namespace_name: Option<&str>,
    class_name: Option<&str>,
) -> Result<String> {
    generate_code_with_class_name_for_version(project, target, namespace_name, class_name, None)
}

/// Generate code for the same content version as the importer's runtime output.
/// Limit projection to a schema snapshot; do not modify loaded tables or formula input columns.
pub fn generate_code_with_class_name_for_version(
    project: &mut Project,
    target: CodegenTarget,
    namespace_name: Option<&str>,
    class_name: Option<&str>,
    target_version: Option<u32>,
) -> Result<String> {
    generate_code_with_class_name_for_filters(
        project,
        target,
        namespace_name,
        class_name,
        target_version,
        &TagFilter::default(),
    )
}

/// Generate accessors for the output projection without altering source schemas.
pub fn generate_code_with_class_name_for_filters(
    project: &mut Project,
    target: CodegenTarget,
    namespace_name: Option<&str>,
    class_name: Option<&str>,
    target_version: Option<u32>,
    filters: &TagFilter,
) -> Result<String> {
    let model = build_model_for_filters(project, target_version, filters)?;
    // Fall back to the default for empty/whitespace namespaces to avoid emitting broken `namespace {` code
    let ns = namespace_name.map(str::trim).filter(|s| !s.is_empty());
    if let Some(ns) = ns {
        validate_namespace(ns)?;
        if target == CodegenTarget::Cpp
            && matches!(
                ns.split(['.', ':']).next(),
                Some("DevcelColor32" | "DevcelColorFloat")
            )
        {
            return Err(crate::app_error::diagnostic(
                "error.codegen.cppNamespace",
                serde_json::json!({}),
            ));
        }
    }
    validate_model(&model)?;
    let class_name = class_name.unwrap_or(default_class_name(target));
    validate_root_class(&model, target, ns, class_name)?;
    if target == CodegenTarget::Cpp {
        cpp::validate_names(&model, class_name)?;
    }
    if target == CodegenTarget::TypeScript {
        typescript::validate_names(
            &model,
            ns.unwrap_or(typescript::DEFAULT_NAMESPACE),
            class_name,
        )?;
    }
    Ok(match target {
        CodegenTarget::CSharp => {
            csharp::validate_reference_names(&model)?;
            let namespace = ns.unwrap_or(csharp::DEFAULT_NAMESPACE).replace("::", ".");
            if class_name == default_class_name(target) {
                csharp::generate(&model, &namespace)
            } else {
                csharp::generate_with_class_name(&model, &namespace, class_name)
            }
        }
        CodegenTarget::Cpp => {
            let namespace = ns.unwrap_or(cpp::DEFAULT_NAMESPACE);
            if class_name == default_class_name(target) {
                cpp::generate(&model, namespace)
            } else {
                cpp::generate_with_class_name(&model, namespace, class_name)
            }
        }
        CodegenTarget::TypeScript => typescript::generate_with_class_name(
            &model,
            &ns.unwrap_or(typescript::DEFAULT_NAMESPACE)
                .replace("::", "."),
            class_name,
        ),
    })
}

/// Existing root names remain the defaults for code generation.
pub fn default_class_name(target: CodegenTarget) -> &'static str {
    match target {
        CodegenTarget::CSharp => "DevcelDatabase",
        CodegenTarget::Cpp => "Database",
        CodegenTarget::TypeScript => "DevcelDatabase",
    }
}

/// A single portable identifier, never a qualified name or source fragment.
/// TypeScript-specific keywords are additionally checked during generation.
pub fn validate_class_name(name: &str) -> Result<()> {
    if !valid_namespace_part(name)
        || [
            "var",
            "dynamic",
            "record",
            "nint",
            "nuint",
            "notnull",
            "unmanaged",
            "scoped",
            "file",
            "required",
        ]
        .contains(&name)
    {
        return Err(crate::app_error::diagnostic(
            "error.codegen.classIdentifier",
            serde_json::json!({}),
        ));
    }
    Ok(())
}

fn validate_root_class(
    model: &CgModel,
    target: CodegenTarget,
    namespace: Option<&str>,
    name: &str,
) -> Result<()> {
    validate_class_name(name)?;
    // Fixed generated helpers and external types/namespaces used by their templates.
    let reserved = [
        "DevcelNative",
        "NativeState",
        "DevcelTableReference",
        "TableReference",
        "DevcelColor32",
        "DevcelColorFloat",
        "DEVCEL_RUNTIME_COLOR_TYPES",
        "DevcelDateTimeOffset",
        "DevcelScalarParsers",
        "System",
        "IntPtr",
        "IDisposable",
        "List",
        "WeakReference",
        "IEnumerable",
        "Path",
        "Exception",
        "ArgumentException",
        "AggregateException",
        "ObjectDisposedException",
        "InvalidOperationException",
        "ArgumentOutOfRangeException",
        "StringComparison",
        "DateTimeOffset",
        "DateTime",
        "TimeSpan",
        "GC",
        "DllImportAttribute",
        "StructLayoutAttribute",
        "StructLayout",
        "CallingConvention",
        "EntryPointNotFoundException",
        "LayoutKind",
        "MarshalAsAttribute",
        "ReferenceEquals",
        "kr_str",
        "kr_verify_api",
        "kr_color32",
        "kr_color_float",
        "UINT64_MAX",
        "NULL",
        "EOF",
        "NAN",
        "INFINITY",
        "errno",
        "WEOF",
        "EXIT_SUCCESS",
        "EXIT_FAILURE",
        "MB_CUR_MAX",
        "MB_LEN_MAX",
        "SEEK_SET",
        "SEEK_CUR",
        "SEEK_END",
        "BUFSIZ",
        "FILENAME_MAX",
        "FOPEN_MAX",
        "L_tmpnam",
        "TMP_MAX",
        "stdin",
        "stdout",
        "stderr",
        "CLOCKS_PER_SEC",
        "TIME_UTC",
        "CHAR_BIT",
        "CHAR_MIN",
        "CHAR_MAX",
        "SCHAR_MIN",
        "SCHAR_MAX",
        "UCHAR_MAX",
        "SHRT_MIN",
        "SHRT_MAX",
        "USHRT_MAX",
        "INT_MIN",
        "INT_MAX",
        "UINT_MAX",
        "LONG_MIN",
        "LONG_MAX",
        "ULONG_MAX",
        "LLONG_MIN",
        "LLONG_MAX",
        "ULLONG_MAX",
        "LC_ALL",
        "LC_COLLATE",
        "LC_CTYPE",
        "LC_MONETARY",
        "LC_NUMERIC",
        "LC_TIME",
        "EDOM",
        "ERANGE",
        "EILSEQ",
        "EIO",
        "EINVAL",
        "EACCES",
        "EAGAIN",
        "ENOMEM",
        "ENOENT",
        "EPERM",
        "DllImport",
        "MarshalAs",
        "UnmanagedType",
        "Marshal",
        "std",
        "size_t",
        "uint8_t",
        "uint16_t",
        "uint32_t",
        "uint64_t",
        "int8_t",
        "int16_t",
        "int32_t",
        "int64_t",
    ];
    let root_members: &[&str] = match target {
        CodegenTarget::CSharp => &[
            "Handle",
            "Generation",
            "Open",
            "FromJson",
            "ReloadIfChanged",
            "ReloadOpenDatabases",
            "ReloadCore",
            "RegistryLock",
            "OpenDatabases",
            "Dispose",
            "CheckedHandle",
            "ReadGate",
            "ReadScope",
            "EnterRead",
            "EnsureOwnerThread",
            "DisposeCore",
            "_ownerThread",
            "RefreshTables",
            "TryReplaceDatabase",
            "Get",
            "TryGet",
            "TableViews",
            "ShareString",
            "GetTableView",
            "CheckReadModel",
            "PublishReadModel",
            "DisposeReadModel",
            "_publicationStrings",
            "_readFailure",
            "_path",
        ],
        CodegenTarget::Cpp => &[
            "state_",
            "open",
            "from_json",
            "reload_if_changed",
            "close",
            "handle",
        ],
        CodegenTarget::TypeScript => &["FromJson", "FromRuntime", "LoadJson", "Runtime"],
    };
    let qualified = format!(
        "{}.{}",
        namespace
            .unwrap_or(match target {
                CodegenTarget::CSharp => csharp::DEFAULT_NAMESPACE,
                CodegenTarget::Cpp => cpp::DEFAULT_NAMESPACE,
                CodegenTarget::TypeScript => typescript::DEFAULT_NAMESPACE,
            })
            .replace("::", "."),
        name
    );
    let namespace_collision = target == CodegenTarget::CSharp
        && [
            "System.Text",
            "System.Text.Encoding",
            "System.Collections",
            "System.Collections.Generic",
            "System.IO",
            "System.Runtime",
            "System.Runtime.InteropServices",
        ]
        .contains(&qualified.as_str());
    // Standard-library headers pull in platform errno macros. Keep these names
    // out of generated type declarations without rejecting ordinary uppercase names.
    const ERRNO_MACROS: &str = concat!(
        "E2BIG EACCES EADDRINUSE EADDRNOTAVAIL EADV EAFNOSUPPORT EAGAIN EALREADY EAUTH EBADARCH EBADE EBADEXEC ",
        "EBADF EBADFD EBADMACHO EBADMSG EBADR EBADRQC EBADSLT EBFONT EBUSY ECANCELED ECHILD ECHRNG ",
        "ECOMM ECONNABORTED ECONNREFUSED ECONNRESET EDEADLK EDEADLOCK EDESTADDRREQ EDEVERR EDOM EDOTDOT EDQUOT EEXIST ",
        "EFAULT EFBIG EFTYPE EHOSTDOWN EHOSTUNREACH EHWPOISON EIDRM EILSEQ EINPROGRESS EINTR EINVAL EIO ",
        "EISCONN EISDIR EISNAM EKEYEXPIRED EKEYREJECTED EKEYREVOKED EL2HLT EL2NSYNC EL3HLT EL3RST ELIBACC ELIBBAD ",
        "ELIBEXEC ELIBMAX ELIBSCN ELNRNG ELOOP EMEDIUMTYPE EMFILE EMLINK EMSGSIZE EMULTIHOP ENAMETOOLONG ENAVAIL ",
        "ENEEDAUTH ENETDOWN ENETRESET ENETUNREACH ENFILE ENOANO ENOATTR ENOBUFS ENOCSI ENODATA ENODEV ENOENT ",
        "ENOEXEC ENOKEY ENOLCK ENOLINK ENOMEDIUM ENOMEM ENOMSG ENONET ENOPKG ENOPOLICY ENOPROTOOPT ENOSPC ",
        "ENOSR ENOSTR ENOSYS ENOTBLK ENOTCONN ENOTDIR ENOTEMPTY ENOTNAM ENOTRECOVERABLE ENOTSOCK ENOTSUP ENOTTY ",
        "ENOTUNIQ ENXIO EOPNOTSUPP EOVERFLOW EOWNERDEAD EPERM EPFNOSUPPORT EPIPE EPROTO EPROTONOSUPPORT EPROTOTYPE EPWROFF ",
        "EQFULL ERANGE EREMCHG EREMOTE EREMOTEIO ERESTART ERFKILL EROFS ESHLIBVERS ESHUTDOWN ESOCKTNOSUPPORT ESPIPE ",
        "ESRCH ESRMNT ESTALE ESTRPIPE ETIME ETIMEDOUT ETOOMANYREFS ETXTBSY EUCLEAN EUNATCH EUSERS EWOULDBLOCK ",
        "EXDEV EXFULL ",
    );
    let errno_macro = ERRNO_MACROS.split_whitespace().any(|item| item == name);
    let numeric_macro = [
        "INT",
        "UINT",
        "INT_LEAST",
        "UINT_LEAST",
        "INT_FAST",
        "UINT_FAST",
    ]
    .iter()
    .any(|prefix| {
        [8, 16, 32, 64].iter().any(|bits| {
            ["MIN", "MAX", "C", "WIDTH"]
                .iter()
                .any(|suffix| name == format!("{prefix}{bits}_{suffix}"))
        })
    }) || [
        "INTPTR_MIN",
        "INTPTR_MAX",
        "UINTPTR_MAX",
        "INTMAX_MIN",
        "INTMAX_MAX",
        "UINTMAX_MAX",
        "INTMAX_C",
        "UINTMAX_C",
        "PTRDIFF_MIN",
        "PTRDIFF_MAX",
        "SIZE_MAX",
        "SIG_ATOMIC_MIN",
        "SIG_ATOMIC_MAX",
        "WINT_MIN",
        "WINT_MAX",
        "WCHAR_MIN",
        "WCHAR_MAX",
        "INTPTR_WIDTH",
        "UINTPTR_WIDTH",
        "INTMAX_WIDTH",
        "UINTMAX_WIDTH",
        "PTRDIFF_WIDTH",
        "SIZE_WIDTH",
        "SIG_ATOMIC_WIDTH",
        "WINT_WIDTH",
        "WCHAR_WIDTH",
        "BOOL_WIDTH",
        "BOOL_MAX",
        "CHAR_WIDTH",
        "SCHAR_WIDTH",
        "UCHAR_WIDTH",
        "SHRT_WIDTH",
        "USHRT_WIDTH",
        "INT_WIDTH",
        "UINT_WIDTH",
        "LONG_WIDTH",
        "ULONG_WIDTH",
        "LLONG_WIDTH",
        "ULLONG_WIDTH",
        "RAND_MAX",
        "ATOMIC_BOOL_LOCK_FREE",
        "ATOMIC_CHAR_LOCK_FREE",
        "ATOMIC_CHAR8_T_LOCK_FREE",
        "ATOMIC_CHAR16_T_LOCK_FREE",
        "ATOMIC_CHAR32_T_LOCK_FREE",
        "ATOMIC_WCHAR_T_LOCK_FREE",
        "ATOMIC_SHORT_LOCK_FREE",
        "ATOMIC_INT_LOCK_FREE",
        "ATOMIC_LONG_LOCK_FREE",
        "ATOMIC_LLONG_LOCK_FREE",
        "ATOMIC_POINTER_LOCK_FREE",
        "ATOMIC_VAR_INIT",
        "ATOMIC_FLAG_INIT",
        "offsetof",
    ]
    .contains(&name);
    let csharp_framework_collision = target == CodegenTarget::CSharp
        && [
            "Array",
            "StringComparer",
            "Dictionary",
            "HashSet",
            "IEnumerator",
            "DevcelTableHandle",
        ]
        .contains(&name);
    let collision = csharp_framework_collision
        || numeric_macro
        || errno_macro
        || namespace_collision
        || name.starts_with("devcel_rt_")
        || reserved.contains(&name)
        || root_members.contains(&name)
        || model.interfaces.iter().any(|item| {
            format!("I{}", item.type_name) == name
                || (target == CodegenTarget::CSharp
                    && [
                        format!("I{}Reference", item.type_name),
                        format!("I{}Key", item.type_name),
                        format!("I{}Handle", item.type_name),
                        format!("I{}LiveHandle", item.type_name),
                    ]
                    .contains(&name.to_owned()))
        })
        || model.tables.iter().any(|table| {
            format!("{}Table", table.type_base) == name
                || format!("{}Row", table.type_base) == name
                || (target == CodegenTarget::CSharp
                    && (format!("{}Key", table.type_base) == name
                        || format!("{}Reference", table.type_base) == name
                        || format!("{}References", table.type_base) == name
                        || format!("{}Handle", table.type_base) == name
                        || format!("{}Collection", table.type_base) == name))
                || (match target {
                    CodegenTarget::CSharp => table.type_base.clone(),
                    CodegenTarget::Cpp => cpp::member_name(table),
                    CodegenTarget::TypeScript => table.type_base.clone(),
                }) == name
                || table.columns.iter().any(|column| {
                    column.select_options.is_some() && select_enum_name(table, column) == name
                })
        });
    if collision {
        return Err(crate::app_error::diagnostic(
            "error.codegen.nameConflict",
            serde_json::json!({"name": name, "scope": "class_name"}),
        ));
    }
    Ok(())
}

/// Validate explicit namespaces using shared rules for all targets. Empty names are not allowed.
/// TypeScript-specific reserved words are additionally checked during generation.
/// Keep this separate from `generate_code` defaults so GUI settings use the same rules.
pub fn validate_namespace(namespace: &str) -> Result<()> {
    let namespace = namespace.trim();
    if namespace.is_empty()
        || !namespace
            .replace("::", ".")
            .split('.')
            .all(valid_namespace_part)
    {
        return Err(crate::app_error::diagnostic(
            "error.codegen.namespaceIdentifier",
            serde_json::json!({}),
        ));
    }
    Ok(())
}

/// Build a code generation intermediate representation from a project.
/// Validate unloaded tables' storage contracts one table at a time, retaining only schemas.
/// Prefer unsaved edits in loaded tables; do not modify editing state or the set of loaded tables.
pub fn build_model(project: &mut Project) -> Result<CgModel> {
    build_model_for_version(project, None)
}

/// Resolve stable names from all schemas, then project columns and interface members by content version.
/// Keep tables with no columns so row types referenced by public columns remain available.
pub fn build_model_for_version(
    project: &mut Project,
    target_version: Option<u32>,
) -> Result<CgModel> {
    build_model_for_filters(project, target_version, &TagFilter::default())
}

/// Build stable full-schema names before applying tag and version projection.
/// Interface definitions remain canonical for the selected content version.
pub fn build_model_for_filters(
    project: &mut Project,
    target_version: Option<u32>,
    filters: &TagFilter,
) -> Result<CgModel> {
    // Collect all table schemas first so references to later tables can be resolved.
    // Retain only nonempty label/UUID pairs, not record values or runtime handles.
    struct TableSchemaSnapshot {
        uuid: String,
        display_name: String,
        data_name: String,
        columns: Vec<ColumnSchema>,
        interface_ids: Vec<String>,
        labeled_records: Vec<(String, String)>,
    }

    let mut paths = std::collections::BTreeSet::new();
    for entry in project.get_project_entries()? {
        if entry.entry_type == crate::ProjectEntryType::Table {
            paths.insert(project.resolve_table_path(&std::path::PathBuf::from(entry.path))?);
        }
    }
    paths.extend(project.tables_data.keys().cloned());
    let mut schemas = Vec::with_capacity(paths.len());
    for path in paths {
        let unloaded;
        let data = if let Some(live) = project.tables_data.get(&path) {
            &live.data
        } else {
            unloaded = crate::json_export::read_unloaded_export_table(project, &path)?;
            &unloaded.data
        };
        schemas.push(TableSchemaSnapshot {
            labeled_records: data
                .records
                .iter()
                .filter(|r| !r.label.is_empty() && filters.includes_row(r, target_version))
                .map(|r| (r.uuid.clone(), r.label.clone()))
                .collect(),
            uuid: data.uuid.clone(),
            display_name: data.display_name.clone(),
            data_name: data.metadata.data_name.clone(),
            columns: data.schema.columns.clone(),
            interface_ids: if filters.is_empty() {
                data.interface_implementations
                    .keys()
                    .map(ToString::to_string)
                    .collect()
            } else {
                crate::tag_filter::projected_interface_ids(project, data, target_version, filters)?
            },
        });
    }

    // Build the UUID -> data_name map first to resolve referenced table names.
    let uuid_to_name: std::collections::HashMap<String, String> = schemas
        .iter()
        .map(|table| (table.uuid.clone(), table.data_name.clone()))
        .collect();

    // Map interface UUIDs to type names (PascalCase).
    let iface_uuid_to_type: std::collections::HashMap<String, String> = project
        .interface_registry
        .get_all_interfaces()
        .iter()
        .map(|iface| (iface.uuid.to_string(), to_pascal_case(&iface.name)))
        .collect();

    // Sort tables by data_name for deterministic output.
    schemas.sort_by(|a, b| (&a.data_name, &a.uuid).cmp(&(&b.data_name, &b.uuid)));
    let mut tables = Vec::with_capacity(schemas.len());
    for schema in schemas {
        let data_name = schema.data_name;
        if data_name.is_empty() {
            return Err(crate::app_error::diagnostic(
                "error.codegen.tableDataName",
                serde_json::json!({"table": schema.display_name, "tableId": schema.uuid}),
            ));
        }

        let keys = crate::json_export::build_export_keys(&schema.columns);
        // Determine export keys and accessor names using all columns. Filtering columns first
        // changes disambiguation and numbering, causing mismatches with the runtime or other content versions.
        let columns: Vec<_> = build_columns(&schema.columns, &keys, &uuid_to_name)
            .into_iter()
            .zip(&schema.columns)
            .filter(|(_, column)| filters.includes_column(column, target_version))
            .map(|(column, _)| column)
            .collect();

        // Implement an interface only when every member is satisfied by a type-matching column
        // with a collision-free accessor still derived from data_name.
        let implements = compute_implements(
            crate::json_export::expanded_interface_ids(project, schema.interface_ids.clone())?,
            &columns,
            &iface_uuid_to_type,
            &uuid_to_name,
            project,
            target_version,
        );

        let mut csharp_interfaces = Vec::new();
        for origin in
            crate::json_export::expanded_interface_ids(project, schema.interface_ids.clone())?
        {
            let Ok(uuid) = origin.parse::<uuid::Uuid>() else {
                continue;
            };
            let Some(iface) = project.interface_registry.get_interface(&uuid) else {
                continue;
            };
            let effective = iface.get_effective_columns(&project.interface_registry)?;
            let mut bindings = Vec::new();
            let mut valid = true;
            for member in effective
                .iter()
                .filter(|c| target_version.is_none_or(|v| c.min_version <= v))
            {
                let Some(position) = schema.columns.iter().position(|c| c.uuid == member.uuid)
                else {
                    valid = false;
                    break;
                };
                let key = &keys[position];
                let Some(column) = columns.iter().find(|c| &c.key == key) else {
                    valid = false;
                    break;
                };
                if column.value_type != member.data_type
                    || column.reference_target != reference_target_name(member, &uuid_to_name)
                    || (member.data_type == ValueType::TableRef
                        && column.table_ref_interface
                            != member
                                .table_ref_config
                                .as_ref()
                                .map(|c| c.interface_uuid.clone()))
                {
                    valid = false;
                    break;
                }
                bindings.push((to_pascal_case(&member.data_name), column.clone()));
            }
            if valid {
                csharp_interfaces.push((to_pascal_case(&iface.name), bindings));
            }
        }
        csharp_interfaces.sort_by(|a, b| a.0.cmp(&b.0));
        csharp_interfaces.dedup_by(|a, b| a.0 == b.0);
        tables.push(CgTable {
            csharp_interfaces,
            uuid: schema.uuid,
            labeled_records: schema.labeled_records,
            type_base: to_pascal_case(&data_name),
            data_name,
            columns,
            implements,
        });
    }

    // Interface definitions (sorted by type name).
    let mut interfaces = Vec::new();
    let mut ifaces: Vec<_> = project.interface_registry.get_all_interfaces();
    ifaces.sort_by(|a, b| a.name.cmp(&b.name));
    for iface in ifaces {
        let effective = iface.get_effective_columns(&project.interface_registry)?;
        let members = effective
            .iter()
            .filter(|column| target_version.is_none_or(|v| column.min_version <= v))
            .map(|col| CgInterfaceMember {
                accessor: to_pascal_case(&col.data_name),
                value_type: col.data_type.clone(),
                reference_target: reference_target_name(col, &uuid_to_name),
                table_ref_interface: col
                    .table_ref_config
                    .as_ref()
                    .map(|c| c.interface_uuid.clone()),
                data_name: col.data_name.clone(),
            })
            .collect();
        interfaces.push(CgInterface {
            uuid: iface.uuid.to_string(),
            type_name: to_pascal_case(&iface.name),
            members,
        });
    }

    Ok(CgModel {
        project_name: project.get_project_name(),
        tables,
        interfaces,
    })
}

/// Convert columns to an intermediate representation, deriving accessor names from data_name.
/// Fall back to bundle keys only for collisions within a table, ensuring unique names.
fn build_columns(
    schema_cols: &[ColumnSchema],
    keys: &[String],
    uuid_to_name: &std::collections::HashMap<String, String>,
) -> Vec<CgColumn> {
    // Tentatively derive accessor names from data_name and detect collisions.
    let mut name_counts: std::collections::HashMap<String, usize> =
        std::collections::HashMap::new();
    for col in schema_cols {
        *name_counts
            .entry(to_pascal_case(&col.data_name))
            .or_insert(0) += 1;
    }

    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut columns = Vec::with_capacity(schema_cols.len());

    for (col, key) in schema_cols.iter().zip(keys.iter()) {
        let base = to_pascal_case(&col.data_name);
        let mut accessor = if name_counts.get(&base).copied().unwrap_or(0) > 1 {
            // Collision: disambiguate using the bundle key
            to_pascal_case(key)
        } else {
            base
        };
        let root = accessor.clone();
        let mut suffix = 2;
        while used.contains_key(&accessor) {
            accessor = format!("{root}{suffix}");
            suffix += 1;
        }
        used.insert(accessor.clone(), 1);

        columns.push(CgColumn {
            key: key.clone(),
            accessor,
            value_type: col.data_type.clone(),
            reference_target: reference_target_name(col, uuid_to_name),
            table_ref_interface: col
                .table_ref_config
                .as_ref()
                .map(|c| c.interface_uuid.clone()),
            select_options: if col.data_type == ValueType::Select {
                col.select_config
                    .as_ref()
                    .map(|c| c.options.iter().map(|o| o.value.clone()).collect())
            } else {
                None
            },
        });
    }

    columns
}

/// Resolve the referenced table's type name (PascalCase) for a Reference column.
fn reference_target_name(
    col: &ColumnSchema,
    uuid_to_name: &std::collections::HashMap<String, String>,
) -> Option<String> {
    if col.data_type != ValueType::Reference {
        return None;
    }
    let cfg = col.reference_config.as_ref()?;
    uuid_to_name
        .get(&cfg.target_table_uuid)
        .filter(|n| !n.is_empty())
        .map(|n| to_pascal_case(n))
}

/// Determine the interface type names implemented by a table.
fn compute_implements(
    mut origin_uuids: Vec<String>,
    columns: &[CgColumn],
    iface_uuid_to_type: &std::collections::HashMap<String, String>,
    uuid_to_name: &std::collections::HashMap<String, String>,
    project: &Project,
    target_version: Option<u32>,
) -> Vec<String> {
    origin_uuids.sort();
    origin_uuids.dedup();

    // Table accessor-name-to-type set (only collision-free names derived from data_name are reliable).
    let table_accessor_types: std::collections::HashMap<&str, &CgColumn> =
        columns.iter().map(|c| (c.accessor.as_str(), c)).collect();

    let mut implements = Vec::new();
    for origin in origin_uuids {
        let Ok(uuid) = origin.parse::<uuid::Uuid>() else {
            continue;
        };
        let Some(iface) = project.interface_registry.get_interface(&uuid) else {
            continue;
        };
        // Implement an interface only when every column exists in the table with
        // a collision-free accessor name and a matching type.
        let Ok(effective) = iface.get_effective_columns(&project.interface_registry) else {
            continue;
        };
        let all_match = effective
            .iter()
            .filter(|column| target_version.is_none_or(|v| column.min_version <= v))
            .all(|ic| {
                let acc = to_pascal_case(&ic.data_name);
                table_accessor_types
                    .get(acc.as_str())
                    .map(|col| {
                        col.value_type == ic.data_type
                            && col.reference_target == reference_target_name(ic, uuid_to_name)
                            && (ic.data_type != ValueType::TableRef
                                || col.table_ref_interface
                                    == ic
                                        .table_ref_config
                                        .as_ref()
                                        .map(|c| c.interface_uuid.clone()))
                    })
                    .unwrap_or(false)
            });
        if all_match {
            if let Some(type_name) = iface_uuid_to_type.get(&origin) {
                implements.push(type_name.clone());
            }
        }
    }

    implements.sort();
    implements.dedup();
    implements
}

/// Convert an identifier to PascalCase by splitting on `_`, `-`, or spaces and capitalizing each word.
/// Prefix a leading digit with `_` to form a valid identifier.
pub(crate) fn to_pascal_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut capitalize = true;
    for ch in s.chars() {
        if ch == '_' || ch == '-' || ch == ' ' {
            capitalize = true;
        } else if !ch.is_ascii_alphanumeric() {
            out.push_str(&format!("U{:X}", ch as u32));
            capitalize = false;
        } else if capitalize {
            out.extend(ch.to_uppercase());
            capitalize = false;
        } else {
            out.push(ch);
        }
    }
    if out.is_empty() {
        return "_".to_string();
    }
    if out
        .chars()
        .next()
        .map(|c| c.is_ascii_digit())
        .unwrap_or(false)
    {
        out.insert(0, '_');
    }
    out
}

fn valid_namespace_part(s: &str) -> bool {
    // C# reserved keywords + C++20 keywords. Contextual C# keywords remain valid.
    const KEYWORDS: &str = "abstract alignas alignof and and_eq as asm auto base bitand bitor bool break byte case catch char char8_t char16_t char32_t checked class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decimal decltype default delegate delete do double dynamic_cast else enum event explicit export extern false finally fixed float for foreach friend goto if implicit in inline int interface internal is lock long mutable namespace new noexcept not not_eq null nullptr object operator or or_eq out override params private protected public readonly ref register reinterpret_cast requires return sbyte sealed short signed sizeof stackalloc static static_assert static_cast string struct switch template this thread_local throw true try typedef typeid typename typeof uint ulong unchecked union unsafe unsigned ushort using virtual void volatile wchar_t while xor xor_eq";
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !s.contains("__")
        && !(s.starts_with('_') && s.as_bytes().get(1).is_some_and(u8::is_ascii_uppercase))
        && !KEYWORDS.split_whitespace().any(|word| word == s)
}

fn validate_model(model: &CgModel) -> Result<()> {
    use std::collections::HashSet;
    let mut names: HashSet<String> = [
        "Database",
        "DevcelDatabase",
        "DevcelNative",
        "NativeState",
        "DevcelTableReference",
        "TableReference",
        "DevcelColor32",
        "DevcelColorFloat",
        "DEVCEL_RUNTIME_COLOR_TYPES",
        "DevcelDateTimeOffset",
        "DevcelScalarParsers",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();
    for iface in &model.interfaces {
        if !names.insert(format!("I{}", iface.type_name)) {
            return Err(crate::app_error::diagnostic(
                "error.codegen.nameConflict",
                serde_json::json!({"name": format!("I{}", iface.type_name), "scope": model.project_name}),
            ));
        }
        let mut members: HashSet<String> =
            iface.members.iter().map(|m| m.accessor.clone()).collect();
        let mut raw_members = HashSet::new();
        for m in &iface.members {
            if m.value_type == ValueType::TableRef
                && !members.insert(format!("{}Table", m.accessor))
            {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": format!("{}Table", m.accessor), "scope": iface.type_name}),
                ));
            }
            {
                let (kind, suffix) = (ValueType::DateTime, "Rfc3339");
                if m.value_type == kind && !members.insert(format!("{}{suffix}", m.accessor)) {
                    return Err(crate::app_error::diagnostic(
                        "error.codegen.nameConflict",
                        serde_json::json!({"name": format!("{}{suffix}", m.accessor), "scope": iface.type_name}),
                    ));
                }
            }
            if m.value_type == ValueType::Curve && !members.insert(format!("Sample{}", m.accessor))
            {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": format!("Sample{}", m.accessor), "scope": iface.type_name}),
                ));
            }
            if members.contains(&format!("I{}", iface.type_name))
                || !raw_members.insert(&m.accessor)
            {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": m.accessor, "scope": iface.type_name}),
                ));
            }
        }
    }
    for t in &model.tables {
        for generated in [
            format!("{}Table", t.type_base),
            format!("{}Row", t.type_base),
        ] {
            if !names.insert(generated.clone()) {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": generated, "scope": model.project_name}),
                ));
            }
        }
        if [
            "Handle",
            "Generation",
            "Open",
            "FromJson",
            "ReloadIfChanged",
            "ReloadOpenDatabases",
            "ReloadCore",
            "RegistryLock",
            "OpenDatabases",
            "Dispose",
            "CheckedHandle",
            "ReadGate",
            "ReadScope",
            "EnterRead",
            "EnsureOwnerThread",
            "DisposeCore",
            "_ownerThread",
            "RefreshTables",
            "TryReplaceDatabase",
            "Get",
            "TryGet",
            "DevcelDatabase",
            "State",
            "Close",
        ]
        .contains(&t.type_base.as_str())
        {
            return Err(crate::app_error::diagnostic(
                "error.codegen.nameConflict",
                serde_json::json!({"name": t.data_name, "scope": model.project_name}),
            ));
        }
        let mut members: HashSet<String> = t.columns.iter().map(|c| c.accessor.clone()).collect();
        for c in &t.columns {
            if let Some(options) = &c.select_options {
                let enum_name = select_enum_name(t, c);
                if !names.insert(enum_name.clone())
                    || !members.insert(format!("{}Value", c.accessor))
                {
                    return Err(crate::app_error::diagnostic(
                        "error.codegen.nameConflict",
                        serde_json::json!({"name": enum_name, "scope": t.data_name, "column": c.key, "accessor": c.accessor}),
                    ));
                }
                let mut values = HashSet::new();
                if options.iter().any(|v| v.is_empty() || !values.insert(v)) {
                    return Err(crate::app_error::diagnostic(
                        "error.codegen.selectValues",
                        serde_json::json!({"table": t.data_name, "column": c.key}),
                    ));
                }
            }
            if c.value_type == ValueType::TableRef
                && !members.insert(format!("{}Table", c.accessor))
            {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": format!("{}Table", c.accessor), "scope": t.data_name, "column": c.key, "accessor": c.accessor}),
                ));
            }
            {
                let (kind, suffix) = (ValueType::DateTime, "Rfc3339");
                if c.value_type == kind && !members.insert(format!("{}{suffix}", c.accessor)) {
                    return Err(crate::app_error::diagnostic(
                        "error.codegen.nameConflict",
                        serde_json::json!({"name": format!("{}{suffix}", c.accessor), "scope": t.data_name, "column": c.key, "accessor": c.accessor}),
                    ));
                }
            }
            if c.value_type == ValueType::Curve && !members.insert(format!("Sample{}", c.accessor))
            {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": format!("Sample{}", c.accessor), "scope": t.data_name, "column": c.key, "accessor": c.accessor}),
                ));
            }
            if c.accessor == "RowIndex" || c.accessor == format!("{}Row", t.type_base) {
                return Err(crate::app_error::diagnostic(
                    "error.codegen.nameConflict",
                    serde_json::json!({"name": c.key, "scope": t.data_name, "column": c.key, "accessor": c.accessor}),
                ));
            }
        }
    }
    Ok(())
}

/// Per-table/column enums. Generate as additional types to preserve raw string accessors.
pub(crate) fn select_enum_name(table: &CgTable, col: &CgColumn) -> String {
    format!("{}{}Value", table.type_base, col.accessor)
}

/// Derive identifiers from values so label edits preserve source compatibility; resolve collisions with ordered suffixes.
pub(crate) fn select_enum_members(enum_name: &str, values: &[String]) -> Vec<String> {
    let mut used = std::collections::HashSet::from([
        enum_name.to_string(),
        "value__".into(),
        "NULL".into(),
        "EOF".into(),
        "NAN".into(),
        "INFINITY".into(),
    ]);
    values
        .iter()
        .map(|value| {
            let base = to_pascal_case(value);
            let mut member = base.clone();
            let mut suffix = 2;
            while !used.insert(member.clone()) {
                member = format!("{base}{suffix}");
                suffix += 1;
            }
            member
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pascal_case_conversions() {
        assert_eq!(to_pascal_case("hp"), "Hp");
        assert_eq!(to_pascal_case("max_hp"), "MaxHp");
        assert_eq!(to_pascal_case("monster-table"), "MonsterTable");
        assert_eq!(to_pascal_case("2nd_slot"), "_2ndSlot");
        assert_eq!(to_pascal_case(""), "_");
    }

    /// Verify that both backends emit the expected elements from a hand-built model.
    fn sample_model() -> CgModel {
        CgModel {
            project_name: "demo".to_string(),
            interfaces: vec![CgInterface {
                uuid: String::new(),
                type_name: "Character".to_string(),
                members: vec![CgInterfaceMember {
                    accessor: "Hp".to_string(),
                    value_type: ValueType::I32,
                    reference_target: None,
                    table_ref_interface: None,
                    data_name: "hp".to_string(),
                }],
            }],
            tables: vec![
                CgTable {
                    csharp_interfaces: vec![],
                    uuid: String::new(),
                    labeled_records: vec![],
                    data_name: "items".to_string(),
                    type_base: "Items".to_string(),
                    columns: vec![CgColumn {
                        key: "power".to_string(),
                        accessor: "Power".to_string(),
                        value_type: ValueType::I32,
                        reference_target: None,
                        table_ref_interface: None,
                        select_options: None,
                    }],
                    implements: vec![],
                },
                CgTable {
                    csharp_interfaces: vec![(
                        "Character".into(),
                        vec![(
                            "Hp".into(),
                            CgColumn {
                                key: "hp".into(),
                                accessor: "Hp".into(),
                                value_type: ValueType::I32,
                                reference_target: None,
                                table_ref_interface: None,
                                select_options: None,
                            },
                        )],
                    )],
                    uuid: String::new(),
                    labeled_records: vec![],
                    data_name: "heroes".to_string(),
                    type_base: "Heroes".to_string(),
                    columns: vec![
                        CgColumn {
                            key: "hp".to_string(),
                            accessor: "Hp".to_string(),
                            value_type: ValueType::I32,
                            reference_target: None,
                            table_ref_interface: None,
                            select_options: None,
                        },
                        CgColumn {
                            key: "weapon".to_string(),
                            accessor: "Weapon".to_string(),
                            value_type: ValueType::Reference,
                            reference_target: Some("Items".to_string()),
                            table_ref_interface: None,
                            select_options: None,
                        },
                    ],
                    implements: vec!["Character".to_string()],
                },
            ],
        }
    }

    #[test]
    fn csharp_backend_emits_expected() {
        let code = csharp::generate(&sample_model(), csharp::DEFAULT_NAMESPACE);
        assert!(code.contains("public interface ICharacter"));
        assert!(code.contains("public readonly struct HeroesRow : ICharacter"));
        assert!(code.contains("public int Hp =>"));
        // Reference accessor returns a row from the target table
        assert!(code.contains("public ItemsRow? Weapon"));
        assert!(code.contains("_t.Database.Items.ById"));
        // Each table has a DB accessor
        assert!(code.contains("public HeroesTable Heroes { get; }"));
    }

    #[test]
    fn cpp_backend_emits_expected() {
        let code = cpp::generate(&sample_model(), cpp::DEFAULT_NAMESPACE);
        assert!(code.contains("concept ICharacter"));
        assert!(code.contains("struct HeroesRow"));
        assert!(code.contains("int32_t hp() const"));
        // Reference accessor
        assert!(code.contains("std::optional<ItemsRow> weapon() const"));
        assert!(code.contains("forward") || code.contains("struct ItemsRow; class ItemsTable;"));
    }
    #[test]
    fn rejects_generated_api_collisions() {
        let mut model = sample_model();
        model.tables[0].type_base = "Handle".into();
        assert!(validate_model(&model).is_err());
        let mut model = sample_model();
        model.tables[0].columns[0].accessor = "RowIndex".into();
        assert!(validate_model(&model).is_err());
        let mut model = sample_model();
        model.tables[1].type_base = model.tables[0].type_base.clone();
        assert!(validate_model(&model).is_err());
    }
    #[test]
    fn namespaces_are_validated_and_normalized_for_target() {
        let temp = tempfile::tempdir().unwrap();
        let mut project =
            Project::create_project("Namespace", temp.path().to_str().unwrap(), "", "#123456")
                .unwrap();
        assert!(generate_code(&mut project, CodegenTarget::CSharp, Some("Foo; invalid")).is_err());
        assert!(generate_code(&mut project, CodegenTarget::Cpp, Some("a..b")).is_err());
        assert!(generate_code(&mut project, CodegenTarget::Cpp, Some("class.a")).is_err());
        assert!(
            generate_code(&mut project, CodegenTarget::CSharp, Some("Game::Data"))
                .unwrap()
                .contains("namespace Game.Data")
        );
        assert!(
            generate_code(&mut project, CodegenTarget::Cpp, Some("Game.Data"))
                .unwrap()
                .contains("namespace Game::Data")
        );
    }
}
