#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET="${CARGO_TARGET_DIR:-$ROOT/target}"
if [[ "$TARGET" != /* ]]; then TARGET="$ROOT/$TARGET"; fi
OUT="${DEVCEL_CODEGEN_TEST_OUTPUT:-$TARGET/runtime-codegen-test}"
mkdir -p "$OUT"
cd "$ROOT"
cargo build -p devcel-cli -p devcel-runtime
cargo run -p devcel-core --example runtime_export_fixture -- "$OUT"
python3 - "$OUT" <<'PY'
import copy,json,pathlib,sys
p=pathlib.Path(sys.argv[1]);full=json.loads((p/'bundle-initial.json').read_text());mini=json.loads((p/'minimal-initial.json').read_text())
def effective(bundle):
 return {t['name']:{r['id']:{c['name']:r['values'].get(c['name'],c.get('default_value','')) for c in t['columns']} for r in t['records']} for t in bundle['tables']}
assert effective(full)==effective(mini)
hero=next(t for t in full['tables'] if t['name']=='heroes');assert len(hero['interfaces'])==2
assert next(c for c in hero['columns'] if c['name']=='curve')['curve_config']=={'start_value':0.0,'end_value':1.0}
assert next(c for c in hero['columns'] if c['name']=='weapon')['reference_config']['target_table_uuid']
# Each native consumer validates required fields and supported types.
for label, mutate in [
 ('missing-project', lambda b:b.pop('project_name')),
 ('missing-revision', lambda b:b['manifest'].pop('data_revision')),
 ('missing-generated', lambda b:b['manifest'].pop('generated_at')),
 ('missing-mode', lambda b:b['manifest'].pop('mode')),
 ('missing-uuid', lambda b:b['tables'][0].pop('uuid')),
 ('missing-values', lambda b:b['tables'][0]['records'][0].pop('values')),
 ('invalid-string-type', lambda b:b['tables'][0]['columns'][0].update(data_type='Str')),
 ('invalid-boolean-type', lambda b:b['tables'][0]['columns'][0].update(data_type='Bool')),
 ('invalid-color-type', lambda b:b['tables'][0]['columns'][0].update(data_type='Color')),
 ('unsupported-schema', lambda b:b['manifest'].update(schema_version=99)),
]:
 invalid=copy.deepcopy(full);mutate(invalid)
 (p/f'invalid-current-{label}.json').write_text(json.dumps(invalid))
print('Real exporter: full/minimal equivalence, inherited contracts, reference/curve metadata PASS')
PY
CC="${CC:-cc}"
"$CC" -std=c11 -Wall -Wextra -Werror -I "$ROOT/devcel-runtime/include" tests/runtime-codegen/smoke.c -L "$TARGET/debug" -Wl,-rpath,"$TARGET/debug" -ldevcel_runtime -o "$OUT/c-smoke"
"$OUT/c-smoke" "$OUT/bundle-initial.json"
"$OUT/c-smoke" "$OUT/minimal-initial.json"
CXX="${CXX:-c++}"
for version in 17 20; do
 "$CXX" -std="c++$version" -O1 -g -fsanitize=undefined -fno-omit-frame-pointer -I "$OUT" -I "$ROOT/devcel-runtime/include" tests/runtime-codegen/smoke.cpp -L "$TARGET/debug" -Wl,-rpath,"$TARGET/debug" -ldevcel_runtime -o "$OUT/cpp-smoke-$version"
 "$OUT/cpp-smoke-$version" "$OUT"
done
export DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export LD_LIBRARY_PATH="$TARGET/debug${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
"${DOTNET:-dotnet}" run --project tests/runtime-codegen/Smoke.csproj -p:GeneratedDevcel="$OUT/Devcel.cs" -- "$OUT"
