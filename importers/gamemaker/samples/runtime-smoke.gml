// Integration check: add all three master.*.json fixtures to Included Files under devcel/.
// Then run this in a Create event. The invalid-column fixture must never replace the good DB.
var a = new DevcelDatabase("base"), b = new DevcelDatabase("event");
__devcel_require(a.load_file("devcel/master.full.json"),a.last_error);
__devcel_require(b.load_file("devcel/master.minimal.json"),b.last_error);
var hero = a.by_id("Heroes","hero-1");
__devcel_require(hero.get("hp") == 100,"I32");
__devcel_require(hero.get("wide") == "9007199254740993","I64 precision");
__devcel_require(hero.get("huge") == "18446744073709551615","U64 precision");
__devcel_require(hero.get("color_float").r == -0.25 && hero.get("color_float").g == 2 && hero.get("color_float").a == 0,"HDR and transparent RGB");
__devcel_require(hero.get("color32").r == 18 && hero.get("color32").a == 0,"Color32");
__devcel_require(hero.reference("item").get("label") == "回復薬","Reference");
__devcel_require(hero.table_reference("drops").name() == "Items","TableRef");
var tables = a.tables();
for (var ti = 0; ti < array_length(tables); ++ti) {
    var ta = a.table(tables[ti]), ids = ta.ids(), columns = ta.columns();
    for (var ri = 0; ri < array_length(ids); ++ri) for (var ci = 0; ci < array_length(columns); ++ci)
        __devcel_require(ta.by_id(ids[ri]).get_raw(columns[ci]) == b.by_id(tables[ti],ids[ri]).get_raw(columns[ci]),"Full/minimal parity");
}
var original = a.manifest().content_hash;
__devcel_require(!a.load_file("devcel/master.invalid-column.json"),"Reject schema-undefined column");
__devcel_require(string_pos("Unknown column",a.last_error) > 0,"Unknown-column diagnostic");
__devcel_require(a.manifest().content_hash == original && a.by_id("Heroes","hero-1").get("hp") == 100,"Unknown-column keeps active snapshot");
__devcel_require(!a.load_json("broken JSON"),"Reject malformed input");
__devcel_require(a.manifest().content_hash == original && hero.get("hp") == 100,"Preserve old snapshot");
__devcel_require(!__devcel_loopback_url("http://127.0.0.1:80@evil.test/runtime/base?token=x"),"Reject non-loopback authority");
// Reused defaults must not alias mutable values across rows.
var default_bundle = json_parse("{\"manifest\":{\"schema_version\":1,\"content_hash\":\"defaults\",\"generated_at\":\"fixture\",\"data_revision\":0,\"mode\":\"minimal\"},\"project_name\":\"Defaults\",\"tables\":[]}");
array_push(default_bundle.tables,{name:"Colors",uuid:"colors",columns:[{name:"color",data_type:"ColorFloat",default_value:"[-0.25,2,0.5,0]"}],records:[{id:"a",values:{}},{id:"b",values:{}},{id:"c",values:{color:"[-0.25,2,0.5,0]"}}]});
var defaults = __devcel_parse(json_stringify(default_bundle));
defaults.tables.Colors.records.a.typed.color.g = 999;
__devcel_require(defaults.tables.Colors.records.b.typed.color.g == 2,"Independent default values");
__devcel_require(defaults.tables.Colors.records.c.typed.color.g == 2,"Explicit defaults own their values");
show_debug_message("DEVCEL RUNTIME SMOKE PASSED");
