#!/usr/bin/env python3
"""Offline positive and negative fixtures for Node pin synchronization."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('node_pins', ROOT / 'scripts/check-node-pins.py')
pins = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pins)


class NodePinTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        # Deliberately different from the project pin: the guard must derive it.
        self.version = '99.2.3'
        for name in ('package.json', 'devcel-studio/package.json'):
            self.write_json(name, {'volta': {'node': self.version},
                                   'engines': {'node': '>=' + self.version}})
            self.write_json(name.replace('package.json', 'package-lock.json'),
                            {'packages': {'': {'engines': {'node': '>=' + self.version}}}})
        self.write_json('devcel-studio/templates/plugin-template/package.json',
                        {'engines': {'node': '>=' + self.version}})
        self.write('devcel-studio/.nvmrc', self.version + '\n')

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')

    def write_json(self, name, value):
        self.write(name, json.dumps(value))

    def test_committed_pins(self):
        version, selectors = pins.check(ROOT)
        self.assertIn('devcel-studio/.nvmrc', selectors)
        self.assertEqual(version, json.loads((ROOT / 'devcel-studio/package.json').read_text())['volta']['node'])

    def test_uses_canonical_studio_pin(self):
        self.assertEqual(pins.check(self.root)[0], self.version)

    def test_every_manifest_and_lock_field_must_match(self):
        fields = [(name, keys) for name in ('package.json', 'devcel-studio/package.json')
                  for keys in (('volta', 'node'), ('engines', 'node'))]
        fields += [(name, ('packages', '', 'engines', 'node')) for name in
                   ('package-lock.json', 'devcel-studio/package-lock.json')]
        fields += [('devcel-studio/templates/plugin-template/package.json', ('engines', 'node'))]
        for name, keys in fields:
            path = self.root / name
            original = path.read_text()
            with self.subTest(path=name, field=keys):
                for stale in ('99.2.2', None):
                    value = json.loads(original)
                    target = value
                    for key in keys[:-1]:
                        target = target[key]
                    if stale is None:
                        target.pop(keys[-1])
                    else:
                        target[keys[-1]] = stale
                    self.write_json(name, value)
                    with self.assertRaises(ValueError):
                        pins.check(self.root)
                path.write_text(original, encoding='utf-8')

    def test_stale_hidden_selectors_fail_recursively(self):
        fixtures = {
            'devcel-studio/.nvmrc': '99.2.2\n',
            '.nested/example/.nvmrc': '99.2.2\n',
            'examples/plugin/.node-version': '99.2.2\n',
            '.nested/.nodejs-version': '99.2.2\n',
            'examples/.tool-versions': 'python 3.12.0\nnodejs 99.2.2\n',
            '.nested/.mise.toml': '[tools]\nnode = "99.2.2"\n',
            'examples/mise.toml': '[tools]\nnode = "99.2.2"\n',
            '.mise.production.toml': '[tools]\nnode = "99.2.2"\n',
            '.mise/config.toml': '[tools]\nnode = { version = "99.2.2" }\n',
            '.config/mise/config.toml': '[tools]\nnode = "99.2.2"\n',
            '.prototools': 'node = "99.2.2"\n',
        }
        for name, text in fixtures.items():
            with self.subTest(selector=name):
                self.write(name, text)
                with self.assertRaises(ValueError) as caught:
                    pins.check(self.root)
                self.assertIn(name, str(caught.exception))
                self.write(name, text.replace('99.2.2', self.version))
                pins.check(self.root)

    def test_aliases_ranges_multiple_versions_and_empty_pins_fail(self):
        for value in ('node', 'lts/*', '>=99.2.3', '99', '99.2.3 99.2.2', ''):
            with self.subTest(value=value):
                self.write('devcel-studio/.nvmrc', value + '\n')
                with self.assertRaises(ValueError):
                    pins.check(self.root)
        self.write('devcel-studio/.nvmrc', self.version + '\n')
        self.write('.tool-versions', 'nodejs 99.2.3 99.2.2\n')
        with self.assertRaises(ValueError):
            pins.check(self.root)

    def test_comments_v_prefix_and_unrelated_tools_are_allowed(self):
        self.write('devcel-studio/.nvmrc', '# Node\r\nv99.2.3 # pinned\r\n')
        self.write('.tool-versions', 'python 3.12.0\nnodejs 99.2.3 # pinned\n')
        self.write('.mise.toml', '[tools]\npython = "3.12.0"\n')
        self.write('.prototools', 'python = "3.12.0"\n')
        pins.check(self.root)

    def test_dependency_generated_and_git_copies_are_excluded(self):
        for directory in pins.EXCLUDED_DIRS:
            self.write(f'examples/{directory}/nested/.nvmrc', '99.2.2\n')
        pins.check(self.root)

    def test_malformed_toml_fails_closed(self):
        self.write('.mise.toml', '[tools\nnode = "99.2.3"\n')
        with self.assertRaisesRegex(ValueError, r'\.mise\.toml'):
            pins.check(self.root)

    def test_selector_symlink_is_not_followed(self):
        target = self.root / 'outside-selector'
        target.write_text(self.version, encoding='utf-8')
        try:
            (self.root / '.node-version').symlink_to(target)
        except OSError:
            self.skipTest('Creating symlinks is not permitted on this platform')
        with self.assertRaisesRegex(ValueError, 'symlink'):
            pins.check(self.root)

    def test_cli_exits_nonzero_for_the_original_hidden_selector_regression(self):
        self.write('devcel-studio/.nvmrc', '99.2.2\n')
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/check-node-pins.py'),
                                 '--root', str(self.root)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('devcel-studio/.nvmrc', result.stderr)
        self.assertIn('99.2.2', result.stderr)
        self.assertNotIn('Node pins match', result.stdout)


if __name__ == '__main__':
    unittest.main()
