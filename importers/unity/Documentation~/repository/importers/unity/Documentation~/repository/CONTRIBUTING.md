# Contributing to Devcel

## Set up the application

Follow [Building Studio](docs/development/build-studio.md) for the pinned Node.js, npm, Rust, and operating-system dependencies. Use the repository lockfiles when installing dependencies.

The [documentation index](docs/README.md) links the user manual, build instructions, and integration API references.

## Make a change

Keep a change focused on one feature or defect. Describe the expected behavior and the steps that reproduce the issue. For interface changes, include screenshots and verify the application at the affected zoom levels and in both left-to-right and right-to-left languages.

Rust owns data validation, persistence, formula evaluation, and mutation rules. Studio presents that data and submits operations through the typed command interface. Update the producer, consumer, generated bindings, and fixtures together when changing a contract.

Project, table, row, and column mutations must preserve UUID identity, session ownership, revision checks, and atomic failure behavior. Test repeated actions, cancellation, stale selections, and undo/redo where they apply.

## Check the result

Run the checks relevant to your change against the final files. The commands in `devcel-studio/package.json` cover the frontend contracts and editor workflows. Common checks include:

```sh
cd devcel-studio
npm ci
npm run check:lint
npm run typecheck
npm run lint
npm run check:tauri-contracts
npm run build
```

The [frontend quality gates](docs/development/frontend-quality.md) document the frozen correctness rules, full application-source scope, zero-warning policy, and behavioral regression checks.

Run backend checks from the repository root:

```sh
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

For UI changes, start Studio and exercise the affected flow in the application. For an importer, verify the generated output and its consumer; record the engine and platform used. State which checks passed, failed, or could not run.

## Documentation and localization

Write comments and documentation in English. Preserve the localized application catalogs and intentional multilingual test data. Explain a feature where the reader needs it, with examples and current screenshots. Keep commands, field names, links, and expected results consistent with the implementation.

## Licensing

Follow each component's license and [LICENSE-NOTICE](LICENSE-NOTICE). Retain third-party copyright and license texts. When changing dependencies or bundled assets, regenerate their notices and run the license verification scripts. See [Third-party notices](third-party/README.md) for the inventory and source evidence.
