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
          "boolean": ("Boolean", "true"), "color": ("Color32", "[255,0,1,255]")}
bundle = {"manifest": {"schema_version": 1, "mode": "full"}, "tables": [
    {"uuid": "11111111-1111-4111-8111-111111111111", "name": "enemies",
     "columns": [{"name": k, "data_type": v[0]} for k, v in values.items()],
     "records": [{"id": "00000000-0000-4000-8000-000000000001",
                  "values": {k: v[1] for k, v in values.items()}}]}]}
bundle["tables"].append({"uuid": "22222222-2222-4222-8222-222222222222", "name": "items",
    "columns": [{"name": "quantity", "data_type": "I32"}],
    "records": [{"id": "00000000-0000-4000-8000-000000000002", "values": {"quantity": "17"}}]})
mismatch = copy.deepcopy(bundle)
mismatch["tables"][0]["records"] = []
mismatch["tables"][0]["columns"][0]["data_type"] = "I32"
not_finite = copy.deepcopy(bundle)
not_finite["tables"][0]["records"][0]["values"]["f32"] = "NaN"
duplicate = copy.deepcopy(bundle)
duplicate["tables"][0]["records"].append(copy.deepcopy(duplicate["tables"][0]["records"][0]))
with tempfile.TemporaryDirectory(prefix="devcel-mastermemory-") as tmp:
    tmp = Path(tmp)
    for filename in ("Program.cs", "GeneratedHarness.csproj"):
        shutil.copyfile(root / filename, tmp / filename)
    for name, doc in (("bundle.json", bundle), ("mismatch.json", mismatch), ("nonfinite.json", not_finite), ("duplicate.json", duplicate)):
        (tmp / name).write_text(json.dumps(doc), encoding="utf-8")
    subprocess.run([sys.executable, str(root.parent / "generate.py"), str(tmp / "bundle.json"),
                    str(tmp / "Generated.cs")], check=True)
    subprocess.run(["dotnet", "run", "--project", str(tmp / "GeneratedHarness.csproj"),
                    "--", str(tmp / "bundle.json"), str(tmp / "mismatch.json"),
                    str(tmp / "nonfinite.json"), str(tmp / "duplicate.json")], check=True)
