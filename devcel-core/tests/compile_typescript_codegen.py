#!/usr/bin/env python3
"""Compile real TypeScript SDKs and execute them against the engine-neutral runtime.

Requires Node and TypeScript 5+; no packages are installed by this script.
  python3 devcel-core/tests/compile_typescript_codegen.py --tsc /path/to/typescript/bin/tsc
Use --fixtures DIR to reuse DEVCEL_CODEGEN_FIXTURE_OUT from both Rust integration
tests (typescript_codegen and column_version_codegen), without running cargo.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def run(*args, **kwargs):
    subprocess.run([str(arg) for arg in args], check=True, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path)
    parser.add_argument("--tsc", default=os.environ.get("TSC", "tsc"))
    parser.add_argument("--node", default="node")
    args = parser.parse_args()
    for executable in [args.node, args.tsc]:
        if shutil.which(executable) is None and not Path(executable).is_file():
            raise SystemExit(f"Required executable not found: {executable}")
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix="devcel-ts-codegen-") as directory:
        work = Path(directory)
        fixtures = args.fixtures.resolve() if args.fixtures else work / "fixtures"
        if args.fixtures is None:
            env = os.environ.copy()
            env["DEVCEL_CODEGEN_FIXTURE_OUT"] = str(fixtures)
            run("cargo", "test", "--manifest-path", repo / "Cargo.toml", "-p", "devcel-core",
                "--test", "typescript_codegen", "--test", "column_version_codegen", env=env)
        for source in fixtures.glob("*.ts"):
            shutil.copyfile(source, work / source.name)
        runtime = repo / "importers" / "javascript" / "runtime"
        for name in ["devcel-runtime.js", "devcel-runtime.d.ts"]:
            shutil.copyfile(runtime / name, work / name)
        (work / "package.json").write_text('{"type":"module"}', encoding="utf-8")
        (work / "typecheck.ts").write_text('''
import { Game } from './types.js';
import type { Color32, ColorFloat } from './devcel-runtime.js';
import { Game as Early } from './types-early.js';
export function check(db: Game.Data.GameData, early: Early.Data.GameData) {
  const row = db.Heroes.At(0)!;
  const signed: bigint = row.Long;
  const unsigned: bigint = row.UnsignedLong;
  const tint: Color32 = row.Tint;
  const hdr: ColorFloat = row.Hdr;
  const named: Game.Data.INamed = row;
  const reference: Game.Data.ItemsRow | undefined = row.Weapon;
  const table: Game.Data.ItemsTable | undefined = row.CatalogTable?.AsItems();
  const selection: Game.Data.HeroesKindValue | undefined = row.KindValue;
  const sampled: number = row.SampleCurve(0.5);
  // @ts-expect-error An I64 must never silently become a JavaScript number.
  const lossy: number = row.Long;
  // @ts-expect-error HDR and byte colors are distinct runtime types.
  const byteFromHdr: Color32 = row.Hdr;
  // @ts-expect-error Byte colors cannot implicitly become HDR colors either.
  const hdrFromByte: ColorFloat = row.Tint;
  // @ts-expect-error The column is absent from content version 1.
  const hidden = early.Heroes.At(0)!.Future;
  return [signed, unsigned, tint, hdr, named, reference, table, selection, sampled, lossy, byteFromHdr, hdrFromByte, hidden];
}
''', encoding="utf-8")
        for version in [0, 1, 2, 3, 4294967295]:
            (work / f"check-v{version}.ts").write_text(
                f"import {{ VersionCheck }} from './v{version}.js';\n"
                "export function check(row: VersionCheck.HeroesRow, item: VersionCheck.ItemsRow) {\n"
                "  const base: VersionCheck.IBase = row;\n"
                "  const child: VersionCheck.IChild = row;\n"
                "  const ref: VersionCheck.ItemsRow | undefined = row.Weapon;\n"
                + ("  // @ts-expect-error projected-out child column\n" if version < 2 else "")
                + "  const childFuture = row.ChildFuture;\n"
                + ("  // @ts-expect-error projected-out ancestor column\n" if version < 3 else "")
                + "  const ancestorFuture = row.AncestorFuture;\n"
                + ("  // @ts-expect-error projected-out target column\n" if version < 9 else "")
                + "  const power = item.Power;\n"
                "  return [base, child, ref, childFuture, ancestorFuture, power];\n}\n",
                encoding="utf-8")
        sources = sorted(work.glob("*.ts"))
        run(args.node, args.tsc, "--strict", "--noUnusedLocals", "--noUnusedParameters",
            "--isolatedModules", "--verbatimModuleSyntax", "--noUncheckedIndexedAccess", "--exactOptionalPropertyTypes",
            "--target", "ES2020", "--module", "ES2020", "--moduleResolution", "bundler",
            "--outDir", work / "compiled", *sources, cwd=work)
        shutil.copyfile(runtime / "devcel-runtime.js", work / "compiled" / "devcel-runtime.js")
        (work / "check-runtime.mjs").write_text('''
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Game } from './compiled/types.js';
const fixtures = process.argv[2];
const read = name => readFileSync(`${fixtures}/${name}`, 'utf8');
const ids = JSON.parse(read('types-ids.json'));
for (const mode of ['full', 'minimal']) {
  const text = read(`types-${mode}.json`);
  const db = Game.Data.GameData.FromJson(text);
  const row = db.Heroes.ById(ids.hero);
  assert.equal(db.Heroes.Count, 1);
  assert.equal(db.Heroes.At(-1), undefined);
  assert.equal(db.Heroes.ById('missing'), undefined);
  assert.equal(row.Id, ids.hero);
  assert.equal(row.RowIndex, 0);
  assert.equal(row.Long, -9223372036854775808n);
  assert.equal(row.UnsignedLong, 18446744073709551615n);
  assert.equal(row.Byte, 255);
  assert.equal(row.SignedByte, -128);
  assert.equal(row.Short, -32768);
  assert.equal(row.UnsignedShort, 65535);
  assert.equal(row.Int, -2147483648);
  assert.equal(row.UnsignedInt, 4294967295);
  assert.equal(row.Single, 1.25);
  assert.equal(row.Double, 3.125);
  assert.equal(row.Enabled, true);
  assert.deepEqual(row.Tint.toArray(), [0,128,255,64]);
  assert.deepEqual(row.Hdr.toArray(), [-2,4,0.5,0.25]);
  assert.equal(row.Weapon.Id, ids.item);
  assert.equal(row.Weapon.Title, 'default title');
  assert.equal(row.CatalogTable.AsItems().Count, 1);
  assert.equal(row.CatalogTable.AsHeroes(), undefined);
  assert.equal(row.KindValue, Game.Data.HeroesKindValue.HighTier);
  assert.equal(typeof row.Curve, 'string');
  assert.ok(Math.abs(row.SampleCurve(0.5) - 0.5) < 1e-6);
  assert.equal(row.When, '2026-10-14T11:00:00Z');
  const updated = JSON.parse(text);
  updated.tables.find(t => t.name === 'items').records[0].values.title = 'reloaded';
  db.LoadJson(JSON.stringify(updated));
  assert.equal(db.Heroes.ById(ids.hero).Weapon.Title, 'reloaded');
  assert.equal(row.Weapon.Title, 'default title', 'old reference must retain its snapshot');
  assert.equal(row.CatalogTable.AsItems().At(0).Title, 'default title');
  assert.throws(() => db.LoadJson('{'));
  assert.equal(db.Heroes.ById(ids.hero).Weapon.Title, 'reloaded');
  const wrapped = Game.Data.GameData.FromRuntime(db.Runtime);
  assert.equal(wrapped.Heroes.All.length, 1);
}
console.log('PASS: generated TypeScript strict compile, versions, full/minimal, bigint, HDR, references, atomic reload');
''', encoding="utf-8")
        run(args.node, work / "check-runtime.mjs", fixtures)


if __name__ == "__main__":
    main()
