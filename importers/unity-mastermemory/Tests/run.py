#!/usr/bin/env python3
"""Build and execute generated MasterMemory code in a temporary .NET project."""
import copy
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

root = Path(__file__).resolve().parent
values = {"name": ("String", "Enemy 1"), "i8": ("I8", "-7"),
          "u64": ("U64", "18446744073709551615"), "f32": ("F32", "1.5"),
          "boolean": ("Boolean", "true"), "color": ("Color32", "[255,0,1,255]"),
          "hdr": ("ColorFloat", "[2,-1,0.25,0]"),
          "curve": ("Curve", '{"points":[{"x":0,"y":0,"mode":"linear"},{"x":1,"y":1,"mode":"linear"}]}'),
          "curve2": ("Curve", '{"points":[{"x":0,"y":1,"mode":"free","outSlope":2,"outLen":0.8},{"x":0.4,"y":0.8,"mode":"autoLength","inLen":0.6,"outLen":1.1},{"x":0.7,"y":2,"mode":"constant"},{"x":1,"y":0,"mode":"linear"}]}'),
          "item": ("Reference", "00000000-0000-4000-8000-000000000002"),
          "table": ("TableRef", "22222222-2222-4222-8222-222222222222")}
bundle = {"manifest": {"schema_version": 1, "mode": "full"}, "tables": [
    {"uuid": "11111111-1111-4111-8111-111111111111", "name": "enemies",
     "columns": [{"name": k, "data_type": v[0]} for k, v in values.items()],
     "records": [{"id": "00000000-0000-4000-8000-000000000001",
                  "values": {k: v[1] for k, v in values.items()}}]}]}
bundle["tables"].append({"uuid": "22222222-2222-4222-8222-222222222222", "name": "items", "interfaces": ["44444444-4444-4444-8444-444444444444"],
    "columns": [{"name": "quantity", "data_type": "I32"}],
    "records": [{"id": "00000000-0000-4000-8000-000000000002", "values": {"quantity": "17"}}]})
for column in bundle["tables"][0]["columns"]:
    if column["name"] == "item": column["reference_config"] = {"target_table_uuid": "22222222-2222-4222-8222-222222222222", "display_column_uuid": None}
    if column["name"] == "curve": column["curve_config"] = {"start_value": 0.0, "end_value": 1.0}
    if column["name"] == "table": column["table_ref_config"] = {"interface_uuid": "44444444-4444-4444-8444-444444444444"}
mismatch = copy.deepcopy(bundle)
mismatch["tables"][0]["records"] = []
mismatch["tables"][0]["columns"][0]["data_type"] = "I32"
not_finite = copy.deepcopy(bundle)
not_finite["tables"][0]["records"][0]["values"]["f32"] = "NaN"
bad_color = copy.deepcopy(bundle)
bad_color["tables"][0]["records"][0]["values"]["hdr"] = "[2,-1,0.25,1.1]"
bad_table = copy.deepcopy(bundle)
bad_table["tables"][0]["records"][0]["values"]["table"] = "11111111-1111-4111-8111-111111111111"
bad_interfaces = copy.deepcopy(bundle)
bad_interfaces["tables"][1]["interfaces"] = []
duplicate = copy.deepcopy(bundle)
duplicate["tables"][0]["records"].append(copy.deepcopy(duplicate["tables"][0]["records"][0]))
with tempfile.TemporaryDirectory(prefix="devcel-mastermemory-") as tmp:
    tmp = Path(tmp)
    for filename in ("Program.cs", "GeneratedHarness.csproj"):
        shutil.copyfile(root / filename, tmp / filename)
    for name, doc in (("bundle.json", bundle), ("mismatch.json", mismatch), ("nonfinite.json", not_finite), ("duplicate.json", duplicate), ("badcolor.json", bad_color), ("badtable.json", bad_table), ("badinterfaces.json", bad_interfaces)):
        (tmp / name).write_text(json.dumps(doc), encoding="utf-8")
    subprocess.run([sys.executable, str(root.parent / "generate.py"), str(tmp / "bundle.json"),
                    str(tmp / "Generated.cs")], check=True)
    subprocess.run(["dotnet", "run", "--project", str(tmp / "GeneratedHarness.csproj"),
                    "--", str(tmp / "bundle.json"), str(tmp / "mismatch.json"),
                    str(tmp / "nonfinite.json"), str(tmp / "duplicate.json"), str(tmp / "badcolor.json"), str(tmp / "badtable.json"), str(tmp / "badinterfaces.json")], check=True)
