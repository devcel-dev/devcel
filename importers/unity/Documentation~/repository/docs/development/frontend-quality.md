# Frontend quality gates

[Building Studio](build-studio.md) · [Contributing](../../CONTRIBUTING.md)

Use the repository's pinned Node.js 26.12.1, npm 12.2.0 and TypeScript 7.0.2. From `devcel-studio` run:

```sh
npm ci
npm run check:lint
npm run typecheck
npm run lint
npm run build
```

These checks run locally or through Manual validation. Automatic CI, Release and frontend build commands do not execute them.

## Compiler and lint policy

`typecheck` runs the pinned TypeScript compiler with the existing strict, unused-local, unused-parameter and switch-fallthrough checks. It is separate from lint and is not replaced by a syntax-only check.

`lint` uses pinned Oxlint 1.89.0 with `--deny-warnings --max-warnings 0 --no-ignore`. A warning is a failing exit, not an allowed budget. The command covers all JavaScript/TypeScript source under `src`, including generated declarations, localized catalogs and vendored code, plus `vite.config.ts`. There are no source ignore patterns. Tooling scripts have their own executable regressions rather than being presented as application source.

[`.oxlintrc.json`](https://github.com/devcel-dev/devcel/blob/cf728cbd0e5ab872874402cf6a3bb96d52d77cdc/devcel-studio/.oxlintrc.json) explicitly freezes 116 rules at error severity: 57 ESLint, 20 React, 14 Oxc, 13 Unicorn and 12 TypeScript rules. This is the complete non-type-aware, nonexperimental correctness inventory for those plugins in the pinned release, plus `rules-of-hooks`; it includes `exhaustive-deps`, unused variables, JSX/runtime correctness and TypeScript syntax correctness. The category default is disabled only so upgrades cannot silently enable a different rule set; every selected stable rule is explicitly enabled and checked against the installed rule inventory.

Oxlint's [experimental React Compiler rules](https://oxc.rs/docs/guide/usage/linter/plugins) are not enabled because this application does not enable React Compiler. The [compiler introduction](https://oxc.rs/blog/2026-08-18-react-compiler-support.html) identifies this opt-in set. Excluded compiler rules are `error-boundaries`, `globals`, `immutability`, `incompatible-library`, `preserve-manual-memoization`, `purity`, `refs`, `set-state-in-effect`, `set-state-in-render`, `static-components`, `use-memo` and `void-use-memo`. Established hook ordering and dependency rules remain enabled. The configuration uses no style category, type-aware Oxlint companion or suppression baseline.

## Fail-closed and behavioral regressions

`check:lint` verifies the exact rule inventory, zero-warning options and complete discovered source-file list. It runs real temporary negative fixtures against the installed tools: a TypeScript assignment error, unused variable, duplicate enum value, conditional hook, missing effect dependency and exactly one warning-only diagnostic. A clean fixture must succeed. Temporary files are removed afterward.

The same command runs focused production-code regressions for:

- File-browser recursive search/sort, memo identity, range-selection updates, session invalidation and effect teardown.
- Grid geometry/layout invalidation, deferred reveal/focus, selection reconciliation and DOM property boundaries.
- Table snapshot/locale invalidation, stable mutation callbacks, sparse arrays, curve interactions and version-control cleanup.
- Editor autofocus/blur, synchronous exactly-once commits, reentrant selection, pointer/keyboard ordering and stale-session rejection. Console warnings and errors fail these runtime regressions.

The broader `check:column-filter-sort` integration suite also fails on runtime console warnings/errors, including the actual Radix autofocus path.

Tests use actual React hooks and controls with explicit native/browser boundary fixtures. They do not replace native application launch, rendering, save/reopen or platform performance checks. Do not fix dependency warnings by blindly adding changing objects to arrays or deleting intentional invalidators. Represent the actual snapshot dependencies and test the affected lifecycle instead.

## Vendored compatibility exceptions

The vendored grid and shader sources contain these compatibility annotations:

- `src/lib/drei-background/helpers/glsl/distort.vert.glsl.js`: one generated GLSL-string `eslint-disable-line`.
- `src/lib/react-data-grid/DataGrid.tsx`: one Biome ARIA compatibility comment.
- `DataGridDefaultRenderersContext.ts`, `hooks/useLatestFunc.ts`, `hooks/useRowSelection.ts`, `Columns.tsx`: four explicit-any comments.
- `utils/keyboardUtils.ts`: one deprecated-API comment.
- `TreeDataGrid.tsx`, `hooks/useGridDimensions.ts`: two unnecessary-condition comments.
- `hooks/useViewportColumns.ts`: one React Compiler compatibility comment.
- `hooks/useLatestFunc.ts`: one TypeScript compatibility `@ts-expect-error`.

Except for the GLSL path, these paths are relative to `src/lib/react-data-grid`. Not every annotation targets an active rule; the full files are still linted and typechecked under the selected policy. Reassess an exception against its upstream/type compatibility context rather than copying it to new code.
