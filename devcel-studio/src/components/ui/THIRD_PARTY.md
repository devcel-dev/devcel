# shadcn/ui provenance

Basic UI components in this directory include code copied from shadcn/ui's `new-york` style and adapted for Devcel.

- Upstream: https://github.com/shadcn-ui/ui
- Comparison version: `shadcn@2.3.0`
  https://github.com/shadcn-ui/ui/tree/c8c4027b6b192822ea2952b225ee4760cddedf0d/apps/www/registry/new-york/ui
- Original license: [LICENSE.shadcn-ui](LICENSE.shadcn-ui), MIT
- Original copyright notice: Copyright (c) 2023 shadcn

Covered files are listed in the repository-root `third-party/assets.json`. The button, card, input, and separator components match the comparison version apart from line endings. Other basic components contain modifications. The original import commit is not recorded, so the comparison revision is not asserted to be the exact source revision for every file.

The `cn` function in `src/lib/utils.ts` also derives from shadcn/ui's standard utility. `reference-select`, `reference-select-popover`, and `use-toast` are outside this set of compared basic components.

Licenses for npm dependencies such as Radix UI and Lucide are covered separately by the lockfile-based third-party inventory.
