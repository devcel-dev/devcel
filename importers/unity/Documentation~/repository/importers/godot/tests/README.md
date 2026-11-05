# Godot Importer Tests

## Runtime, CLI, and packaging

Use Godot 4.6.3 with its Linux export template, Bash, Python 3, and the shell utilities used by `run_tests.sh`. From the repository root:

```sh
bash importers/godot/tests/run_tests.sh
bash importers/godot/tests/run_tests.sh /absolute/path/to/devcel
```

Set `GODOT` if the executable is named differently. The optional CLI must come from the same source revision. The script uses disposable project copies under `importers/godot/test-output/` and prints their log directory; failures exit nonzero.

The tests exercise typed values and boundaries, Full/Minimal exports, references, curves, invalid input, retained snapshots, Editor locale selection, and safe PCK publication. With a CLI they also create authoring fixtures, generate C#/C++, apply Content Version filters, and reload exported data. Curve vectors contain 13 curves and 195 samples; regenerate them from Studio's evaluator with `node tests/make_curve_vectors.cjs` from `importers/godot` after installing the Studio dependencies.

For only the static locale check, run:

```sh
python3 importers/godot/tests/test_editor_locale_static.py
```

## Editor integration fixtures

From `importers/godot`, prepare a new empty fixture directory:

```sh
python3 tests/prepare_pull_metadata_qa.py /absolute/path/to/devcel /absolute/path/to/new-fixture
```

Run the three printed commands in order: `--wizard-clean`, normal, then `--metadata-reload`. They use an isolated HOME/XDG environment and install the real CLI with a matching package manifest. The fixture checks wizard cancellation and confirmation, metadata/version validation, source isolation, failures and retries, relative paths, and saved-file updates. Inspect `wizard-clean-result.json`, `wizard-qa-result.json`, and `wizard-reload-result.json` in the generated title.

For an interactive two-source sample instead, use a separate empty directory:

```sh
python3 tests/prepare_pull_qa.py /absolute/path/to/devcel /absolute/path/to/new-sample
```

Open its `title/project.godot`. The initial sources have identical UUIDs but independent HP values 7 and 99. Follow the [Godot manual](../../../docs/manual/godot.md) to import or edit one source. The fixture's `QA.json` identifies both authoring paths.

Shared CLI tests run from the repository root:

```sh
python3 devcel-cli/tests/pull_workflow.py /absolute/path/to/devcel /absolute/path/to/new-workflow
python3 devcel-cli/tests/pull_portability.py /absolute/path/to/devcel /absolute/path/to/new-portability
```

Use new output directories. Fault injection belongs only in disposable fixtures, never in a working authoring project or installed SDK.

## Limits

Headless tests do not exercise native input, OS file dialogs, or target executables. Test the native Editor and exported games on each intended platform. String-level Windows/UNC path tests do not replace native OS checks.

Godot's standard export callback may log an error while still producing output. The atomic-publication checks cover the SDK's safe-PCK path; inspect normal executable exports separately. See the [SDK export guide](../README.md#export-a-game).

Tag-filter draft roundtrip and unknown-name preservation checks: `godot --headless --path importers/godot --script tests/test_tag_filters.gd` (run from repository root). This exercises native Godot controls; use the Editor workflow tests for full CLI publication.
