# Specs index

Per-slice / per-task design docs. New specs land at `docs/specs/YYYY-MM-DD-<topic>-design.md` (output of the brainstorming skill). Each entry below names its matching plan under `docs/plans/` and the PR(s) that landed it.

When a spec's status changes, move its entry to the right group and add the PR reference. Per `CLAUDE.md` § Documentation maintenance, this update lands in the same PR that ships the implementation.

## Implemented

- [`2026-05-05-foundations-and-setup-design.md`](2026-05-05-foundations-and-setup-design.md) — S0+S1 walking skeleton; plan: [`../plans/2026-05-05-foundations-and-setup.md`](../plans/2026-05-05-foundations-and-setup.md). Shipped.
- [`2026-05-06-pat-scopes-and-validation-design.md`](2026-05-06-pat-scopes-and-validation-design.md) — PAT scope set + validation flow; plan: [`../plans/2026-05-06-pat-scopes-and-validation.md`](../plans/2026-05-06-pat-scopes-and-validation.md). Shipped.
- [`2026-05-06-prism-validation-prompt-set-design.md`](2026-05-06-prism-validation-prompt-set-design.md) — Validation prompt corpus. Shipped.
- [`2026-05-06-run-script-reset-design.md`](2026-05-06-run-script-reset-design.md) — `run.ps1` reset/orchestration; plan: [`../plans/2026-05-06-run-script-reset.md`](../plans/2026-05-06-run-script-reset.md). Shipped.
- [`2026-05-06-inbox-read-design.md`](2026-05-06-inbox-read-design.md) — S2 inbox (read); plan: [`../plans/2026-05-06-s2-inbox-read.md`](../plans/2026-05-06-s2-inbox-read.md). PR #4. Shipped.
- [`2026-05-07-appstatestore-windows-rename-retry-design.md`](2026-05-07-appstatestore-windows-rename-retry-design.md) — Windows AV/indexer rename race fix; plan: [`../plans/2026-05-07-appstatestore-windows-rename-retry.md`](../plans/2026-05-07-appstatestore-windows-rename-retry.md). PR #16. Shipped.
- [`2026-05-07-flaky-spa-fallback-test-fix-design.md`](2026-05-07-flaky-spa-fallback-test-fix-design.md) — Deterministic wwwroot stub for SPA fallback test; plan: [`../plans/2026-05-07-flaky-spa-fallback-test-fix.md`](../plans/2026-05-07-flaky-spa-fallback-test-fix.md). PR #16. Shipped.

## In progress

- [`2026-05-06-s3-pr-detail-read-design.md`](2026-05-06-s3-pr-detail-read-design.md) — S3 PR detail (read); plan: [`../plans/2026-05-06-s3-pr-detail-read.md`](../plans/2026-05-06-s3-pr-detail-read.md). PR1 (state migration) + PR2 (iteration clustering) shipped via PRs #14, #15. PR3+ remaining.
- [`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) — Cross-cutting structural items gated to slices. Mixed status: *Now*-gate items (banned-API analyzer, DI extension methods) shipped per `docs/roadmap.md` § Architectural readiness; named-records item still TBD; S3 / S4 / S5 / P0+ items remain open.
- [`2026-05-07-docs-sync-and-auto-update-design.md`](2026-05-07-docs-sync-and-auto-update-design.md) — Docs sync + restructure + auto-review policy; plan: [`../plans/2026-05-07-docs-sync-and-auto-update.md`](../plans/2026-05-07-docs-sync-and-auto-update.md). *In progress until the implementation PR lands.*

## Not started

- (none currently — every brainstormed spec has at least started shipping.)
