// Pure history state checks. The real component flows live in check-tab-selection.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(resolve(project, '.navigation-history-check-'));
try {
  const built = await build({ entryPoints: [resolve(project, 'src/app/pages/main_window/project_view/table_view/navigationHistory.ts')], bundle: true, format: 'esm', platform: 'node', write: false });
  const path = resolve(temp, 'history.mjs'); await writeFile(path, built.outputFiles[0].text);
  const { emptyNavigationHistory, commitNavigation, navigationTarget, retargetNavigationHistory, reconcileNavigationHistory } = await import(pathToFileURL(path));
  const file = (name, type = 'table') => ({ id: `${name}.toml`, path: `${name}.toml`, name, type, ...(type === 'table' ? { uuid: name } : {}) });
  const a = file('a'), b = file('b'), c = file('c');
  let history = emptyNavigationHistory();
  assert.equal(navigationTarget(history, -1), null);
  for (const item of [a, b, c]) history = commitNavigation(history, item);
  assert.equal(history.index, 2); assert.equal(navigationTarget(history, 1, c), null);
  const proposed = navigationTarget(history, -1, c);
  assert.equal(proposed, 1); assert.equal(history.index, 2, 'requesting or abandoning Back cannot change the index');
  history = commitNavigation(history, b, proposed);
  assert.equal(history.index, 1); assert.equal(navigationTarget(history, 1, b), 2);
  history = commitNavigation(history, b);
  assert.equal(history.entries.length, 3, 'clicking the current file preserves Forward');
  history = commitNavigation(history, file('d'));
  assert.deepEqual(history.entries.map(item => item.uuid), ['a', 'b', 'd'], 'fresh navigation discards forward history');
  const renamed = { ...a, id: 'nested/a.toml', path: 'nested/a.toml', name: 'a.toml' };
  history = retargetNavigationHistory(history, a.path, renamed);
  assert.equal(history.entries[0].path, renamed.path); assert.equal(history.index, 2);
  history = reconcileNavigationHistory(history,
    [{ path: renamed.path, entry_type: 'Table' }, { path: 'd.toml', entry_type: 'Table' }],
    [{ path: renamed.path, uuid: 'a' }, { path: 'd.toml', uuid: 'd' }]);
  assert.equal(history.entries[1], null, 'deleted file becomes a tombstone'); assert.equal(history.index, 2);
  assert.equal(navigationTarget(history, -1, file('d')), 0, 'Back skips deleted paths');
  const reused = reconcileNavigationHistory(commitNavigation(emptyNavigationHistory(), a),
    [{ path: a.path, entry_type: 'Table' }], [{ path: a.path, uuid: 'replacement' }]);
  assert.equal(reused.entries[0], null, 'reused path cannot impersonate a table UUID');
  const ambiguous = reconcileNavigationHistory(commitNavigation(emptyNavigationHistory(), a),
    [{ path: a.path, entry_type: 'Table' }, { path: 'copy.toml', entry_type: 'Table' }],
    [{ path: a.path, uuid: 'a' }, { path: 'copy.toml', uuid: 'a' }]);
  assert.equal(ambiguous.entries[0], null, 'ambiguous UUID cannot choose a different file arbitrarily');
  const moved = reconcileNavigationHistory(commitNavigation(emptyNavigationHistory(), a),
    [{ path: renamed.path, entry_type: 'Table' }], [{ path: renamed.path, uuid: 'a' }]);
  assert.equal(moved.entries[0].path, renamed.path, 'external rename is resolved by UUID');
  const note = { ...file('note', 'markdown'), id: 'folder/note.md', path: 'folder/note.md' };
  const movedFolder = retargetNavigationHistory(commitNavigation(emptyNavigationHistory(), note), 'folder', { id: 'moved', path: 'moved', name: 'moved', type: 'folder' });
  assert.equal(movedFolder.entries[0].path, 'moved/note.md');
  assert.equal(navigationTarget(movedFolder, -1, null), 0, 'Back reopens the last closed tab');
  let bounded = emptyNavigationHistory(); for (let i = 0; i < 150; i++) bounded = commitNavigation(bounded, file(String(i)));
  assert.equal(bounded.entries.length, 100); assert.equal(bounded.index, 99);
  console.log('PASS navigation history: commit-only cursor, Back/Forward, duplicate suppression, branch truncation, bounded storage, close/reopen, rename and deletion identity safety');
} finally { await rm(temp, { recursive: true, force: true }); }
