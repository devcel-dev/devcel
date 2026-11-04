/// Devcel schema v1 runtime. GML 2.3+ structs. No extensions/native DLL required.
/// I64/U64 are exact decimal strings. Colors retain straight-alpha/HDR channels.
function __devcel_require(_test, _message) { if (!_test) throw _message; }
function __devcel_field(_object, _name, _fallback) {
    return is_struct(_object) && variable_struct_exists(_object, _name) ? variable_struct_get(_object, _name) : _fallback;
}
function __devcel_name(_v) { return is_string(_v) && string_length(_v) > 0; }
function __devcel_finite(_v) { return is_real(_v) && !is_nan(_v) && !is_infinity(_v); }
function __devcel_whole(_v) { return __devcel_finite(_v) && floor(_v) == _v; }
function __devcel_copy(_v) {
    if (is_array(_v)) {
        var _a = []; for (var _i = 0; _i < array_length(_v); ++_i) _a[_i] = __devcel_copy(_v[_i]); return _a;
    }
    if (is_struct(_v)) {
        var _s = {}, _keys = variable_struct_get_names(_v);
        for (var _i = 0; _i < array_length(_keys); ++_i) variable_struct_set(_s, _keys[_i], __devcel_copy(variable_struct_get(_v, _keys[_i])));
        return _s;
    }
    return _v;
}
function __devcel_integer(_raw) {
    var _s = string_trim(_raw); if (_s == "") _s = "0";
    var _negative = string_char_at(_s, 1) == "-";
    if (_negative || string_char_at(_s, 1) == "+") _s = string_delete(_s, 1, 1);
    __devcel_require(_s != "", "Invalid integer");
    for (var _i = 1; _i <= string_length(_s); ++_i) {
        var _c = ord(string_char_at(_s, _i)); __devcel_require(_c >= 48 && _c <= 57, "Invalid integer");
    }
    while (string_length(_s) > 1 && string_char_at(_s, 1) == "0") _s = string_delete(_s, 1, 1);
    return (_negative && _s != "0" ? "-" : "") + _s;
}
function __devcel_compare_integer(_a, _b) {
    var _an = string_char_at(_a, 1) == "-", _bn = string_char_at(_b, 1) == "-";
    if (_an != _bn) return _an ? -1 : 1;
    if (_an) _a = string_delete(_a, 1, 1); if (_bn) _b = string_delete(_b, 1, 1);
    var _sign = _an ? -1 : 1;
    if (string_length(_a) != string_length(_b)) return string_length(_a) < string_length(_b) ? -_sign : _sign;
    if (_a == _b) return 0; return _a < _b ? -_sign : _sign;
}
function __devcel_number(_raw) {
    var _s = string_lower(string_trim(_raw)); if (_s == "") _s = "0";
    var _p = 1, _length = string_length(_s), _digits = 0;
    if (string_char_at(_s, _p) == "+" || string_char_at(_s, _p) == "-") ++_p;
    while (_p <= _length && string_pos(string_char_at(_s, _p), "0123456789") > 0) { ++_p; ++_digits; }
    if (string_char_at(_s, _p) == ".") {
        ++_p; while (_p <= _length && string_pos(string_char_at(_s, _p), "0123456789") > 0) { ++_p; ++_digits; }
    }
    __devcel_require(_digits > 0, "Invalid decimal");
    if (string_char_at(_s, _p) == "e") {
        ++_p; if (string_char_at(_s, _p) == "+" || string_char_at(_s, _p) == "-") ++_p;
        _digits = 0;
        while (_p <= _length && string_pos(string_char_at(_s, _p), "0123456789") > 0) { ++_p; ++_digits; }
        __devcel_require(_digits > 0, "Invalid exponent");
    }
    __devcel_require(_p > _length, "Invalid decimal suffix");
    var _n = real(_s); __devcel_require(__devcel_finite(_n), "Finite decimal required"); return _n;
}
function __devcel_loopback_url(_url) {
    if (!is_string(_url) || string_pos("http://127.0.0.1:",_url) != 1) return false;
    var _tail = string_delete(_url,1,string_length("http://127.0.0.1:"));
    var _split = string_split(_tail,"/runtime/"); if (array_length(_split) != 2) return false;
    var _port = _split[0]; if (_port == "") return false;
    for (var _i = 1; _i <= string_length(_port); ++_i) if (string_pos(string_char_at(_port,_i),"0123456789") == 0) return false;
    if (real(_port) < 1 || real(_port) > 65535) return false;
    var _parts = string_split(_split[1],"?token="); if (array_length(_parts) != 2) return false;
    for (var _i = 0; _i < 2; ++_i) {
        if (_parts[_i] == "") return false;
        for (var _j = 1; _j <= string_length(_parts[_i]); ++_j) {
            if (string_pos(string_char_at(_parts[_i],_j),"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") == 0) return false;
        }
    }
    return true;
}
function __devcel_limits() {
    static _limits = {U8:["0","255"], I8:["-128","127"], U16:["0","65535"], I16:["-32768","32767"],
        U32:["0","4294967295"], I32:["-2147483648","2147483647"],
        I64:["-9223372036854775808","9223372036854775807"], U64:["0","18446744073709551615"]};
    return _limits;
}
function __devcel_default(_type) {
    if (_type == "Color32") return "[255,255,255,255]";
    if (_type == "ColorFloat") return "[1,1,1,1]"; return "";
}
function __devcel_decode(_raw, _column) {
    __devcel_require(is_string(_raw), "Canonical cells must be strings");
    var _type = _column.data_type, _limits = __devcel_limits(), _value = _raw;
    if (variable_struct_exists(_limits, _type)) {
        _raw = __devcel_integer(_raw); var _range = variable_struct_get(_limits, _type);
        __devcel_require(__devcel_compare_integer(_raw, _range[0]) >= 0 && __devcel_compare_integer(_raw, _range[1]) <= 0, "Integer outside " + _type + " range");
        _value = (_type == "I64" || _type == "U64") ? _raw : real(_raw);
    } else switch (_type) {
        case "F32": case "F64":
            _value = __devcel_number(_raw);
            __devcel_require(_type != "F32" || abs(_value) <= 3.4028234663852886e38, "F32 overflow"); break;
        case "Boolean":
            _raw = string_lower(string_trim(_raw)); if (_raw == "") _raw = "false";
            __devcel_require(_raw == "true" || _raw == "false", "Boolean requires true/false"); _value = _raw == "true"; break;
        case "Color32": case "ColorFloat":
            var _channels = json_parse(_raw);
            __devcel_require(is_array(_channels) && array_length(_channels) == 4, "Color requires four channels");
            if (_type == "Color32") {
                // Check integer tokens too: [1.0,...] and [1e0,...] are not Color32 wire values.
                var _tokens = string_split(string_replace_all(string_replace_all(_raw, "[", ""), "]", ""), ",");
                __devcel_require(array_length(_tokens) == 4, "Color32 requires four unsigned JSON integers");
                for (var _j = 0; _j < 4; ++_j) {
                    var _token = string_trim(_tokens[_j]);
                    __devcel_require(_token != "", "Empty Color32 channel");
                    for (var _k = 1; _k <= string_length(_token); ++_k) {
                        var _c = ord(string_char_at(_token, _k)); __devcel_require(_c >= 48 && _c <= 57, "Color32 requires unsigned integer tokens");
                    }
                }
            }
            for (var _j = 0; _j < 4; ++_j) {
                var _v = _channels[_j]; __devcel_require(__devcel_finite(_v) && !is_bool(_v), "Finite numeric color channel required");
                if (_type == "Color32") __devcel_require(floor(_v) == _v && _v >= 0 && _v <= 255, "Color32 outside 0..255");
                else { __devcel_require(abs(_v) <= 3.4028234663852886e38, "ColorFloat overflow"); if (_j == 3) __devcel_require(_v >= 0 && _v <= 1, "Alpha outside 0..1"); }
            }
            _value = {r:_channels[0], g:_channels[1], b:_channels[2], a:_channels[3]}; break;
        case "Curve":
            if (_raw == "") {
                var _cfg = __devcel_field(_column, "curve_config", {});
                _value = {points:[], start_value:__devcel_field(_cfg,"start_value",0), end_value:__devcel_field(_cfg,"end_value",1)};
            } else {
                _value = json_parse(_raw); __devcel_require(is_struct(_value) && is_array(__devcel_field(_value,"points",undefined)), "Curve.points required");
                for (var _j = 0; _j < array_length(_value.points); ++_j) {
                    var _p = _value.points[_j]; __devcel_require(is_struct(_p) && __devcel_finite(__devcel_field(_p,"x",undefined)) && __devcel_finite(__devcel_field(_p,"y",undefined)), "Invalid curve point");
                }
            } break;
        case "None": case "String": case "Select": case "DateTime": case "Reference": case "TableRef": break;
        default: throw "Unknown data_type: " + string(_type);
    }
    return {raw:_raw, value:_value};
}
function __devcel_parse(_text) {
    var _b = json_parse(_text), _m = __devcel_field(_b,"manifest",undefined);
    __devcel_require(is_struct(_b) && is_struct(_m) && is_array(__devcel_field(_b,"tables",undefined)), "manifest/tables required");
    __devcel_require(__devcel_field(_m,"schema_version",0) == 1, "schema_version 1 required");
    __devcel_require(__devcel_name(__devcel_field(_m,"content_hash",undefined)) && __devcel_name(__devcel_field(_m,"generated_at",undefined)), "Invalid manifest");
    var _revision = __devcel_field(_m,"data_revision",undefined), _version = __devcel_field(_m,"content_version",undefined);
    __devcel_require(__devcel_whole(_revision) && _revision >= 0, "Invalid data_revision");
    __devcel_require(is_undefined(_version) || (__devcel_whole(_version) && _version >= 0 && _version <= 4294967295), "Invalid content_version");
    __devcel_require(__devcel_field(_m,"mode","") == "full" || __devcel_field(_m,"mode","") == "minimal", "Invalid export mode");
    __devcel_require(is_string(__devcel_field(_b,"project_name",undefined)), "project_name must be a string");
    var _s = {manifest:_m,project_name:_b.project_name,tables:{},by_uuid:{},names:[]};
    var _types = ["None","String","Select","DateTime","Reference","TableRef","U8","I8","U16","I16","U32","I32","I64","U64","F32","F64","Boolean","Color32","ColorFloat","Curve"];
    for (var _i = 0; _i < array_length(_b.tables); ++_i) {
        var _source = _b.tables[_i];
        __devcel_require(__devcel_name(__devcel_field(_source,"name",undefined)) && __devcel_name(__devcel_field(_source,"uuid",undefined)), "Table name/uuid required");
        __devcel_require(!variable_struct_exists(_s.tables,_source.name) && !variable_struct_exists(_s.by_uuid,_source.uuid), "Duplicate table name/uuid");
        __devcel_require(is_array(__devcel_field(_source,"columns",undefined)) && is_array(__devcel_field(_source,"records",undefined)), "columns/records must be arrays");
        var _t = {name:_source.name,uuid:_source.uuid,interfaces:__devcel_field(_source,"interfaces",[]),columns:{},column_order:[],records:{},ids:[]};
        __devcel_require(is_array(_t.interfaces),"interfaces must be an array");
        for (var _j = 0; _j < array_length(_t.interfaces); ++_j) __devcel_require(__devcel_name(_t.interfaces[_j]),"Invalid interface UUID");
        var _plans = [];
        for (var _j = 0; _j < array_length(_source.columns); ++_j) {
            var _col = _source.columns[_j];
            __devcel_require(__devcel_name(__devcel_field(_col,"name",undefined)) && !variable_struct_exists(_t.columns,_col.name), "Invalid/duplicate column");
            var _kind = __devcel_field(_col,"data_type","");
            var _known = false; for (var _k = 0; _k < array_length(_types); ++_k) if (_types[_k] == _kind) _known = true;
            __devcel_require(_known,"Unknown data_type: " + _kind);
            var _configs = ["reference_config","table_ref_config","curve_config"];
            for (var _k = 0; _k < 3; ++_k) {
                var _cfg = __devcel_field(_col,_configs[_k],undefined);
                __devcel_require(is_undefined(_cfg) || is_struct(_cfg), "Invalid " + _configs[_k]);
            }
            var _default = __devcel_field(_col,"default_value",undefined);
            var _ready = !is_undefined(_default), _decoded_default = undefined;
            if (_ready) _decoded_default = __devcel_decode(_default,_col);
            else _default = __devcel_default(_col.data_type);
            array_push(_plans, {name:_col.name,column:_col,raw:_default,ready:_ready,decoded:_decoded_default});
            variable_struct_set(_t.columns,_col.name,_col); array_push(_t.column_order,_col.name);
        }
        for (var _j = 0; _j < array_length(_source.records); ++_j) {
            var _record = _source.records[_j], _values = __devcel_field(_record,"values",undefined);
            __devcel_require(__devcel_name(__devcel_field(_record,"id",undefined)) && !variable_struct_exists(_t.records,_record.id), "Invalid/duplicate record id");
            __devcel_require(is_struct(_values),"record.values must be an object");
            var _keys = variable_struct_get_names(_values);
            for (var _k = 0; _k < array_length(_keys); ++_k) {
                __devcel_require(variable_struct_exists(_t.columns,_keys[_k]),"Unknown column in record.values: " + _keys[_k]);
                __devcel_require(is_string(variable_struct_get(_values,_keys[_k])),"Canonical cells must be strings");
            }
            var _row = {id:_record.id,raw:{},typed:{}};
            for (var _k = 0; _k < array_length(_t.column_order); ++_k) {
                var _plan = _plans[_k], _name = _plan.name, _decoded;
                var _raw = __devcel_field(_values,_name,undefined);
                if (!is_undefined(_raw) && _raw != _plan.raw) {
                    _decoded = __devcel_decode(_raw,_plan.column);
                } else {
                    if (!_plan.ready) { _plan.decoded = __devcel_decode(_plan.raw,_plan.column); _plan.ready = true; }
                    _decoded = __devcel_copy(_plan.decoded);
                }
                // Color/Curve structs and arrays remain independently owned by each row.
                variable_struct_set(_row.raw,_name,_decoded.raw); variable_struct_set(_row.typed,_name,_decoded.value);
            }
            variable_struct_set(_t.records,_row.id,_row); array_push(_t.ids,_row.id);
        }
        variable_struct_set(_s.tables,_t.name,_t); variable_struct_set(_s.by_uuid,_t.uuid,_t); array_push(_s.names,_t.name);
    }
    return _s;
}
function DevcelRow(_snapshot, _table, _record) constructor {
    __snapshot = _snapshot; __table = _table; __record = _record;
    static id = function() { return __record.id; };
    static get_raw = function(_column) { return __devcel_field(__record.raw,_column,undefined); };
    static get = function(_column) { return __devcel_copy(__devcel_field(__record.typed,_column,undefined)); };
    static reference = function(_column) {
        var _c = __devcel_field(__table.columns,_column,undefined);
        __devcel_require(is_struct(_c) && _c.data_type == "Reference","Reference column required");
        var _cfg = __devcel_field(_c,"reference_config",{});
        var _t = __devcel_field(__snapshot.by_uuid,__devcel_field(_cfg,"target_table_uuid",""),undefined);
        if (is_undefined(_t)) return undefined;
        var _r = __devcel_field(_t.records,get_raw(_column),undefined);
        return is_undefined(_r) ? undefined : new DevcelRow(__snapshot,_t,_r);
    };
    static table_reference = function(_column) {
        var _c = __devcel_field(__table.columns,_column,undefined);
        __devcel_require(is_struct(_c) && _c.data_type == "TableRef","TableRef column required");
        var _t = __devcel_field(__snapshot.by_uuid,get_raw(_column),undefined); if (is_undefined(_t)) return undefined;
        var _required = __devcel_field(__devcel_field(_c,"table_ref_config",{}),"interface_uuid","");
        if (_required != "") {
            var _found = false; for (var _i = 0; _i < array_length(_t.interfaces); ++_i) if (_t.interfaces[_i] == _required) _found = true;
            if (!_found) return undefined;
        }
        return new DevcelTable(__snapshot,_t);
    };
}
function DevcelTable(_snapshot, _table) constructor {
    __snapshot = _snapshot; __table = _table;
    static name = function() { return __table.name; };
    static uuid = function() { return __table.uuid; };
    static count = function() { return array_length(__table.ids); };
    static ids = function() { return __devcel_copy(__table.ids); };
    static columns = function() { return __devcel_copy(__table.column_order); };
    static column_info = function(_column) { return __devcel_copy(__devcel_field(__table.columns,_column,undefined)); };
    static by_id = function(_id) {
        var _r = __devcel_field(__table.records,_id,undefined); return is_undefined(_r) ? undefined : new DevcelRow(__snapshot,__table,_r);
    };
    static at = function(_index) { return _index >= 0 && _index < count() ? by_id(__table.ids[_index]) : undefined; };
}
function DevcelDatabase(_source_id = "default") constructor {
    source_id = _source_id; last_error = ""; __snapshot = undefined; __bytes = undefined; __path = "";
    __live_url = ""; __request = -1; __elapsed = 0; __interval = 1; __request_age = 0;
    static load_json = function(_text) {
        try { var _candidate = __devcel_parse(_text); __snapshot = _candidate; __bytes = _text; __path = ""; last_error = ""; return true; }
        catch (_e) { last_error = string(_e); return false; }
    };
    static load_file = function(_path) {
        var _buffer = buffer_load(_path); if (_buffer < 0) { last_error = "Cannot read: " + _path; return false; }
        var _text;
        try {
            // buffer_string expects a NUL terminator. Grow by one without changing file bytes.
            var _size = buffer_get_size(_buffer); buffer_resize(_buffer,_size + 1); buffer_poke(_buffer,_size,buffer_u8,0);
            _text = buffer_peek(_buffer,0,buffer_string);
        } catch (_e) { buffer_delete(_buffer); last_error = string(_e); return false; }
        buffer_delete(_buffer);
        if (_text == __bytes) { __path = _path; last_error = ""; return true; }
        if (!load_json(_text)) return false; __path = _path; return true;
    };
    static reload_if_changed = function() {
        if (__path == "") { last_error = "load_file first"; return {ok:false,changed:false}; }
        var _old = __bytes, _ok = load_file(__path); return {ok:_ok,changed:_ok && _old != __bytes};
    };
    static table = function(_name) {
        if (is_undefined(__snapshot)) return undefined;
        var _t = __devcel_field(__snapshot.tables,_name,undefined); return is_undefined(_t) ? undefined : new DevcelTable(__snapshot,_t);
    };
    static table_by_uuid = function(_uuid) {
        if (is_undefined(__snapshot)) return undefined;
        var _t = __devcel_field(__snapshot.by_uuid,_uuid,undefined); return is_undefined(_t) ? undefined : new DevcelTable(__snapshot,_t);
    };
    static by_id = function(_table_name,_id) { var _t = table(_table_name); return is_undefined(_t) ? undefined : _t.by_id(_id); };
    static tables = function() { return is_undefined(__snapshot) ? [] : __devcel_copy(__snapshot.names); };
    static manifest = function() { return is_undefined(__snapshot) ? undefined : __devcel_copy(__snapshot.manifest); };
    static project_name = function() { return is_undefined(__snapshot) ? "" : __snapshot.project_name; };
    static watch_http = function(_url,_interval = 1) {
        __devcel_require(debug_mode,"Live polling is only enabled in Debug runs");
        __devcel_require(__devcel_loopback_url(_url),"Paste the loopback runtime URL from importer UI");
        __devcel_require(__devcel_finite(_interval) && _interval >= 0.25,"Interval must be >= 0.25 seconds");
        stop_watch(); __live_url = _url; __interval = _interval;
    };
    static stop_watch = function() { __live_url = ""; __request = -1; __elapsed = 0; __request_age = 0; };
    /// Call from the controller Step event: db.update(delta_time / 1000000).
    static update = function(_dt) {
        if (__live_url == "") return;
        __elapsed += _dt;
        if (__request >= 0) {
            __request_age += _dt; if (__request_age < 10) return;
            __request = -1; last_error = "Devcel live request timed out";
        }
        if (__elapsed < __interval) return;
        __elapsed = 0; __request_age = 0; __request = http_get(__live_url);
        if (__request < 0) last_error = "Cannot start Devcel live request";
    };
    /// Forward the controller's Async HTTP event: db.handle_http(async_load).
    /// Request ids isolate multiple sources and reject delayed callbacks after stop/reconfigure.
    static handle_http = function(_event) {
        if (__request < 0 || _event[? "id"] != __request) return {handled:false,changed:false};
        if (_event[? "status"] > 0) return {handled:true,changed:false};
        __request = -1;
        if (_event[? "status"] < 0 || !ds_map_exists(_event,"http_status") || _event[? "http_status"] != 200) {
            last_error = "Devcel live request failed"; return {handled:true,changed:false};
        }
        var _text = _event[? "result"];
        if (_text == __bytes) { last_error = ""; return {handled:true,changed:false}; }
        var _ok = load_json(_text); return {handled:true,changed:_ok};
    };
}
