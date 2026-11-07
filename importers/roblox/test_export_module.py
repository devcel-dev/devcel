import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from export_module import render, convert

class ExportTests(unittest.TestCase):
    def bundle(self):
        target = "22222222-2222-4222-8222-222222222222"
        record_id = "00000000-0000-4000-8000-000000000002"
        return {"manifest": {"schema_version": 1, "mode": "full"}, "tables": [
          {"uuid":"11111111-1111-4111-8111-111111111111", "name":"enemies", "columns":[
            {"name":"color","data_type":"Color32"}, {"name":"hdr","data_type":"ColorFloat"},
            {"name":"curve","data_type":"Curve"}, {"name":"item","data_type":"Reference", "reference_config":{"target_table_uuid":target}},
            {"name":"table","data_type":"TableRef"}, {"name":"hp","data_type":"I32"}, {"name":"wide","data_type":"U64"}],
           "records":[{"id":"00000000-0000-4000-8000-000000000001", "values":{
              "color":"[255,0,1,255]", "hdr":"[2,-1,0.25,0.5]", "curve":json.dumps({"points":[{"x":0,"y":1,"mode":"free","outSlope":2,"outLen":0.8},{"x":0.4,"y":0.8,"mode":"autoLength","inLen":0.6,"outLen":1.1},{"x":0.7,"y":2,"mode":"constant"},{"x":1,"y":0,"mode":"linear"}]}),
              "item":record_id, "table":target, "hp":"17", "wide":"18446744073709551615"}}]},
          {"uuid":target,"name":"items","columns":[],"records":[{"id":record_id,"values":{}}]}]}

    def test_json_is_data_even_with_long_bracket_delimiters(self):
        source = json.dumps({"manifest": {"schema_version": 1, "mode": "full"}, "tables": [{"name": "]] ]=] quote"}]})
        module = render(source)
        self.assertIn("[==[\n", module)
        self.assertIn("]==]", module)
        self.assertIn("HttpService:JSONDecode", module)

    def test_typed_values_and_invalid_color(self):
        b=self.bundle(); values=convert(copy.deepcopy(b))["tables"][0]["records"][0]["values"]
        self.assertEqual(values["color"]["r"], 255)
        self.assertEqual(values["hdr"]["g"], -1)
        self.assertEqual(values["hp"], 17)
        self.assertEqual(values["wide"], "18446744073709551615")
        self.assertEqual(values["item"]["targetTableId"], b["tables"][1]["uuid"])
        self.assertEqual(values["curve"]["__devcel_kind"], "curve")
        b["tables"][0]["records"][0]["values"]["color"] = "[256,0,0,0]"
        with self.assertRaises(ValueError): convert(b)

    def test_incompatible_table_reference_and_missing_target_fail(self):
        b=self.bundle()
        b["tables"][0]["columns"][4]["table_ref_config"] = {"interface_uuid":"44444444-4444-4444-8444-444444444444"}
        with self.assertRaisesRegex(ValueError, "incompatible"): convert(b)
        b=self.bundle()
        b["tables"][0]["columns"][3]["reference_config"]["target_table_uuid"]="33333333-3333-4333-8333-333333333333"
        with self.assertRaisesRegex(ValueError, "reference target"): convert(b)

    def test_missing_cells_use_typed_defaults_and_license_is_retained(self):
        b=self.bundle(); b["tables"][0]["records"][0]["values"]={}
        values=convert(copy.deepcopy(b))["tables"][0]["records"][0]["values"]
        self.assertEqual(values["hp"],0)
        self.assertEqual(values["wide"],"0")
        self.assertEqual(values["color"]["a"],255)
        self.assertEqual(values["item"]["id"],"")
        self.assertIn("Permission is hereby granted",render(json.dumps(b)))

    def test_rejects_unsupported_and_malformed_inputs(self):
        for source in ('{}', '{', '{"manifest":{"schema_version":2,"mode":"full"},"tables":[]}', '{"manifest":{"schema_version":true,"mode":"full"},"tables":[]}', '{"manifest":{"schema_version":1,"mode":"full"},"tables":[],"x":NaN}'):
            with self.assertRaises((ValueError, json.JSONDecodeError)): render(source)

    def test_luau_runtime_with_mock_http_service(self):
        exe=os.environ.get("DEVCEL_LUAU")
        if not exe: self.skipTest("set DEVCEL_LUAU to run the official Luau CLI")
        b=self.bundle(); typed=convert(copy.deepcopy(b))
        def lua(x):
            if x is None:return "nil"
            if isinstance(x,bool):return "true" if x else "false"
            if isinstance(x,(int,float)):return str(x)
            if isinstance(x,str):return json.dumps(x)
            if isinstance(x,list):return "{"+",".join(lua(v) for v in x)+"}"
            return "{"+",".join("["+lua(k)+"]="+lua(v) for k,v in x.items())+"}"
        module=render(json.dumps(b)).replace("return data\n", """
local v=data.tables[1].records[1].values
assert(v.color.r==255 and v.color.a==255 and v.hdr.g == -1)
assert(v.item:Resolve()==data.tables[2].records[1])
assert(v.table:Resolve()==data.tables[2])
assert(math.abs(v.curve:Sample(0.15)-1.002585613171157)<1e-12)
assert(math.abs(v.curve:Sample(0.55)-1.437342524517376)<1e-12)
assert(v.curve:Sample(0.85)==2 and v.hp==17 and v.wide=="18446744073709551615")
print("ROBOX_TYPED_LUAU_PASS")
""")
        prefix="local game={GetService=function() return {JSONDecode=function() return "+lua(typed)+" end} end}\n"
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/"test.luau";path.write_text(prefix+module,encoding="utf-8")
            result=subprocess.run([exe,str(path)],capture_output=True,text=True,check=True)
            self.assertIn("ROBOX_TYPED_LUAU_PASS",result.stdout)

if __name__ == "__main__": unittest.main()
