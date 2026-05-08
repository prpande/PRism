# Specs index

Per-slice / per-task design docs. New specs land at `docs/specs/YYYY-MM-DD-<topic>-design.md` (output of the brainstorming skill). Each entry below names its matching plan under `docs/plans/`, the PR(s) that landed it, and — when present — the matching deferrals sidecar (`<source>-deferrals.md`) that records rejected/deferred alternatives from any planning or architectural decision-making session on the spec.

When a spec's status changes, move its entry to the right group and add the PR reference. Per [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md) (and [`CLAUDE.md`](../../CLAUDE.md) for Claude-only auto-review workflow), this update lands in the same PR that ships the implementation.

## Implemented

- [`2026-05-05-foundations-and-setup-design.md`](2026-05-05-foundations-and-setup-design.md) — S0+S1 walking skeleton; plan: [`../plans/2026-05-05-foundations-and-setup.md`](../plans/2026-05-05-foundations-and-setup.md). Shipped.
- [`2026-05-06-pat-scopes-and-validation-design.md`](2026-05-06-pat-scopes-and-validation-design.md) — PAT scope set + validation flow; plan: [`../plans/2026-05-06-pat-scopes-and-validation.md`](../plans/2026-05-06-pat-scopes-and-validation.md). Shipped.
- [`2026-05-06-prism-validation-prompt-set-design.md`](2026-05-06-prism-validation-prompt-set-design.md) — Validation prompt corpus. Shipped.
- [`2026-05-06-run-script-reset-design.md`](2026-05-06-run-script-reset-design.md) — `run.ps1` reset/orchestration; plan: [`../plans/2026-05-06-run-script-reset.md`](../plans/2026-05-06-run-script-reset.md). Shipped.
- [`2026-05-06-inbox-read-design.md`](2026-05-06-inbox-read-design.md) — S2 inbox (read); plan: [`../plans/2026-05-06-s2-inbox-read.md`](../plans/2026-05-06-s2-inbox-read.md). PR #4. Shipped.
- [`2026-05-07-appstatestore-windows-rename-retry-design.md`](2026-05-07-appstatestore-windows-rename-retry-design.md) — Windows AV/indexer rename race fix; plan: [`../plans/2026-05-07-appstatestore-windows-rename-retry.md`](../plans/2026-05-07-appstatestore-windows-rename-retry.md). PR #16. Shipped.
- [`2026-05-07-flaky-spa-fallback-test-fix-design.md`](2026-05-07-flaky-spa-fallback-test-fix-design.md) — Deterministic wwwroot stub for SPA fallback test; plan: [`../plans/2026-05-07-flaky-spa-fallback-test-fix.md`](../plans/2026-05-07-flaky-spa-fallback-test-fix.md). PR #16. Shipped.
- [`2026-05-07-docs-sync-and-auto-update-design.md`](2026-05-07-docs-sync-and-auto-update-design.md) — Docs sync + restructure + auto-review policy; plan: [`../plans/2026-05-07-docs-sync-and-auto-update.md`](../plans/2026-05-07-docs-sync-and-auto-update.md). PR #17. Shipped.

## In progress

- [`2026-05-06-s3-pr-detail-read-design.md`](2026-05-06-s3-pr-detail-read-design.md) — S3 PR detail (read); plan: [`../plans/2026-05-06-s3-pr-detail-read.md`](../plans/2026-05-06-s3-pr-detail-read.md); deferrals: spec [`2026-05-06-s3-pr-detail-read-deferrals.md`](2026-05-06-s3-pr-detail-read-deferrals.md) (4 Defer + 7 Skip + 5 meta-process Skip + 6 Superseded — extended in PR5 with `[Skip]` multimap-vs-(a)/(b) + `[Superseded]` cookie-only-vs-cookie-OR-header), plan [`../plans/2026-05-06-s3-pr-detail-read-deferrals.md`](../plans/2026-05-06-s3-pr-detail-read-deferrals.md) (entries from plan rigor pass + post-merge implementation deferrals — extended in PR5 with `[Defer]` SensitiveFieldScrubber pipeline wire-up + `[Superseded]` body-cap implementation shift). All five backend PRs shipped: PR1 state migration (PR #14), PR2 iteration clustering (PR #15), PR3 `IReviewService` extensions (PR #19), PR4 `PrDetailLoader` + backend endpoints (PR #21), PR5 SSE per-PR fanout + active-PR poller + `SessionTokenMiddleware` + cookie stamping + Origin tightening + `SensitiveFieldScrubber` (PR #22). Task 6 — frontend PR-detail shell — is the remaining S3 work.
- [`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) — Cross-cutting structural items gated to slices. Mixed status: *Now*-gate items (banned-API analyzer, DI extension methods) shipped per `docs/roadmap.md` § Architectural readiness; named-records item still TBD; S3 / S4 / S5 / P0+ items remain open.
- [`2026-05-08-multi-agent-ai-rules-design.md`](2026-05-08-multi-agent-ai-rules-design.md) — Shared `.ai/docs/` SSOT + slim `CLAUDE.md` + Cursor rules; plan: [`../plans/2026-05-08-multi-agent-ai-rules.md`](../plans/2026-05-08-multi-agent-ai-rules.md). In progress.

## Not started

- (none currently — every brainstormed spec has at least started shipping.)
