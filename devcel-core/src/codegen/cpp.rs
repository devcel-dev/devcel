//! C++ (Unreal) code generation backend.
//!
//! Imports the `devcel-runtime` C ABI with `extern "C"` and generates typed
//! `XxxTable` / `XxxRow` wrappers for each table in a single header. References
//! use forward declarations and out-of-line definitions. Interfaces map to
//! C++20 concepts (only when `__cpp_concepts` is enabled).

use super::{CgColumn, CgModel, CgTable};
use crate::types::ValueType;

/// Default C++ namespace.
pub const DEFAULT_NAMESPACE: &str = "devcel";

// All C++20 keywords, including alternative operator tokens. Keep the existing
// trailing-underscore convention for source compatibility.
const CPP_KEYWORDS: &str = "alignas alignof and and_eq asm auto bitand bitor bool break case catch char char8_t char16_t char32_t class compl concept const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default delete do double dynamic_cast else enum explicit export extern false float for friend goto if inline int long mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public register reinterpret_cast requires return short signed sizeof static static_assert static_cast struct switch template this thread_local throw true try typedef typeid typename union unsigned using virtual void volatile wchar_t while xor xor_eq";

/// Check names after target-specific conversion, in the actual generated scopes.
/// Shared PascalCase checks cannot detect snake_case or helper-name collisions.
pub(super) fn validate_names(model: &CgModel, class_name: &str) -> crate::Result<()> {
    use std::collections::HashSet;
    fn insert(names: &mut HashSet<String>, name: String, scope: &str) -> crate::Result<()> {
        let mut chars = name.chars();
        let valid = matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
            && !name.contains("__")
            && !(name.starts_with('_')
                && name.as_bytes().get(1).is_some_and(u8::is_ascii_uppercase))
            && !CPP_KEYWORDS
                .split_whitespace()
                .any(|keyword| keyword == name);
        if !valid || !names.insert(name.clone()) {
            return Err(crate::app_error::diagnostic(
                "error.codegen.cppIdentifier",
                serde_json::json!({"scope": scope, "name": name}),
            ));
        }
        Ok(())
    }
    fn members(
        names: &mut HashSet<String>,
        name: String,
        kind: &ValueType,
        select: bool,
        scope: &str,
    ) -> crate::Result<()> {
        insert(names, name.clone(), scope)?;
        if *kind == ValueType::TableRef {
            insert(names, format!("{name}_table"), scope)?;
        }
        if *kind == ValueType::DateTime {
            insert(names, format!("{name}_rfc3339"), scope)?;
        }
        if *kind == ValueType::Curve {
            insert(names, format!("sample_{name}"), scope)?;
        }
        if select {
            insert(names, format!("{name}_value"), scope)?;
        }
        Ok(())
    }
    let mut types = HashSet::new();
    let mut database = [
        "state_",
        "handle",
        "open",
        "from_json",
        "reload_if_changed",
        "close",
        class_name,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect();
    for interface in &model.interfaces {
        insert(&mut types, format!("I{}", interface.type_name), "namespace")?;
        let mut names = HashSet::new();
        for member in &interface.members {
            members(
                &mut names,
                to_snake_case(&member.accessor),
                &member.value_type,
                false,
                &interface.type_name,
            )?;
        }
    }
    for table in &model.tables {
        insert(&mut types, format!("{}Table", table.type_base), "namespace")?;
        insert(&mut types, format!("{}Row", table.type_base), "namespace")?;
        insert(&mut database, member_name(table), class_name)?;
        let mut row = ["t_", "row_", "generation_", "row_index"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut fields = HashSet::new();
        for column in &table.columns {
            members(
                &mut row,
                to_snake_case(&column.accessor),
                &column.value_type,
                column.select_options.is_some(),
                &table.data_name,
            )?;
            insert(&mut fields, col_field(column), &table.data_name)?;
            if let Some(values) = &column.select_options {
                let enum_name = super::select_enum_name(table, column);
                insert(&mut types, enum_name.clone(), "namespace")?;
                let mut names = HashSet::new();
                for member in super::select_enum_members(&enum_name, values) {
                    insert(&mut names, member, &enum_name)?;
                }
            }
        }
    }
    Ok(())
}

/// Generate a C++ header from the model, using `namespace_name` for its namespace.
/// Convert dot-separated namespaces (C# style) to C++17 nested namespaces `a::b`.
pub fn generate(model: &CgModel, namespace_name: &str) -> String {
    generate_with_class_name(model, namespace_name, "Database")
}

/// Only the database owner type is configurable; table/row/interface names stay schema-derived.
pub fn generate_with_class_name(model: &CgModel, namespace_name: &str, class_name: &str) -> String {
    let ns = namespace_name.replace('.', "::");
    let mut s = String::new();

    s.push_str("// <auto-generated>\n");
    s.push_str(
        "// Devcel codegen — This file is generated automatically. Do not edit it by hand.\n",
    );
    // Project display names are arbitrary text, never source-code lines.
    s.push_str(&format!(
        "// project: {}\n",
        model
            .project_name
            .replace(['\r', '\n', '\u{0085}', '\u{2028}', '\u{2029}'], " ")
            // A trailing backslash would splice the following source line.
            .replace('\\', "\\u005C")
    ));
    s.push_str("// </auto-generated>\n");
    s.push_str("#pragma once\n");
    s.push_str("#include <cstdint>\n#include <type_traits>\n#include <string>\n#include <string_view>\n#include <optional>\n#include <vector>\n#include <memory>\n#include <stdexcept>\n#include <utility>\n\n");
    // A single C ABI type identity across independently generated project headers.
    s.push_str(
        r#"#ifndef DEVCEL_RUNTIME_COLOR_TYPES
#define DEVCEL_RUNTIME_COLOR_TYPES
struct DevcelColor32 { uint8_t r, g, b, a; };
struct DevcelColorFloat { float r, g, b, a; };
#endif
static_assert(sizeof(DevcelColor32) == 4, "Color32 ABI size");
static_assert(sizeof(DevcelColorFloat) == 16, "ColorFloat ABI size");

"#,
    );
    s.push_str(&format!("namespace {ns} {{\n\n"));

    emit_ffi(&mut s);
    emit_scalar_parsers(&mut s);
    emit_select_enums(&mut s, model);

    // Forward declarations
    s.push_str(&"class Database;\n".replace("Database", class_name));
    for t in &model.tables {
        s.push_str(&format!("struct {0}Row; class {0}Table;\n", t.type_base));
    }
    s.push('\n');

    // Interfaces to concepts
    emit_concepts(&mut s, model);

    // Table classes (out-of-line methods)
    for t in &model.tables {
        emit_table_class(&mut s, t, &ns, class_name);
    }

    emit_table_reference(&mut s, model);

    // Row structs (inline scalars, out-of-line reference declarations)
    for t in &model.tables {
        emit_row_struct(&mut s, t);
    }

    // Database
    emit_database(&mut s, model, &ns, class_name);

    // Out-of-line definitions
    for t in &model.tables {
        emit_table_out_of_line(&mut s, t, &ns, class_name);
        emit_row_out_of_line(&mut s, t);
    }

    s.push_str(&format!("\n}} // namespace {ns}\n"));
    s
}

/// Emit FFI declarations and helpers.
fn emit_ffi(s: &mut String) {
    s.push_str(
        r#"// Precision-only, straight-alpha RGBA. No implicit color-space conversion.
using ::DevcelColor32;
using ::DevcelColorFloat;

extern "C" {
    uint32_t devcel_rt_api_version();
    int32_t devcel_rt_get_color32(const void* db, int table, int row, int col, DevcelColor32* out);
    int32_t devcel_rt_get_color_float(const void* db, int table, int row, int col, DevcelColorFloat* out);
    void* devcel_rt_open(const char* path);
    void* devcel_rt_open_from_json(const char* json);
    void  devcel_rt_close(void* db);
    int   devcel_rt_reload_if_changed(const void* db);
    int   devcel_rt_table_index(const void* db, const char* name);
    int   devcel_rt_row_count(const void* db, int table);
    int   devcel_rt_column_index(const void* db, int table, const char* name);
    int   devcel_rt_row_by_uuid(const void* db, int table, const char* uuid);
    int32_t devcel_rt_get_i32(const void* db, int table, int row, int col);
    int64_t devcel_rt_get_i64(const void* db, int table, int row, int col);
    float   devcel_rt_get_f32(const void* db, int table, int row, int col);
    double  devcel_rt_get_f64(const void* db, int table, int row, int col);
    int     devcel_rt_resolve_table_ref(const void* db, int table, int row, int col, const char* required_interface);
    double  devcel_rt_sample_curve(const void* db, int table, int row, int col, double x);
    int     devcel_rt_get_bool(const void* db, int table, int row, int col);
    const uint8_t* devcel_rt_get_str(const void* db, int table, int row, int col, int* len);
}

inline void kr_verify_api() {
    if (devcel_rt_api_version() != 1) throw std::runtime_error("Devcel runtime ABI version 1 is required");
}
inline DevcelColor32 kr_color32(const void* db, int table, int row, int col) {
    DevcelColor32 value{};
    if (devcel_rt_get_color32(db, table, row, col, &value) != 1)
        throw std::runtime_error("Devcel Color32 cell is missing or has a different type");
    return value;
}
inline DevcelColorFloat kr_color_float(const void* db, int table, int row, int col) {
    DevcelColorFloat value{};
    if (devcel_rt_get_color_float(db, table, row, col, &value) != 1)
        throw std::runtime_error("Devcel ColorFloat cell is missing or has a different type");
    return value;
}

// Shared state prevents table/row wrappers from retaining freed native pointers.
struct NativeState {
    void* handle;
    uint64_t generation = 0;
    explicit NativeState(void* h) : handle(h) {}
    ~NativeState() { close(); }
    void close() { if (handle) { devcel_rt_close(handle); handle=nullptr; ++generation; } }
    const void* checked(uint64_t expected) const {
        if (!handle) throw std::runtime_error("Devcel database is closed");
        if (generation != expected) throw std::runtime_error("Devcel row was invalidated by reload; obtain it again by ID");
        return handle;
    }
};

// Return a string cell as a string_view (zero-copy; valid until the next reload).
inline std::string_view kr_str(const void* db, int table, int row, int col) {
    int len = 0;
    const uint8_t* p = devcel_rt_get_str(db, table, row, col, &len);
    if (!p || len <= 0) return std::string_view();
    return std::string_view(reinterpret_cast<const char*>(p), static_cast<size_t>(len));
}

"#,
    );
}

/// Emit interfaces as C++20 concepts.
fn emit_concepts(s: &mut String, model: &CgModel) {
    if model.interfaces.is_empty() {
        return;
    }
    s.push_str("#if defined(__cpp_concepts)\n");
    for iface in &model.interfaces {
        if iface.members.is_empty() {
            s.push_str(&format!(
                "template <class T> concept I{} = true;\n",
                iface.type_name
            ));
            continue;
        }
        s.push_str(&format!(
            "template <class T> concept I{} = requires(const T t) {{\n",
            iface.type_name
        ));
        for m in &iface.members {
            let expected = if m.value_type == ValueType::Reference {
                m.reference_target
                    .as_ref()
                    .map(|target| format!("std::optional<{target}Row>"))
                    .unwrap_or_else(|| scalar_type(&m.value_type))
            } else {
                scalar_type(&m.value_type)
            };
            s.push_str(&format!(
                "    requires std::is_same_v<decltype(t.{}()), {expected}>;\n",
                to_snake_case(&m.accessor)
            ));
            if m.value_type == ValueType::TableRef {
                s.push_str(&format!(
                    "    requires std::is_same_v<decltype(t.{}_table()), std::optional<TableReference>>;\n",
                    to_snake_case(&m.accessor)
                ));
            }
            if m.value_type == ValueType::DateTime {
                s.push_str(&format!(
                    "    requires std::is_same_v<decltype(t.{}_rfc3339()), std::optional<DevcelDateTimeOffset>>;\n",
                    to_snake_case(&m.accessor)
                ));
            }
            if m.value_type == ValueType::Curve {
                s.push_str(&format!(
                    "    requires std::is_same_v<decltype(t.sample_{}(0.0)), double>;\n",
                    to_snake_case(&m.accessor)
                ));
            }
        }
        s.push_str("};\n");
    }
    s.push_str("#endif\n\n");
}

/// Table class body (method declarations only; definitions are out of line).
fn emit_table_class(s: &mut String, t: &CgTable, namespace: &str, class_name: &str) {
    let base = &t.type_base;
    let root_type = format!("::{namespace}::{class_name}");
    s.push_str(&format!("class {base}Table {{\npublic:\n"));
    s.push_str("    std::shared_ptr<NativeState> state_;\n    mutable uint64_t index_generation_ = UINT64_MAX;\n    mutable int table_ = -1;\n");
    for col in &t.columns {
        s.push_str(&format!("    mutable int {} = -1;\n", col_field(col)));
    }
    s.push_str(&format!("    explicit {base}Table(std::shared_ptr<NativeState> state) : state_(std::move(state)) {{}}\n    explicit {base}Table(const {root_type}& db);\n"));
    s.push_str("    void refresh() const;\n    const void* checked_handle(uint64_t generation) const { return state_->checked(generation); }\n    int count() const;\n");
    s.push_str(&format!("    {base}Row operator[](int row) const;\n    std::optional<{base}Row> by_id(std::string_view uuid) const;\n    std::vector<{base}Row> all() const;\n}};\n\n"));
}

fn emit_row_struct(s: &mut String, t: &CgTable) {
    let base = &t.type_base;
    s.push_str(&format!("struct {base}Row {{\n    {base}Table t_;\n    int row_;\n    uint64_t generation_;\n    {base}Row(const {base}Table& t, int row) : t_(t), row_(row), generation_(t.state_->generation) {{}}\n    int row_index() const {{ t_.checked_handle(generation_); return row_; }}\n"));
    for col in &t.columns {
        let name = to_snake_case(&col.accessor);
        emit_select_accessor(s, t, col);
        {
            let (kind, suffix, ty) = (ValueType::DateTime, "rfc3339", "DevcelDateTimeOffset");
            if col.value_type == kind {
                s.push_str(&format!("    std::optional<{ty}> {name}_{suffix}() const {{ return DevcelScalarParsers::try_parse_{suffix}({name}()); }}\n"));
            }
        }
        if col.value_type == ValueType::TableRef {
            s.push_str(&format!("    std::optional<TableReference> {name}_table() const {{ int target = devcel_rt_resolve_table_ref(t_.checked_handle(generation_), t_.table_, row_, t_.{}, \"{}\"); if (target < 0) return std::nullopt; return TableReference(t_.state_, target, generation_); }}\n", col_field(col), escape(col.table_ref_interface.as_deref().unwrap_or(""))));
        }
        if col.value_type == ValueType::Curve {
            s.push_str(&format!("    double sample_{name}(double x) const {{ return devcel_rt_sample_curve(t_.checked_handle(generation_), t_.table_, row_, t_.{}, x); }}\n", col_field(col)));
        }
        if col.value_type == ValueType::Reference {
            if let Some(target) = &col.reference_target {
                s.push_str(&format!("    std::optional<{target}Row> {name}() const;\n"));
                continue;
            }
        }
        s.push_str(&format!(
            "    {} {name}() const {{ return {}; }}\n",
            scalar_type(&col.value_type),
            scalar_getter(&col.value_type, col)
        ));
    }
    s.push_str("};\n\n");
}

fn emit_database(s: &mut String, model: &CgModel, namespace: &str, class_name: &str) {
    let root_type = format!("::{namespace}::{class_name}");
    s.push_str(
        &"class Database {\npublic:\n    std::shared_ptr<NativeState> state_;\n"
            .replace("Database", class_name),
    );
    for t in &model.tables {
        s.push_str(&format!("    {}Table {};\n", t.type_base, member_name(t)));
    }
    for (signature, init) in [
        (
            "explicit Database(void* h)",
            "state_(std::make_shared<NativeState>(h))",
        ),
        (
            "Database(Database&& other) noexcept",
            "state_(std::move(other.state_))",
        ),
    ] {
        let signature = signature.replace("Database", class_name);
        s.push_str(&format!("    {signature} : {init}"));
        for t in &model.tables {
            s.push_str(&format!(", {}(state_)", member_name(t)));
        }
        s.push_str(" {}\n");
    }
    s.push_str(&"    Database(const Database&) = delete;\n    Database& operator=(const Database&) = delete;\n    Database& operator=(Database&& other) noexcept {\n        if (this != &other) { close(); state_ = std::move(other.state_);\n".replace("Database", class_name));
    for t in &model.tables {
        s.push_str(&format!(
            "            {} = {}Table(state_);\n",
            member_name(t),
            t.type_base
        ));
    }
    s.push_str(&"        }\n        return *this;\n    }\n    ~Database() { close(); }\n    const void* handle() const { return state_ ? state_->handle : nullptr; }\n".replace("Database", class_name));
    s.push_str(&r#"    static std::optional<Database> open(const char* path) {
        kr_verify_api();
        void* h = devcel_rt_open(path);
        if (!h) return std::nullopt;
        return std::optional<Database>(std::in_place, h);
    }
    static std::optional<Database> from_json(const char* json) {
        kr_verify_api();
        void* h = devcel_rt_open_from_json(json);
        if (!h) return std::nullopt;
        return std::optional<Database>(std::in_place, h);
    }
    bool reload_if_changed() {
        if (!state_ || !state_->handle) throw std::runtime_error("Devcel database is closed");
        int result = devcel_rt_reload_if_changed(state_->handle);
        if (result < 0) throw std::runtime_error("Devcel bundle reload failed; previous data was retained");
        if (result == 1) { ++state_->generation; return true; }
        return false;
    }
    void close() { if (state_) state_->close(); }
};

"#.replace("Database", &root_type));
}

fn emit_table_out_of_line(s: &mut String, t: &CgTable, namespace: &str, class_name: &str) {
    let base = &t.type_base;
    let root_type = format!("::{namespace}::{class_name}");
    s.push_str(&format!("inline {base}Table::{base}Table(const {root_type}& db) : state_(db.state_) {{}}\ninline void {base}Table::refresh() const {{\n    if (!state_ || !state_->handle) throw std::runtime_error(\"Devcel database is closed\");\n    if (index_generation_ == state_->generation) return;\n    table_ = devcel_rt_table_index(state_->handle, \"{}\");\n",escape(&t.data_name)));
    for col in &t.columns {
        s.push_str(&format!(
            "    {} = table_ < 0 ? -1 : devcel_rt_column_index(state_->handle, table_, \"{}\");\n",
            col_field(col),
            escape(&col.key)
        ));
    }
    s.push_str("    index_generation_ = state_->generation;\n}\n");
    s.push_str(&format!("inline int {base}Table::count() const {{ refresh(); return table_ < 0 ? 0 : devcel_rt_row_count(state_->handle, table_); }}\ninline {base}Row {base}Table::operator[](int row) const {{\n    int n = count(); if (row < 0 || row >= n) throw std::out_of_range(\"Devcel row index\");\n    return {base}Row(*this, row);\n}}\ninline std::optional<{base}Row> {base}Table::by_id(std::string_view uuid) const {{\n    refresh(); std::string u(uuid);\n    int row = devcel_rt_row_by_uuid(state_->handle, table_, u.c_str());\n    if (row < 0) return std::nullopt;\n    return {base}Row(*this, row);\n}}\ninline std::vector<{base}Row> {base}Table::all() const {{\n    std::vector<{base}Row> rows; int n=count(); rows.reserve(n);\n    for (int i=0; i<n; ++i) rows.emplace_back(*this,i);\n    return rows;\n}}\n"));
}

fn emit_row_out_of_line(s: &mut String, t: &CgTable) {
    for col in &t.columns {
        if col.value_type != ValueType::Reference {
            continue;
        }
        if let Some(target) = &col.reference_target {
            s.push_str(&format!("inline std::optional<{target}Row> {}Row::{}() const {{\n    std::string_view uuid=kr_str(t_.checked_handle(generation_),t_.table_,row_,t_.{});\n    if (uuid.empty()) return std::nullopt;\n    return {target}Table(t_.state_).by_id(uuid);\n}}\n",t.type_base,to_snake_case(&col.accessor),col_field(col)));
        }
    }
}

fn col_field(col: &CgColumn) -> String {
    format!("col_{}", to_snake_case(&col.accessor))
}
pub(super) fn member_name(t: &CgTable) -> String {
    to_snake_case(&t.type_base)
}

/// C++ type for a scalar.
fn scalar_type(vt: &ValueType) -> String {
    match vt {
        ValueType::Color32 => "DevcelColor32".to_string(),
        ValueType::ColorFloat => "DevcelColorFloat".to_string(),
        ValueType::Boolean => "bool".to_string(),
        ValueType::F32 => "float".to_string(),
        ValueType::F64 => "double".to_string(),
        ValueType::U8
        | ValueType::I8
        | ValueType::U16
        | ValueType::I16
        | ValueType::U32
        | ValueType::I32
        | ValueType::U64
        | ValueType::I64 => vt.cpp_type().to_string(),
        _ => "std::string_view".to_string(),
    }
}

/// Scalar value access expression.
fn scalar_getter(vt: &ValueType, col: &CgColumn) -> String {
    let args = format!(
        "t_.checked_handle(generation_), t_.table_, row_, t_.{}",
        col_field(col)
    );
    match vt {
        ValueType::Color32 => format!("kr_color32({args})"),
        ValueType::ColorFloat => format!("kr_color_float({args})"),
        ValueType::Boolean => format!("devcel_rt_get_bool({args}) != 0"),
        ValueType::F32 => format!("devcel_rt_get_f32({args})"),
        ValueType::F64 => format!("devcel_rt_get_f64({args})"),
        ValueType::U8 | ValueType::I8 | ValueType::U16 | ValueType::I16 | ValueType::I32 => {
            let cast = vt.cpp_type();
            if cast == "int32_t" {
                format!("devcel_rt_get_i32({args})")
            } else {
                format!("static_cast<{cast}>(devcel_rt_get_i32({args}))")
            }
        }
        ValueType::U32 | ValueType::I64 | ValueType::U64 => {
            let cast = vt.cpp_type();
            if cast == "int64_t" {
                format!("devcel_rt_get_i64({args})")
            } else {
                format!("static_cast<{cast}>(devcel_rt_get_i64({args}))")
            }
        }
        _ => format!("kr_str({args})"),
    }
}

/// Escape a string literal.
fn escape(s: &str) -> String {
    let mut out = String::new();
    for ch in s.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if c.is_control() || c == '\u{2028}' || c == '\u{2029}' => {
                let mut bytes = [0u8; 4];
                for b in c.encode_utf8(&mut bytes).as_bytes() {
                    out.push_str(&format!("\\{:03o}", b));
                }
            }
            c => out.push(c),
        }
    }
    out
}

/// Convert PascalCase or an arbitrary identifier to snake_case.
fn to_snake_case(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 4);
    for (i, ch) in s.chars().enumerate() {
        if ch == '_' || ch == '-' || ch == ' ' {
            out.push('_');
        } else if ch.is_uppercase() {
            if i != 0 && !out.ends_with('_') {
                out.push('_');
            }
            out.extend(ch.to_lowercase());
        } else {
            out.push(ch);
        }
    }
    if CPP_KEYWORDS
        .split_whitespace()
        .any(|keyword| keyword == out)
    {
        out.push('_');
    }
    out
}

fn emit_table_reference(s: &mut String, model: &CgModel) {
    s.push_str(
        r#"class TableReference {
    std::shared_ptr<NativeState> state_;
    int table_;
    uint64_t generation_;
public:
    TableReference(std::shared_ptr<NativeState> state, int table, uint64_t generation)
        : state_(std::move(state)), table_(table), generation_(generation) {}
    int table_index() const { state_->checked(generation_); return table_; }
    int count() const { return devcel_rt_row_count(state_->checked(generation_), table_); }
"#,
    );
    for t in &model.tables {
        s.push_str(&format!("    std::optional<{0}Table> as_{1}() const {{ state_->checked(generation_); {0}Table table(state_); table.refresh(); if (table.table_ != table_) return std::nullopt; return table; }}\n", t.type_base, member_name(t)));
    }
    s.push_str("};\n\n");
}

fn emit_select_enums(s: &mut String, model: &CgModel) {
    for table in &model.tables {
        for col in &table.columns {
            if let Some(values) = &col.select_options {
                let ty = super::select_enum_name(table, col);
                s.push_str(&format!("enum class {ty} {{\n"));
                for (i, member) in super::select_enum_members(&ty, values).iter().enumerate() {
                    s.push_str(&format!("    {member} = {i},\n"));
                }
                s.push_str("};\n\n");
            }
        }
    }
}

fn emit_select_accessor(s: &mut String, table: &CgTable, col: &CgColumn) {
    if let Some(values) = &col.select_options {
        let ty = super::select_enum_name(table, col);
        s.push_str(&format!(
            "    std::optional<{ty}> {}_value() const {{\n        auto value = {}();\n",
            to_snake_case(&col.accessor),
            to_snake_case(&col.accessor)
        ));
        for (value, member) in values.iter().zip(super::select_enum_members(&ty, values)) {
            s.push_str(&format!(
                "        if (value == std::string_view(\"{}\", {})) return {ty}::{member};\n",
                escape(value),
                value.len()
            ));
        }
        s.push_str("        (void)value;\n        return std::nullopt;\n    }\n");
    }
}

/// Engine-independent optional conversions usable in C++17. Dates use integer seconds plus a 100 ns fraction.
fn emit_scalar_parsers(s: &mut String) {
    s.push_str(r#"// Explicit-offset instant: unix_seconds is the floor whole UTC seconds since 1970-01-01.
// fraction_ticks is 0..9999999 (100ns each); offset_minutes preserves the input offset.
struct DevcelDateTimeOffset {
    int64_t unix_seconds;
    int32_t fraction_ticks;
    int32_t offset_minutes;
};

// Opt-in parser for explicitly formatted DateTime strings.
class DevcelScalarParsers {
    static int digits(std::string_view text, size_t at, size_t count) {
        int value = 0;
        for (size_t i = at; i < at + count; ++i) {
            const char c = text[i];
            if (c < '0' || c > '9') return -1;
            value = value * 10 + c - '0';
        }
        return value;
    }
public:
    // RFC3339 subset: YYYY-MM-DD[Tt]hh:mm:ss[.1-7 digits] with Z/z or +/-HH:MM.
    // Requires a known explicit offset within +/-14:00. Rejects -00:00 (unknown offset), leap seconds,
    // whitespace, year 0000 and instants outside years 0001-9999. Gregorian dates; 100ns precision.
    // Never assumes a local timezone or rounds fractions. Other text stays accessible through the raw accessor.
    static std::optional<DevcelDateTimeOffset> try_parse_rfc3339(std::string_view text) {
        if (text.size() < 20 || text[4] != '-' || text[7] != '-' ||
            (text[10] != 'T' && text[10] != 't') || text[13] != ':' || text[16] != ':') return std::nullopt;
        const int year = digits(text, 0, 4), month = digits(text, 5, 2), day = digits(text, 8, 2);
        const int hour = digits(text, 11, 2), minute = digits(text, 14, 2), second = digits(text, 17, 2);
        if (year < 1 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 ||
            minute < 0 || minute > 59 || second < 0 || second > 59) return std::nullopt;
        const bool leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        const int month_days[] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
        if (day > month_days[month - 1] + (month == 2 && leap ? 1 : 0)) return std::nullopt;
        size_t pos = 19;
        int ticks = 0;
        if (text[pos] == '.') {
            const size_t start = ++pos;
            while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') {
                if (pos - start == 7) return std::nullopt;
                ticks = ticks * 10 + text[pos++] - '0';
            }
            size_t count = pos - start;
            if (count == 0) return std::nullopt;
            for (; count < 7; ++count) ticks *= 10;
        }
        if (pos >= text.size()) return std::nullopt;
        int offset_minutes = 0;
        if ((text[pos] == 'Z' || text[pos] == 'z') && pos + 1 == text.size()) { }
        else {
            if (text.size() - pos != 6 || (text[pos] != '+' && text[pos] != '-') || text[pos + 3] != ':') return std::nullopt;
            const int hours = digits(text, pos + 1, 2), minutes = digits(text, pos + 4, 2);
            if (hours < 0 || hours > 14 || minutes < 0 || minutes > 59 || (hours == 14 && minutes != 0)) return std::nullopt;
            offset_minutes = hours * 60 + minutes;
            if (text[pos] == '-') {
                if (offset_minutes == 0) return std::nullopt;
                offset_minutes = -offset_minutes;
            }
        }
        const int64_t previous_year = year - 1;
        int64_t days = previous_year * 365 + previous_year / 4 - previous_year / 100 + previous_year / 400;
        for (int m = 1; m < month; ++m) days += month_days[m - 1] + (m == 2 && leap ? 1 : 0);
        days += day - 1;
        const int64_t utc_seconds = days * 86400 + hour * 3600 + minute * 60 + second - offset_minutes * 60;
        // Match DateTimeOffset's UTC range [0001-01-01, 10000-01-01).
        if (utc_seconds < 0 || utc_seconds >= INT64_C(315537897600)) return std::nullopt;
        return DevcelDateTimeOffset{utc_seconds - INT64_C(62135596800), ticks, offset_minutes};
    }
};

"#);
}
