#!/usr/bin/env python3
"""Compile tag-projected C++ and TypeScript emitted by tag_filter_codegen.

Generate fixtures with DEVCEL_TAG_CODEGEN_FIXTURE_OUT=DIR cargo test -p devcel-core
--test tag_filter_codegen, then run this script with --fixtures DIR --tsc PATH.
This test does not verify C# and does not install any compiler.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path, required=True)
    parser.add_argument('--tsc', default='tsc')
    parser.add_argument('--cxx', default='g++')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    with tempfile.TemporaryDirectory(prefix='devcel-tag-compile-') as temporary:
        work = Path(temporary)
        for name in ['tags.h', 'tags.ts']:
            shutil.copyfile(args.fixtures / name, work / name)
        (work / 'check.cpp').write_text('#include "tags.h"\nstatic_assert(!TagCheck::IContract<TagCheck::ItemsRow>);\n')
        subprocess.run([args.cxx, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', str(work / 'check.cpp')], check=True)
        (work / 'check.cpp').write_text('#include "tags.h"\n')
        subprocess.run([args.cxx, '-std=c++17', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', str(work / 'check.cpp')], check=True)
        for name in ['devcel-runtime.js', 'devcel-runtime.d.ts']:
            shutil.copyfile(repo / 'importers/javascript/runtime' / name, work / name)
        (work / 'package.json').write_text('{"type":"module"}')
        (work / 'check.ts').write_text('''import { TagCheck } from './tags.js';
export function check(row: TagCheck.ItemsRow, contract: TagCheck.IContract) {
  const canonical: string = contract.Required;
  // @ts-expect-error A tag-projected row no longer implements the canonical interface.
  const incomplete: TagCheck.IContract = row;
  // @ts-expect-error The private column has no generated accessor.
  const hidden = row.Required;
  return [canonical, incomplete, hidden];
}
''')
        subprocess.run([args.tsc, '--strict', '--noEmit', '--target', 'ES2020', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', str(work / 'check.ts')], check=True)
    print('PASS: C++17/C++20 and TypeScript tag projection; C# not compiled')


if __name__ == '__main__':
    main()
