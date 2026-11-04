//! Eager managed read models: allocation belongs to publication, not acquisition.
use super::{
    csharp::{col_index_field, escape, member_prop_type},
    CgColumn, CgModel,
};
use crate::ValueType;

fn ty(c: &CgColumn) -> String {
    c.reference_target
        .as_ref()
        .map(|t| format!("{t}Handle?"))
        .unwrap_or_else(|| member_prop_type(&c.value_type, None))
}
fn field(s: &mut String, c: &CgColumn, token: &str) {
    s.push_str(&format!(
        "            internal {} {token} = default!;\n",
        ty(c)
    ));
    if c.value_type == ValueType::TableRef {
        s.push_str(&format!(
            "            internal DevcelTableHandle? {token}Table;\n"
        ));
    }
    if c.value_type == ValueType::DateTime {
        s.push_str(&format!(
            "            internal DateTimeOffset? {token}Rfc3339;\n"
        ));
    }
}
fn fill(s: &mut String, c: &CgColumn, token: &str, table: &str) {
    let a = &c.accessor;
    if let Some(target) = &c.reference_target {
        let index = col_index_field(c);
        s.push_str(&format!("            string r{token} = DevcelNative.GetString(_db.Handle, _db.{table}.TableIndex, row.RowIndex, _db.{table}.{index}); state.{token} = next{target}.TryGetValue(r{token}, out var v{token}) ? v{token} : null;\n"));
    } else if ty(c) == "string" {
        s.push_str(&format!(
            "            state.{token} = _db.ShareString(row.{a});\n"
        ));
    } else {
        s.push_str(&format!("            state.{token} = row.{a};\n"));
    }
    if c.value_type == ValueType::Curve {
        // Initialize the native sampling interop stub during publication, not the first read.
        s.push_str(&format!("            _ = row.Sample{a}(0.0);\n"));
    }
    if c.value_type == ValueType::TableRef {
        s.push_str(&format!("            state.{token}Table = row.{a}Table.HasValue ? _db.GetTableView(state.{token}, \"{}\") : null;\n",escape(c.table_ref_interface.as_deref().unwrap_or(""))));
    }
    if c.value_type == ValueType::DateTime {
        s.push_str(&format!(
            "            state.{token}Rfc3339 = DevcelScalarParsers.TryParseRfc3339(state.{token}, out var d{token}) ? d{token} : (DateTimeOffset?)null;\n"
        ));
    }
}
fn prop(s: &mut String, c: &CgColumn, name: &str, token: &str, iface: Option<&str>) {
    let qualifier = iface.map(|i| format!("I{i}Handle.")).unwrap_or_default();
    let public = if iface.is_none() { "public " } else { "" };
    let guard = iface
        .map(|i| format!("Require{i}()"))
        .unwrap_or_else(|| "RequireCurrent()".into());
    s.push_str(&format!("        {public}{} {qualifier}{name} {{ get {{ lock (_db.ReadGate) return {guard}.{token}; }} }}\n",ty(c)));
    if c.value_type == ValueType::TableRef {
        s.push_str(&format!("        {public}DevcelTableHandle? {qualifier}{name}Table {{ get {{ lock (_db.ReadGate) return {guard}.{token}Table; }} }}\n"));
    }
    if c.value_type == ValueType::DateTime {
        s.push_str(&format!("        {public}DateTimeOffset? {qualifier}{name}Rfc3339 {{ get {{ lock (_db.ReadGate) return {guard}.{token}Rfc3339; }} }}\n"));
    }
    if c.value_type == ValueType::Curve {
        s.push_str(&format!("        {public}double {qualifier}Sample{name}(double x) {{ lock (_db.ReadGate) return {guard}.Row.Sample{}(x); }}\n",c.accessor));
    }
}
pub(super) fn emit(s: &mut String, model: &CgModel, namespace: &str, class_name: &str) {
    let db = format!("global::{namespace}.{class_name}");
    for i in &model.interfaces {
        let n = &i.type_name;
        s.push_str(&format!("    public readonly struct I{n}Key {{ public string TableUuid {{ get; }} public string Uuid {{ get; }} public I{n}Key(string tableUuid, string uuid) {{ TableUuid=tableUuid; Uuid=uuid; }} public I{n}Reference ToReference() => new I{n}Reference(TableUuid,Uuid); }}\n    public interface I{n}Handle {{ bool Exists {{ get; }} string Uuid {{ get; }} string TableUuid {{ get; }}\n"));
        for m in &i.members {
            let c = CgColumn {
                key: String::new(),
                accessor: m.accessor.clone(),
                value_type: m.value_type.clone(),
                reference_target: m.reference_target.clone(),
                table_ref_interface: m.table_ref_interface.clone(),
                select_options: None,
            };
            s.push_str(&format!("        {} {} {{ get; }}\n", ty(&c), m.accessor));
            match m.value_type {
                ValueType::TableRef => s.push_str(&format!(
                    "        DevcelTableHandle? {}Table {{ get; }}\n",
                    m.accessor
                )),
                ValueType::DateTime => s.push_str(&format!(
                    "        DateTimeOffset? {}Rfc3339 {{ get; }}\n",
                    m.accessor
                )),
                ValueType::Curve => {
                    s.push_str(&format!("        double Sample{}(double x);\n", m.accessor))
                }
                _ => {}
            }
        }
        s.push_str("    }\n");
    }
    let maps = model
        .tables
        .iter()
        .map(|t| {
            format!(
                "Dictionary<string, {}Handle> next{}",
                t.type_base, t.type_base
            )
        })
        .collect::<Vec<_>>()
        .join(", ");
    for t in &model.tables {
        let b = &t.type_base;
        let interfaces = t
            .csharp_interfaces
            .iter()
            .map(|(n, _)| format!("I{n}Handle"))
            .collect::<Vec<_>>();
        let bases = if interfaces.is_empty() {
            String::new()
        } else {
            format!(" : {}", interfaces.join(", "))
        };
        s.push_str(&format!("    public readonly struct {b}Key {{ public string Uuid {{ get; }} public {b}Key(string uuid) {{ Uuid=uuid; }} public {b}Reference ToReference() => new {b}Reference(Uuid);\n"));
        for (n, _) in &t.csharp_interfaces {
            s.push_str(&format!(
                "        public I{n}Key As{n}() => new I{n}Key(\"{}\", Uuid);\n",
                escape(&t.uuid)
            ));
        }
        s.push_str(&format!(r#"    }}
    public sealed class {b}Handle{bases}
    {{
        readonly {db} _db;
        public string Uuid {{ get; }}
        public string TableUuid => "{uuid}";
        State? _state;
        internal int ResolutionCount {{ get; private set; }}
        internal {b}Handle({db} db, string uuid) {{ _db=db; Uuid=uuid; }}
        public bool Exists {{ get {{ lock (_db.ReadGate) {{ _db.CheckReadModel(); return _state != null; }} }} }}
        State RequireCurrent() {{ _db.CheckReadModel(); return _state ?? throw new KeyNotFoundException("Referenced record is unavailable: " + Uuid); }}
        internal sealed class State {{ internal {b}Row Row;
"#,uuid=escape(&t.uuid)));
        for c in &t.columns {
            field(s, c, &format!("P{}", c.accessor));
        }
        for (n, _) in &t.csharp_interfaces {
            s.push_str(&format!("            internal bool Has{n};\n"));
        }
        s.push_str(&format!("        }}\n        internal State Prepare({b}Row row, bool[] interfaces, {maps}) {{ var state=new State {{ Row=row }};\n"));
        for c in &t.columns {
            fill(s, c, &format!("P{}", c.accessor), b);
        }
        for (index, (n, _)) in t.csharp_interfaces.iter().enumerate() {
            s.push_str(&format!(
                "            state.Has{n} = interfaces[{index}];\n"
            ));
        }
        s.push_str("            return state;\n        }\n        internal void Publish(State? state) { _state=state; ++ResolutionCount; }\n");
        for c in &t.columns {
            prop(s, c, &c.accessor, &format!("P{}", c.accessor), None);
            super::csharp::emit_select_accessor(s, t, c);
        }
        for (n, bindings) in &t.csharp_interfaces {
            s.push_str(&format!("        internal bool Has{n} {{ get {{ lock (_db.ReadGate) {{ _db.CheckReadModel(); return _state != null && _state.Has{n}; }} }} }}\n        bool I{n}Handle.Exists => Has{n};\n        State Require{n}() {{ var state=RequireCurrent(); if (!state.Has{n}) throw new KeyNotFoundException(\"Referenced interface is unavailable\"); return state; }}\n"));
            for (m, c) in bindings {
                prop(s, c, m, &format!("P{}", c.accessor), Some(n));
            }
        }
        s.push_str("    }\n");
    }
    emit_tables(s, model, &db);
}
pub(super) fn emit_database(s: &mut String, model: &CgModel) {
    s.push_str(r#"        internal Dictionary<(string Uuid,string Required),WeakReference<DevcelTableHandle>> TableViews = new Dictionary<(string,string),WeakReference<DevcelTableHandle>>();
        Dictionary<string,string>? _publicationStrings;
        Exception? _readFailure;
        internal string ShareString(string value) { if (_publicationStrings!.TryGetValue(value,out var shared)) return shared; _publicationStrings.Add(value,value); return value; }
        internal DevcelTableHandle GetTableView(string uuid,string required) {
            var key=(uuid,required);
            if(TableViews.TryGetValue(key,out var weak) && weak.TryGetTarget(out var existing)) return existing;
            var view=new DevcelTableHandle(this,uuid,required); TableViews[key]=new WeakReference<DevcelTableHandle>(view); return view;
        }
        internal void CheckReadModel() { CheckedHandle(Generation); if (_readFailure != null) throw new InvalidOperationException("Managed read model publication failed", _readFailure); }
"#);
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!("        internal Dictionary<string, {b}Handle> Live{b} = new Dictionary<string, {b}Handle>(StringComparer.Ordinal);\n        Dictionary<string, WeakReference<{b}Handle>> Retired{b} = new Dictionary<string, WeakReference<{b}Handle>>(StringComparer.Ordinal);\n        internal {b}Handle[] Members{b} = Array.Empty<{b}Handle>();\n        public {b}Handle? Get({b}Reference? reference) => Get(new {b}Key(reference?.Uuid ?? string.Empty));\n        public {b}Handle? Get({b}Key key) {{ lock (ReadGate) {{ CheckReadModel(); return key.Uuid != null && Live{b}.TryGetValue(key.Uuid, out var value) ? value : null; }} }}\n        public bool TryGet({b}Reference? reference, out {b}Handle? row) {{ row=Get(reference); return row != null; }}\n        public bool TryGet({b}Key key, out {b}Handle? row) {{ row=Get(key); return row != null; }}\n"));
    }
    for i in &model.interfaces {
        let n = &i.type_name;
        s.push_str(&format!("        public I{n}Handle? Get(I{n}Reference? reference) => reference == null ? Get(default(I{n}Key)) : Get(new I{n}Key(reference.TableUuid, reference.Uuid));\n        public I{n}Handle? Get(I{n}Key key) {{ lock(ReadGate) {{ CheckReadModel(); if (key.Uuid == null) return null; switch(key.TableUuid) {{\n"));
        for t in &model.tables {
            if t.csharp_interfaces.iter().any(|(x, _)| x == n) {
                let b = &t.type_base;
                s.push_str(&format!("            case \"{}\": return Live{b}.TryGetValue(key.Uuid, out var value{b}) && value{b}.Has{n} ? value{b} : null;\n",escape(&t.uuid)));
            }
        }
        s.push_str(&format!("            default: return null; }} }} }}\n        public bool TryGet(I{n}Reference? reference, out I{n}Handle? row) {{ row=Get(reference); return row != null; }}\n        public bool TryGet(I{n}Key key, out I{n}Handle? row) {{ row=Get(key); return row != null; }}\n"));
    }
    s.push_str("        void PublishReadModel() { try {\n            _publicationStrings=new Dictionary<string,string>(StringComparer.Ordinal);\n");
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!("            int count{b} = DevcelNative.ResolveRecordTable(Handle, \"{}\", string.Empty) == {b}.TableIndex && {b}.TableIndex >= 0 ? DevcelNative.devcel_rt_row_count(Handle, {b}.TableIndex) : 0;\n            var next{b}=new Dictionary<string, {b}Handle>(count{b},StringComparer.Ordinal);\n            var members{b}=new {b}Handle[count{b}];\n            for(int index=0;index<count{b};index++) {{ string id=ShareString(DevcelNative.RowUuid(Handle,{b}.TableIndex,index)); if (!Live{b}.TryGetValue(id,out var value) && !(Retired{b}.TryGetValue(id,out var weak) && weak.TryGetTarget(out value))) value=new {b}Handle(this,id); id=value.Uuid; _publicationStrings[id]=id; next{b}.Add(id,value); members{b}[index]=value; }}\n",escape(&t.uuid)));
    }
    let args = model
        .tables
        .iter()
        .map(|t| format!("next{}", t.type_base))
        .collect::<Vec<_>>()
        .join(", ");
    for t in &model.tables {
        let b = &t.type_base;
        // Interface membership is table metadata, constant across this candidate.
        let interfaces = t.csharp_interfaces.iter().map(|(name, _)| {
            let uuid = &model.interfaces.iter().find(|i| &i.type_name == name).unwrap().uuid;
            format!("{b}.TableIndex >= 0 && DevcelNative.ResolveRecordTable(Handle, \"{}\", \"{}\") == {b}.TableIndex", escape(&t.uuid), escape(uuid))
        }).collect::<Vec<_>>().join(", ");
        let interfaces = if interfaces.is_empty() {
            "Array.Empty<bool>()".to_owned()
        } else {
            format!("new bool[] {{ {interfaces} }}")
        };
        s.push_str(&format!("            var interfaces{b}={interfaces};\n            var states{b}=new {b}Handle.State[count{b}]; for(int index=0;index<count{b};index++) states{b}[index]=members{b}[index].Prepare(new {b}Row({b},index), interfaces{b}, {args});\n"));
    }
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!("            foreach(var id in new List<string>(Retired{b}.Keys)) if (!Retired{b}[id].TryGetTarget(out _)) Retired{b}.Remove(id);\n            foreach(var pair in Live{b}) if (!next{b}.ContainsKey(pair.Key)) {{ pair.Value.Publish(null); Retired{b}[pair.Key]=new WeakReference<{b}Handle>(pair.Value); }}\n            for(int index=0;index<count{b};index++) {{ members{b}[index].Publish(states{b}[index]); Retired{b}.Remove(members{b}[index].Uuid); }}\n            Live{b}=next{b}; Members{b}=members{b}; Retired{b}.TrimExcess();\n"));
    }
    s.push_str("            foreach(var key in new List<(string,string)>(TableViews.Keys)) { if(TableViews[key].TryGetTarget(out var view)) view.Prepare(); else TableViews.Remove(key); }\n            TableViews.TrimExcess(); _readFailure=null;\n        } catch(Exception error) { _readFailure=error; throw; } finally { _publicationStrings=null; } }\n");
    s.push_str("        void DisposeReadModel() {\n");
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!("            foreach(var value in Live{b}.Values) value?.Publish(null);\n            foreach(var weak in Retired{b}.Values) if(weak.TryGetTarget(out var value)) value.Publish(null);\n            Live{b}=new Dictionary<string,{b}Handle>(StringComparer.Ordinal); Retired{b}=new Dictionary<string,WeakReference<{b}Handle>>(StringComparer.Ordinal); Members{b}=Array.Empty<{b}Handle>();\n"));
    }
    s.push_str("            TableViews=new Dictionary<(string,string),WeakReference<DevcelTableHandle>>(); _publicationStrings=null; _readFailure=null;\n        }\n");
}
fn emit_tables(s: &mut String, model: &CgModel, db: &str) {
    s.push_str(&format!("    public sealed class DevcelTableHandle {{ readonly {db} _db; readonly string _required; int _index=-1, _count; public string Uuid {{ get; }}\n"));
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!(
            "        readonly {b}Collection? _{b}; bool _is{b};\n"
        ));
    }
    s.push_str(&format!("        internal DevcelTableHandle({db} db,string uuid,string required) {{ _db=db; Uuid=uuid; _required=required;\n"));
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!(
            "            if(uuid==\"{}\") _{b}=new {b}Collection(db,this);\n",
            escape(&t.uuid)
        ));
    }
    s.push_str("        }\n        internal void Prepare() { _index=DevcelNative.ResolveRecordTable(_db.Handle,Uuid,_required); _count=_index<0?0:DevcelNative.devcel_rt_row_count(_db.Handle,_index);\n");
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!(
            "            _is{b} = _{b} != null && _index>=0 && _index==_db.{b}.TableIndex;\n"
        ));
    }
    s.push_str("        }\n        public bool Exists { get { lock(_db.ReadGate) { _db.CheckReadModel(); return _index>=0; } } }\n        public int Count { get { lock(_db.ReadGate) { _db.CheckReadModel(); if(_index<0) throw new KeyNotFoundException(\"Referenced table is unavailable\"); return _count; } } }\n");
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!("        public {b}Collection? As{b}() {{ lock(_db.ReadGate) {{ _db.CheckReadModel(); return _is{b} ? _{b} : null; }} }}\n"));
    }
    s.push_str("    }\n");
    for t in &model.tables {
        let b = &t.type_base;
        s.push_str(&format!(r#"    public sealed class {b}Collection : IEnumerable<{b}Handle>
    {{
        readonly {db} _db;
        readonly DevcelTableHandle _constraint;
        internal {b}Collection({db} db,DevcelTableHandle constraint) {{ _db=db; _constraint=constraint; }}
        void Validate() {{ _db.CheckReadModel(); if(!ReferenceEquals(_constraint.As{b}(),this)) throw new KeyNotFoundException("Referenced table or required interface is unavailable"); }}
        public bool Exists {{ get {{ lock(_db.ReadGate) return ReferenceEquals(_constraint.As{b}(),this); }} }}
        public int Count {{ get {{ lock(_db.ReadGate) {{ Validate(); return _db.Members{b}.Length; }} }} }}
        public {b}Handle? ById(string uuid) {{ lock(_db.ReadGate) {{ Validate(); return _db.Get(new {b}Key(uuid)); }} }}
        public {b}Handle this[int index] {{ get {{ lock(_db.ReadGate) {{ Validate(); return _db.Members{b}[index]; }} }} }}
        public {b}Collection All => this;
        public Enumerator GetEnumerator() {{ lock(_db.ReadGate) {{ Validate(); return new Enumerator(this,_db.Members{b}); }} }}
        IEnumerator<{b}Handle> IEnumerable<{b}Handle>.GetEnumerator() => GetEnumerator();
        System.Collections.IEnumerator System.Collections.IEnumerable.GetEnumerator() => GetEnumerator();
        public struct Enumerator : IEnumerator<{b}Handle>
        {{
            readonly {b}Collection _owner; readonly {b}Handle[] _items; int _index;
            internal Enumerator({b}Collection owner,{b}Handle[] items) {{ _owner=owner;_items=items;_index=-1; }}
            public bool MoveNext() {{ lock(_owner._db.ReadGate) {{ _owner.Validate();return ++_index<_items.Length; }} }}
            public {b}Handle Current {{ get {{ lock(_owner._db.ReadGate) {{ _owner.Validate();return _items[_index]; }} }} }}
            object System.Collections.IEnumerator.Current => Current;
            public void Reset() {{ lock(_owner._db.ReadGate) {{ _owner.Validate();_index=-1; }} }}
            public void Dispose() {{ }}
        }}
    }}
"#));
    }
}
