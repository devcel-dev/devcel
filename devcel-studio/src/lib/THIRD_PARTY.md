# Code derived from editor examples

`markdown-extensions.ts` and `markdown-slash-command.tsx` adapt Novel editor examples for Devcel. Modifications include localization, supported editing actions, extension configuration, and image operations.

- Upstream: https://github.com/steven-tey/novel
- Original license: [LICENSE.novel](LICENSE.novel), Apache-2.0
- Comparison sources:
  - https://github.com/steven-tey/novel/blob/fa95098e66476c466faebb8211baa5869c101a9c/apps/web/components/tailwind/extensions.ts
  - https://github.com/steven-tey/novel/blob/fa95098e66476c466faebb8211baa5869c101a9c/apps/web/components/tailwind/slash-command.tsx

The compared upstream sources contain substantial matching extension configuration and command handling. The original import commit is not recorded; the fixed commit above is a provenance comparison reference, not a claim of the exact initial source revision. Its repository tree has no separate NOTICE file. The original license text is preserved unchanged, and adapted files carry modification notices.

For the `cn` function in `utils.ts`, see the [shadcn/ui provenance](../components/ui/THIRD_PARTY.md).
