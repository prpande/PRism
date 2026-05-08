# Cursor rules for PRism

Each `.mdc` file has Cursor-specific frontmatter (`description`, `globs`, `alwaysApply`). All rule **content** lives in [`.ai/docs/`](../../.ai/docs/) and is included via `mdc:` links. See [`.ai/README.md`](../../.ai/README.md) for the full index.

| Rule file | Auto-applies | Shared doc(s) |
|-----------|----------------|---------------|
| [`base-rules.mdc`](./base-rules.mdc) | **All files** | [`repo-overview.md`](../../.ai/docs/repo-overview.md), [`development-process.md`](../../.ai/docs/development-process.md), [`architectural-invariants.md`](../../.ai/docs/architectural-invariants.md), [`behavioral-guidelines.md`](../../.ai/docs/behavioral-guidelines.md), [`operating-context.md`](../../.ai/docs/operating-context.md) |
| [`frontend.mdc`](./frontend.mdc) | `frontend/**` | [`design-handoff.md`](../../.ai/docs/design-handoff.md), [`frontend-conventions.md`](../../.ai/docs/frontend-conventions.md) |
| [`testing.mdc`](./testing.mdc) | `tests/**`, `**/*.test.*`, `**/*.spec.*` | [`development-process.md`](../../.ai/docs/development-process.md) |

## Documentation maintenance

When you add a new `.ai/docs/` topic or change which rules attach to which globs, update this table and [`.ai/README.md`](../../.ai/README.md) per [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md).
