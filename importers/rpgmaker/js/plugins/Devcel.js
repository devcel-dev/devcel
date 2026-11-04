/*:
 * @target MZ
 * @plugindesc Devcel MV/MZ: Load, configure, and reimport standalone game data
 * @author Devcel
 * @param IndexFile
 * @text Data index JSON
 * @type string
 * @default data/devcel/index.json
 * @param ImporterKey
 * @text Enable F6 during playtest
 * @type boolean
 * @default true
 * @command OpenImporter
 * @text Open Devcel Import settings
 * @desc Desktop playtest only. Reimports from a saved project.
 * @command Reimport
 * @text Devcel Reimport
 * @arg SourceId
 * @text Configuration ID (blank for all)
 * @type string
 * @default
 * @help
 * For both MV and MZ. Place Devcel.js and the devcel folder in js/plugins.
 * Open settings with F6 during playtest, an MZ plugin command, or
 * the MV command "Devcel OpenImporter".
 * MV reimport: Devcel Reimport base
 * Devcel.source("base").table("Heroes").byId("UUID").get("hp")
 * Restart the playtest after reimporting. Data is not reloaded automatically.
 * Standard RPG Maker databases such as Actors.json and Items.json are not modified.
 * I64/U64 values are exact decimal strings. ColorFloat preserves HDR and straight alpha.
 * Do not rename this plugin file, Devcel.js.
 */
(function(root, factory) {
    "use strict";
    var api = factory();
    if (typeof module !== "undefined" && module.exports) module.exports = api;
    if (root && root.PluginManager && root.DataManager) {
        root.Devcel = api;
        install(root, api);
    }
    function install(global, Devcel) {
        var params = global.PluginManager.parameters("Devcel");
        var indexFile = params.IndexFile || "data/devcel/index.json";
        if (!/^data\/devcel\/[A-Za-z0-9_./-]+\.json$/.test(indexFile) || indexFile.split("/").some(function(p) { return p === ".." || p === "." || p === ""; })) throw new Error("Devcel: The data index must be a JSON file under data/devcel");
        var bootStarted = false, bootReady = false, bootError = null;
        function request(url) {
            return new Promise(function(resolve, reject) {
                var xhr = new XMLHttpRequest();
                xhr.open("GET", url);
                xhr.overrideMimeType("application/json");
                xhr.onload = function() {
                    if (xhr.status >= 400) { reject(new Error("Devcel: Failed to load " + url + " (" + xhr.status + ")")); return; }
                    try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(new Error("Devcel: Invalid JSON " + url + ": " + e.message)); }
                };
                xhr.onerror = function() { reject(new Error("Devcel: Failed to load " + url)); };
                xhr.send();
            });
        }
        function testplay() { return global.Utils && global.Utils.isNwjs() && global.Utils.isOptionValid("test"); }
        var originalLoad = global.DataManager.loadDatabase;
        global.DataManager.loadDatabase = function() {
            originalLoad.apply(this, arguments);
            if (bootStarted) return;
            bootStarted = true;
            // First installation has no index yet. Only a desktop test-play may start empty.
            request(indexFile).catch(function(error) {
                if (testplay()) {
                    var path = require("path"), fs = require("fs");
                    if (!fs.existsSync(path.join(path.dirname(process.mainModule.filename), indexFile))) return {schema_version:1,sources:[]};
                }
                throw error;
            }).then(function(index) {
                Devcel.validateIndex(index);
                return Promise.all(index.sources.map(function(source) {
                    return request(source.runtime_file).then(function(bundle) { return {source: source, database: new Devcel.Database(bundle)}; });
                }));
            }).then(function(loaded) {
                Devcel.replaceSources(loaded);
                bootReady = true;
            }).catch(function(error) { bootError = error; });
        };
        var originalReady = global.DataManager.isDatabaseLoaded;
        global.DataManager.isDatabaseLoaded = function() {
            if (bootError) throw bootError;
            return originalReady.apply(this, arguments) && bootReady;
        };
        var editor = null;
        function getEditor() {
            if (!testplay()) throw new Error("Devcel Import settings are available only in desktop playtest");
            if (!editor) {
                var path = require("path");
                var gameRoot = path.dirname(process.mainModule.filename);
                editor = require(path.join(gameRoot, "js/plugins/devcel/editor.js")).create(gameRoot, indexFile);
            }
            return editor;
        }
        Devcel.openImporter = function() { return getEditor().openWindow(); };
        Devcel.reimport = function(id) { return getEditor().pull(id || null); };
        function report(error) { global.alert("Devcel: " + error.message); }
        if (global.PluginManager.registerCommand) {
            global.PluginManager.registerCommand("Devcel", "OpenImporter", function() { try { Devcel.openImporter(); } catch (e) { report(e); } });
            global.PluginManager.registerCommand("Devcel", "Reimport", function(args) { try { Devcel.reimport(args.SourceId).then(function() { global.alert("Reimport completed. Restart the playtest."); }, report); } catch (e) { report(e); } });
        }
        if (global.Game_Interpreter) {
            var originalCommand = global.Game_Interpreter.prototype.pluginCommand;
            global.Game_Interpreter.prototype.pluginCommand = function(command, args) {
                originalCommand.apply(this, arguments);
                if (command !== "Devcel") return;
                try {
                    if (args[0] === "OpenImporter") Devcel.openImporter();
                    else if (args[0] === "Reimport") Devcel.reimport(args[1]).then(function() { global.alert("Reimport completed. Restart the playtest."); }, report);
                } catch (e) { report(e); }
            };
        }
        if (params.ImporterKey !== "false" && testplay()) {
            global.addEventListener("keydown", function(event) {
                if (event.keyCode === 117 && !event.repeat) { event.preventDefault(); try { Devcel.openImporter(); } catch (e) { report(e); } }
            });
        }
    }
})(typeof window !== "undefined" ? window : null, function() {
    "use strict";
    var owns = function(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); };
    var dictionary = function() { return Object.create(null); };
    function assert(condition, message) { if (!condition) throw new Error("Devcel: " + message); }
    function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v); }
    function name(v) { return typeof v === "string" && v.length > 0; }
    function finite(v) { return typeof v === "number" && isFinite(v); }
    function integer(v) { return finite(v) && Math.floor(v) === v; }
    function clone(v) { return JSON.parse(JSON.stringify(v)); }
    function freeze(v) { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.keys(v).forEach(function(k) { freeze(v[k]); }); Object.freeze(v); } return v; }
    var limits = {U8:["0","255"],I8:["-128","127"],U16:["0","65535"],I16:["-32768","32767"],U32:["0","4294967295"],I32:["-2147483648","2147483647"],U64:["0","18446744073709551615"],I64:["-9223372036854775808","9223372036854775807"]};
    var textTypes = ["None", "String", "Select", "DateTime", "Reference", "TableRef"];
    function compare(a, b) {
        var an = a[0] === "-", bn = b[0] === "-";
        if (an !== bn) return an ? -1 : 1;
        var x = an ? a.slice(1) : a, y = bn ? b.slice(1) : b, sign = an ? -1 : 1;
        if (x.length !== y.length) return sign * (x.length < y.length ? -1 : 1);
        return x === y ? 0 : sign * (x < y ? -1 : 1);
    }
    function decimal(raw) {
        assert(/^[+-]?\d+$/.test(raw), "An integer is required: " + raw);
        var negative = raw[0] === "-";
        var digits = raw.replace(/^[+-]/, "").replace(/^0+(?=\d)/, "");
        return negative && digits !== "0" ? "-" + digits : digits;
    }
    var float32Storage = new Float32Array(1);
    function float32(v) { float32Storage[0] = v; assert(finite(float32Storage[0]), "Outside the F32 range"); return float32Storage[0]; }
    function defaultValue(type) { return type === "Color32" ? "[255,255,255,255]" : type === "ColorFloat" ? "[1,1,1,1]" : ""; }
    function decode(raw, column) {
        var type = column.data_type, v, channels;
        if (owns(limits, type)) {
            v = decimal(raw === "" ? "0" : raw.trim());
            assert(compare(v, limits[type][0]) >= 0 && compare(v, limits[type][1]) <= 0, type + ": value is out of range: " + raw);
            // MV's older JavaScript engines do not support BigInt. Never round wide integers.
            return type === "I64" || type === "U64" ? v : Number(v);
        }
        if (type === "F32" || type === "F64") {
            v = raw === "" ? "0" : raw.trim();
            assert(/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(v) && finite(Number(v)), "A finite number is required: " + raw);
            return type === "F32" ? float32(Number(v)) : Number(v);
        }
        if (type === "Boolean") {
            v = raw === "" ? "false" : raw.trim().toLowerCase();
            assert(v === "true" || v === "false", "Boolean must be true or false");
            return v === "true";
        }
        if (type === "Color32" || type === "ColorFloat") {
            if (type === "Color32") assert(/^\s*\[\s*(?:0|[1-9]\d*)\s*,\s*(?:0|[1-9]\d*)\s*,\s*(?:0|[1-9]\d*)\s*,\s*(?:0|[1-9]\d*)\s*\]\s*$/.test(raw), "Color32 requires four integer components");
            channels = JSON.parse(raw);
            assert(Array.isArray(channels) && channels.length === 4, type + " requires four components");
            channels = channels.map(function(c, index) {
                assert(finite(c), type + " components must be finite numbers");
                if (type === "Color32") { assert(integer(c) && c >= 0 && c <= 255, "Color32 components must be in 0..255"); return c; }
                assert(index !== 3 || (c >= 0 && c <= 1), "alpha must be in 0..1");
                return float32(c);
            });
            return freeze({r:channels[0],g:channels[1],b:channels[2],a:channels[3]});
        }
        if (type === "Curve") return new Curve(raw, column.curve_config || {});
        assert(textTypes.indexOf(type) >= 0, "Unknown data_type: " + type);
        return raw;
    }
    function Curve(raw, config) {
        var configured = Object.keys(config).length > 0;
        if (configured) assert(finite(config.start_value) && finite(config.end_value), "Both curve_config endpoints must be finite numbers");
        var data = raw === "" ? {points:[{x:0,y:configured ? config.start_value : 0,mode:"auto"},{x:1,y:configured ? config.end_value : 1,mode:"auto"}]} : JSON.parse(raw);
        assert(object(data) && Array.isArray(data.points) && data.points.length >= 2, "Curve.points requires at least two points");
        var previous = -1;
        data.points.forEach(function(p) {
            assert(object(p) && finite(p.x) && finite(p.y) && p.x >= 0 && p.x <= 1 && p.x > previous, "Curve x values must be ascending in 0..1");
            assert(["constant","linear","auto","autoLength","free"].indexOf(p.mode) >= 0, "Invalid Curve mode");
            ["outSlope","inSlope","outLen","inLen"].forEach(function(k) { if (owns(p,k)) assert(finite(p[k]), "Curve tangents must be finite numbers"); });
            ["outLen","inLen"].forEach(function(k) { if (owns(p,k)) assert(p[k] >= 0 && p[k] <= 3, "Curve lengths must be in 0..3"); });
            previous = p.x;
        });
        assert(data.points[0].x === 0 && data.points[data.points.length - 1].x === 1, "Curve endpoint x values must be 0 and 1");
        if (configured) { data.points[0].y = config.start_value; data.points[data.points.length - 1].y = config.end_value; }
        this.points = freeze(data.points);
        Object.freeze(this);
    }
    Curve.prototype.sample = function(x) {
        assert(finite(x), "Curve.sample x must be a finite number");
        var p = this.points, i = 0;
        if (x <= 0) return p[0].y;
        if (x >= 1) return p[p.length-1].y;
        while (i < p.length-2 && p[i+1].x <= x) i++;
        var a = p[i], b = p[i+1];
        if (a.mode === "constant" || x === a.x) return a.y;
        function handle(index, out) {
            var q = p[index], prefix = out ? "out" : "in";
            if (q.mode === "constant") return [0,1];
            if (q.mode === "linear") { var other = p[index + (out ? 1 : -1)]; return [(other.y-q.y)/(other.x-q.x),1]; }
            var left = p[Math.max(0,index-1)], right = p[Math.min(p.length-1,index+1)];
            var slope = (right.y-left.y)/Math.max(1e-9,right.x-left.x);
            return [q.mode === "free" && owns(q,prefix+"Slope") ? q[prefix+"Slope"] : slope, owns(q,prefix+"Len") ? q[prefix+"Len"] : 1];
        }
        function bezier(w,z,y,v,t) { var u=1-t; return u*u*u*w+3*u*u*t*z+3*u*t*t*y+t*t*t*v; }
        var out = handle(i,true), incoming = handle(i+1,false), span=(b.x-a.x)/3;
        var cx1=a.x+span*out[1],cy1=a.y+span*out[1]*out[0],cx2=b.x-span*incoming[1],cy2=b.y-span*incoming[1]*incoming[0];
        var low=0,high=1,middle=0;
        for (var n=0;n<40;n++) { middle=(low+high)*0.5; var at=bezier(a.x,cx1,cx2,b.x,middle); if (at===x) return bezier(a.y,cy1,cy2,b.y,middle); if(at<x) low=middle; else high=middle; }
        return bezier(a.y,cy1,cy2,b.y,(low+high)*0.5);
    };
    function Database(bundle) { this._snapshot = parse(bundle); }
    Database.prototype.load = function(bundle) { var next=parse(bundle); this._snapshot=next; return this; };
    Database.prototype.manifest = function() { return this._snapshot.manifest; };
    Database.prototype.projectName = function() { return this._snapshot.projectName; };
    Database.prototype.tables = function() { return this._snapshot.order.slice(); };
    Database.prototype.table = function(key) { var s=this._snapshot; return owns(s.tables,key) ? new Table(s,s.tables[key]) : null; };
    Database.prototype.tableByUuid = function(uuid) { var s=this._snapshot; return owns(s.uuids,uuid) ? new Table(s,s.uuids[uuid]) : null; };
    // Candidate-local bounded cache: decoded Color/Curve objects are deeply frozen.
    // No BigInt/Map/new syntax is needed by MV's older runtime.
    function columnDecoder(column) {
        if (textTypes.indexOf(column.data_type) >= 0) return function(raw) { return raw; };
        var cache = dictionary(), count = 0;
        return function(raw) {
            if (owns(cache, raw)) return cache[raw];
            var value = decode(raw, column);
            if (count < 256) { cache[raw] = value; count++; }
            return value;
        };
    }
    function parse(input) {
        var b = typeof input === "string" ? JSON.parse(input) : clone(input);
        assert(object(b) && object(b.manifest) && Array.isArray(b.tables), "manifest/tables are required");
        var m = b.manifest;
        assert(m.schema_version === 1 && name(m.content_hash) && integer(m.data_revision) && m.data_revision >= 0 && name(m.generated_at), "A schema v1 manifest is required");
        assert(m.mode === "full" || m.mode === "minimal", "mode must be full or minimal");
        assert(m.content_version === undefined || m.content_version === null || (integer(m.content_version) && m.content_version >= 0 && m.content_version <= 4294967295), "content_version must be u32");
        assert(typeof b.project_name === "string", "project_name must be a string");
        var s={manifest:freeze(m),projectName:b.project_name,tables:dictionary(),uuids:dictionary(),order:[]};
        b.tables.forEach(function(t) {
            assert(object(t) && name(t.name) && name(t.uuid) && !owns(s.tables,t.name) && !owns(s.uuids,t.uuid), "Invalid or duplicate table name/UUID");
            assert(Array.isArray(t.columns) && Array.isArray(t.records), "columns/records arrays are required");
            assert(t.interfaces === undefined || (Array.isArray(t.interfaces) && t.interfaces.every(name)), "Invalid interfaces array");
            var table={name:t.name,uuid:t.uuid,interfaces:t.interfaces||[],columns:dictionary(),columnOrder:[],records:dictionary(),order:[]};
            var plans = [];
            t.columns.forEach(function(c) {
                assert(object(c) && name(c.name) && !owns(table.columns,c.name), "Invalid or duplicate column name");
                assert(owns(limits,c.data_type) || textTypes.indexOf(c.data_type)>=0 || ["F32","F64","Boolean","Color32","ColorFloat","Curve"].indexOf(c.data_type)>=0, "Unknown type: "+c.data_type);
                assert(c.default_value === undefined || c.default_value === null || typeof c.default_value === "string", "default_value must be a string");
                ["reference_config","table_ref_config","curve_config"].forEach(function(k) { assert(c[k] === undefined || c[k] === null || object(c[k]), k+" must be an object"); });
                if(c.reference_config) assert(c.reference_config.target_table_uuid === undefined || typeof c.reference_config.target_table_uuid === "string", "target_table_uuid must be a string");
                if(c.table_ref_config) assert(c.table_ref_config.interface_uuid === undefined || typeof c.table_ref_config.interface_uuid === "string", "interface_uuid must be a string");
                if(c.curve_config) new Curve("",c.curve_config);
                var decodeCell = columnDecoder(c);
                if(c.default_value !== undefined && c.default_value !== null) decodeCell(c.default_value);
                plans.push({name:c.name, raw:c.default_value === undefined || c.default_value === null ? defaultValue(c.data_type) : c.default_value, decode:decodeCell});
                table.columns[c.name]=freeze(c); table.columnOrder.push(c.name);
            });
            t.records.forEach(function(r) {
                assert(object(r) && name(r.id) && !owns(table.records,r.id) && object(r.values), "Invalid or duplicate record ID/values");
                Object.keys(r.values).forEach(function(k) { assert(owns(table.columns,k) && typeof r.values[k] === "string", "Unknown column or non-string cell: "+k); });
                var row={raw:dictionary(),typed:dictionary()};
                plans.forEach(function(plan) {
                    var k=plan.name, raw=owns(r.values,k) ? r.values[k] : plan.raw;
                    row.raw[k]=raw;
                    try { row.typed[k]=plan.decode(raw); } catch(e) { throw new Error(t.name+"/"+r.id+"/"+k+": "+e.message); }
                });
                // Values are primitives or already deeply frozen decoder results.
                Object.freeze(row.raw); Object.freeze(row.typed);
                table.records[r.id]=Object.freeze(row); table.order.push(r.id);
            });
            s.tables[t.name]=table; s.uuids[t.uuid]=table; s.order.push(t.name);
        });
        return freeze(s);
    }
    function Table(snapshot,data) { this._snapshot=snapshot; this._data=data; Object.freeze(this); }
    Table.prototype.name=function(){return this._data.name;};
    Table.prototype.uuid=function(){return this._data.uuid;};
    Table.prototype.count=function(){return this._data.order.length;};
    Table.prototype.ids=function(){return this._data.order.slice();};
    Table.prototype.columns=function(){return this._data.columnOrder.slice();};
    Table.prototype.columnInfo=function(k){assert(owns(this._data.columns,k),"Column not found: "+k);return this._data.columns[k];};
    Table.prototype.byId=function(id){return owns(this._data.records,id)?new Row(this._snapshot,this._data,id):null;};
    Table.prototype.at=function(index){return this.byId(this._data.order[index]);};
    function Row(snapshot,table,id) { this._snapshot=snapshot;this._table=table;this.id=id;Object.freeze(this); }
    Row.prototype.raw=function(k){assert(owns(this._table.columns,k),"Column not found: "+k);return this._table.records[this.id].raw[k];};
    Row.prototype.get=function(k){assert(owns(this._table.columns,k),"Column not found: "+k);return this._table.records[this.id].typed[k];};
    Row.prototype.safeNumber=function(k){var v=this.get(k);assert(typeof v==="number" || /^(I64|U64)$/.test(this._table.columns[k].data_type),"Not a numeric type"); if(typeof v==="string") assert(compare(v,"-9007199254740991")>=0&&compare(v,"9007199254740991")<=0,"Exceeds safe Number precision. Use a decimal string"); return Number(v);};
    Row.prototype.reference=function(k){var c=this._table.columns[k];assert(c && c.data_type==="Reference","Not a Reference type");var id=this.raw(k);if(!id)return null;var target=c.reference_config&&this._snapshot.uuids[c.reference_config.target_table_uuid];return target&&owns(target.records,id)?new Row(this._snapshot,target,id):null;};
    Row.prototype.tableReference=function(k){var c=this._table.columns[k];assert(c&&c.data_type==="TableRef","Not a TableRef type");var id=this.raw(k);if(!id)return null;var t=this._snapshot.uuids[id],required=c.table_ref_config&&c.table_ref_config.interface_uuid;if(!t||(required&&t.interfaces.indexOf(required)<0))return null;return new Table(this._snapshot,t);};
    var sources=dictionary(),metadata=dictionary();
    function validateIndex(index) {
        assert(object(index)&&index.schema_version===1&&Array.isArray(index.sources),"The data index schema_version must be 1");
        var ids=dictionary(),namespaces=[];
        index.sources.forEach(function(s){
            assert(object(s)&&typeof s.id==="string"&&/^[A-Za-z0-9_-]+$/.test(s.id)&&!owns(ids,s.id.toLowerCase()),"Invalid or duplicate configuration ID");
            assert(typeof s.namespace==="string"&&/^[A-Za-z][A-Za-z0-9_]*(?:(?:\.|::)[A-Za-z][A-Za-z0-9_]*)*$/.test(s.namespace),"Invalid namespace");
            var ns=s.namespace.replace(/::/g,".").toLowerCase();
            namespaces.forEach(function(other){assert(ns!==other&&ns.indexOf(other+".")!==0&&other.indexOf(ns+".")!==0,"Namespace collision");});
            assert(typeof s.runtime_file==="string"&&/^data\/devcel\/[A-Za-z0-9_./-]+\.json$/.test(s.runtime_file)&&s.runtime_file.split("/").every(function(p){return p!==".."&&p!=="."&&p!=="";}),"runtime_file must be under data/devcel");
            assert(s.class_name===null||s.class_name===undefined||/^[A-Za-z][A-Za-z0-9_]*$/.test(s.class_name),"Invalid class_name");
            ids[s.id.toLowerCase()]=true;namespaces.push(ns);
        });return index;
    }
    function replaceSources(loaded) {
        var next=dictionary(),info=dictionary();
        validateIndex({schema_version:1,sources:loaded.map(function(item){return item.source;})});
        loaded.forEach(function(item){assert(item.database instanceof Database,"A Database is required");next[item.source.id]=item.database;info[item.source.id]=freeze(clone(item.source));});
        sources=next;metadata=info;
    }
    return {Database:Database,Curve:Curve,validateIndex:validateIndex,replaceSources:replaceSources,source:function(id){assert(owns(sources,id),"Configuration not found: "+id);return sources[id];},sourceInfo:function(id){return metadata[id]||null;},sourceIds:function(){return Object.keys(sources);}};
});
