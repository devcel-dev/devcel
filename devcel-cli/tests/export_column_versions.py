#!/usr/bin/env python3
"""Real CLI checks for versioned export code, raw operations and export-run configuration.

Requires Python 3.11 or newer.
Usage: python3 export_column_versions.py /path/to/devcel EMPTY_EVIDENCE_DIR
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tomllib

cli = str(Path(sys.argv[1]).resolve())
root = Path(sys.argv[2]).resolve()
root.mkdir(parents=True, exist_ok=True)
if any(root.iterdir()):
    raise SystemExit("Use a new empty evidence directory")
commands = []


def run(*args):
    result = subprocess.run([cli, *map(str, args)], text=True, capture_output=True, timeout=90)
    response = json.loads(result.stdout)
    commands.append({"args": list(map(str, args)), "exit": result.returncode, "response": response})
    (root / "commands.json").write_text(json.dumps(commands, ensure_ascii=False, indent=2))
    assert result.returncode == 0 and response["ok"], (args, response, result.stderr)
    return response["data"]


project = Path(run("init", "Versions", "--dir", root / "authoring")["project_path"])


def edit(*args):
    return run("--mode", "local", "--project", project, *args)


edit("table", "create", "Sample")
edit("column", "add", "Sample", "base", "I32")
edit("column", "add", "Sample", "future", "I32")
row = "11111111-1111-4111-8111-111111111111"
edit("record", "add", "Sample", "--uuid", row)
edit("cell", "set", "Sample", row, "future", "11")
edit("cell", "set", "Sample", row, "base", "=future*2")
# Prepare a saved-source fixture without depending on the Studio column editor.
# Parse it after replacing only the requested column's explicit schema field.
table = next((project.parent / "Tables").glob("*.table.toml"))
sections = table.read_text().split("[[schema.columns]]")
changed = 0
for index, section in enumerate(sections[1:], 1):
    if re.search(r'^data_name = "future"$', section, re.MULTILINE):
        sections[index], count = re.subn(r"^min_version = 0$", "min_version = 2", section, count=1, flags=re.MULTILINE)
        changed += count
assert changed == 1
table.write_text("[[schema.columns]]".join(sections))
assert next(c for c in tomllib.loads(table.read_text())["schema"]["columns"] if c["data_name"] == "future")["min_version"] == 2
before = hashlib.sha256(table.read_bytes()).hexdigest()

for target, accessor in [("csharp", " Future =>"), ("cpp", " future() const")]:
    for version in [0, 1, 2, 4294967295, None]:
        args = [] if version is None else ["--version", version]
        result = edit("export", "code", target, *args)
        assert result["version"] == version
        assert (accessor in result["code"]) == (version is None or version >= 2)
        operation = {"op": "ExportCode", "data": {"target": target, "version": version}}
        assert edit("op", json.dumps(operation))["code"] == result["code"]

# clap must reject values outside the u32 content-version contract before writing.
invalid_results = []
for version in ["-1", "4294967296", "1.5"]:
    destination = root / "invalid.cs"
    result = subprocess.run(
        [cli, "--mode", "local", "--project", str(project), "export", "code", "csharp",
         "--version=" + version, "--out", str(destination)],
        text=True, capture_output=True, timeout=90)
    assert result.returncode != 0 and not destination.exists()
    invalid_results.append({"version": version, "exit": result.returncode, "stderr": result.stderr})
(root / "invalid-version-results.json").write_text(json.dumps(invalid_results, indent=2))

# Runtime and code entries choose matching content versions independently.
config = root / "devcel.export.toml"
config.write_text('''[[runtime]]
out = "v1.json"
version = 1
[[code]]
out = "v1.cs"
target = "csharp"
version = 1
[[code]]
out = "v2.h"
target = "cpp"
version = 2
[[code]]
out = "all.cs"
target = "csharp"
''')
result = edit("export", "run", "--config", config)
assert [entry["version"] for entry in result["outputs"]] == [1, 1, 2, None]
assert " Future =>" not in (root / "v1.cs").read_text()
assert " future() const" in (root / "v2.h").read_text()
assert " Future =>" in (root / "all.cs").read_text()
bundle = json.loads((root / "v1.json").read_text())
assert [column["name"] for column in bundle["tables"][0]["columns"]] == ["base"]
assert bundle["tables"][0]["records"][0]["values"]["base"] == "22"
assert hashlib.sha256(table.read_bytes()).hexdigest() == before
print(json.dumps({"ok": True, "commands": len(commands), "evidence": str(root)}))
