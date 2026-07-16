# Specs index

Per-slice / per-task design docs. New specs land at `docs/specs/YYYY-MM-DD-<topic>-design.md` (output of the brainstorming skill); the matching plan lives under [`../plans/`](../plans/), and most specs carry a `## Deferred work` section.

This is a **concise index** — one line per spec, grouped by status. The per-spec detail (PR breakdowns, deferral matrices, rejected alternatives) lives in each design doc itself; the feature arc lives in [`../roadmap.md`](../roadmap.md). The format was condensed from the older paragraph-per-spec style, which stopped scaling once the spec count passed ~30.

**Status note (2026-06):** the core review experience (V1) has shipped — nearly every spec below is implemented. Active work is `main` polish plus AI augmentation on the `V2` branch; day-to-day execution is issue-driven in GitHub milestones, which this index does not mirror.

**Deferred-work convention.** Per [`.ai/docs/documentation-maintenance.md`](../../.ai/docs/documentation-maintenance.md): `[Defer]` items get a `deferred`-labelled GitHub issue (the system of record) linked from the spec's `## Deferred work`; `[Skip]`/`[Superseded]` items are recorded inline only. Older specs instead carry a frozen `<source>-deferrals.md` sidecar (historical — not migrated); reference it where present. When a spec's status changes, move its entry to the right group in the same PR that ships the implementation.

## Implemented

### PoC slices & foundations (S0–S6)

- [`2026-05-05-foundations-and-setup-design.md`](2026-05-05-foundations-and-setup-design.md) — S0+S1 walking skeleton: host + port selection, Setup screen, AI seam interfaces, theme/accent, `ui.aiPreview`.
- [`2026-05-06-pat-scopes-and-validation-design.md`](2026-05-06-pat-scopes-and-validation-design.md) — PAT scope set + credential-validation flow.
- [`2026-05-06-prism-validation-prompt-set-design.md`](2026-05-06-prism-validation-prompt-set-design.md) — validation prompt corpus.
- [`2026-05-06-run-script-reset-design.md`](2026-05-06-run-script-reset-design.md) — `run.ps1` reset / dev orchestration.
- [`2026-05-06-inbox-read-design.md`](2026-05-06-inbox-read-design.md) — S2 inbox (read): five sections, dedup, `/api/events` SSE, URL-paste escape hatch.
- [`2026-05-06-s3-pr-detail-read-design.md`](2026-05-06-s3-pr-detail-read-design.md) — S3 PR detail (read): three tabs, file tree, side-by-side diff, iteration clustering, existing comments, per-PR SSE + session-token middleware.
- [`2026-05-09-s4-drafts-and-composer-design.md`](2026-05-09-s4-drafts-and-composer-design.md) — S4 drafts + composer, replies, seven-row stale-draft reconciliation matrix.
- [`2026-05-11-s5-submit-pipeline-design.md`](2026-05-11-s5-submit-pipeline-design.md) — S5 resumable GraphQL pending-review submit pipeline, per-PR lock, foreign-pending-review handling. Deferrals sidecar present.
- [`2026-05-10-multi-account-scaffold-design.md`](2026-05-10-multi-account-scaffold-design.md) — S6 PR0 multi-account storage-shape scaffold (state migration + `github.accounts` config). Deferrals sidecar present.
- [`2026-05-15-s6-polish-and-distribution-design.md`](2026-05-15-s6-polish-and-distribution-design.md) — S6 Settings page, Replace-token + identity-change rule, cheatsheet, a11y audit, `publish.yml`, first-run trust copy. Deferrals sidecar present.

### Reliability, tests & infrastructure

- [`2026-05-07-appstatestore-windows-rename-retry-design.md`](2026-05-07-appstatestore-windows-rename-retry-design.md) — Windows AV/indexer rename-race retry on `state.json` writes.
- [`2026-05-07-flaky-spa-fallback-test-fix-design.md`](2026-05-07-flaky-spa-fallback-test-fix-design.md) — deterministic wwwroot stub for the SPA-fallback test.
- [`2026-05-07-docs-sync-and-auto-update-design.md`](2026-05-07-docs-sync-and-auto-update-design.md) — docs restructure (`docs/specs`, `docs/plans`) + auto-review policy.
- [`2026-05-08-multi-agent-ai-rules-design.md`](2026-05-08-multi-agent-ai-rules-design.md) — shared `.ai/docs/` SSOT + slim `CLAUDE.md` + Cursor `mdc:` rules.
- [`2026-05-18-cross-tab-stamp-poisoning-design.md`](2026-05-18-cross-tab-stamp-poisoning-design.md) — cross-tab viewed-stamp poisoning fix. Deferrals sidecar present.
- [`2026-05-18-frozen-pr-contract-tests-design.md`](2026-05-18-frozen-pr-contract-tests-design.md) — frozen-PR live-GitHub contract-test suite (supersedes S3 Task 11). Runbook: [`../contract-tests.md`](../contract-tests.md).
- [`2026-05-18-on-disk-log-writer-design.md`](2026-05-18-on-disk-log-writer-design.md) — `FileLoggerProvider` writing dated logs under `<dataDir>/logs/` with field scrubbing. Deferrals sidecar present.
- [`2026-05-18-real-flow-e2e-playwright-design.md`](2026-05-18-real-flow-e2e-playwright-design.md) — real-flow (live GitHub) Playwright e2e suite (`playwright.real.config.ts`).
- [`2026-05-19-stale-oid-banner-investigation-design.md`](2026-05-19-stale-oid-banner-investigation-design.md) — stale `commitOID` banner investigation + instrumentation (see also the `-finding.md` note).
- [`2026-05-28-manual-validation-test-plan-design.md`](2026-05-28-manual-validation-test-plan-design.md) — manual validation test plan + suite bootstrap. Deferrals sidecar present.
- [`2026-06-06-lockfile-recycled-pid-design.md`](2026-06-06-lockfile-recycled-pid-design.md) — lockfile recycled-PID crash fix (#107).
- [`2026-06-06-parallel-agents-port-datadir-design.md`](2026-06-06-parallel-agents-port-datadir-design.md) — parallel-agent private `(port, dataDir)` testing (#217).
- [`2026-06-03-issue-resolution-workflow-design.md`](2026-06-03-issue-resolution-workflow-design.md) — agent-driven, risk-gated issue-resolution runbook (shipped as [`.ai/docs/issue-resolution-workflow.md`](../../.ai/docs/issue-resolution-workflow.md)).
- [`2026-06-06-sse-reconnect-resilience-design.md`](2026-06-06-sse-reconnect-resilience-design.md) — SSE reconnect resilience + subscription accounting (#141/#142).
- [`2026-06-11-verdict-kebab-unification-design.md`](2026-06-11-verdict-kebab-unification-design.md) — verdict wire kebab unification + dead-enum delete (#318, epic #317).
- [`2026-06-11-github-provider-robustness-design.md`](2026-06-11-github-provider-robustness-design.md) — GitHub provider read-path hardening: absent-PR cache eviction, reviews Link-walk pagination, typed REST-contract exception, per-item JSON isolation, terminal-CI TTL (#322; folds #361).

### v1 ship & desktop

- [`2026-05-28-v1-completion-roadmap-design.md`](2026-05-28-v1-completion-roadmap-design.md) — post-S6 v1 ship phases (README restructure, publish workflow, first tag). Deferrals sidecar present.
- [`2026-06-02-electron-desktop-shell-design.md`](2026-06-02-electron-desktop-shell-design.md) — v0.2.0 Electron desktop shell (.NET sidecar, single-instance, Host-header defense). Deferrals sidecar present.
- [`2026-06-07-agent-detached-launcher-design.md`](2026-06-07-agent-detached-launcher-design.md) — `serve-detached.ps1` health-gated detached dev-server launcher (#266/#269).
- [`2026-06-11-desktop-launchers-design.md`](2026-06-11-desktop-launchers-design.md) — from-source detached desktop launchers (`run-desktop.ps1` / `run-desktop.sh`), Windows + macOS (#306); manual validation tracked in [#369](https://github.com/prpande/PRism/issues/369).

### PR-detail & diff

- [`2026-06-01-real-side-by-side-diff-rendering-design.md`](2026-06-01-real-side-by-side-diff-rendering-design.md) — real side-by-side diff renderer. Deferrals sidecar present.
- [`2026-06-01-whole-file-context-expansion-design.md`](2026-06-01-whole-file-context-expansion-design.md) — on-demand whole-file context expansion. Deferrals sidecar present.
- [`2026-06-01-pr-root-post-and-submit-discard-design.md`](2026-06-01-pr-root-post-and-submit-discard-design.md) — PR-root comment post + submit/discard handling.
- [`2026-06-04-pr-detail-syntax-highlighting-design.md`](2026-06-04-pr-detail-syntax-highlighting-design.md) — Shiki syntax highlighting in the diff.
- [`2026-06-04-pr-tab-state-keepalive-design.md`](2026-06-04-pr-tab-state-keepalive-design.md) — keep-alive PR tabs (view-state across navigation); deferred hardening in [#161](https://github.com/prpande/PRism/issues/161) / [#160](https://github.com/prpande/PRism/issues/160).
- [`2026-06-04-root-comment-cards-design.md`](2026-06-04-root-comment-cards-design.md) — PR-root conversation comment cards.
- [`2026-06-05-condense-pr-header-on-scroll-design.md`](2026-06-05-condense-pr-header-on-scroll-design.md) — collapsible PR-detail header + Files-toolbar density trim (#128).
- [`2026-06-05-diff-settings-menu-design.md`](2026-06-05-diff-settings-menu-design.md) — diff settings menu (#185).
- [`2026-06-05-file-tree-visual-polish-design.md`](2026-06-05-file-tree-visual-polish-design.md) — file-tree visual polish (#187).
- [`2026-06-05-open-in-github-button-design.md`](2026-06-05-open-in-github-button-design.md) — open-in-GitHub button (#131).
- [`2026-06-06-214-tree-sticky-hscrollbar-design.md`](2026-06-06-214-tree-sticky-hscrollbar-design.md) — file-tree sticky horizontal scrollbar (#214).
- [`2026-06-07-font-size-control-design.md`](2026-06-07-font-size-control-design.md) — PR-detail content font-size control (#135).
- [`2026-06-09-287-inline-comment-redesign-design.md`](2026-06-09-287-inline-comment-redesign-design.md) — inline comment redesign (shared CommentCard + composer frame) (#287).
- [`2026-06-09-302-decouple-commenting-design.md`](2026-06-09-302-decouple-commenting-design.md) — decouple single-comment posting from atomic submit (#302).
- [`2026-06-10-pr-detail-header-actions-design.md`](2026-06-10-pr-detail-header-actions-design.md) — PR-detail header actions: review split-button, Ask-AI pull-tab, open-in-GitHub (#291).
- [`2026-06-11-shared-composer-core-design.md`](2026-06-11-shared-composer-core-design.md) — shared composer-core extraction (`useDraftComposer` + ActionsBar/Modals) (#326).
- [`2026-07-17-checks-tab-prefetch-design.md`](2026-07-17-checks-tab-prefetch-design.md) — eager check-runs prefetch on PR-detail open (dwell-bounded, one issued request per head; poll loop stays tab-gated) (#743).

### Inbox

- [`2026-06-02-merged-pr-history-design.md`](2026-06-02-merged-pr-history-design.md) — recently-closed inbox section + read-only detail gap closure (P4-D2). Deferrals sidecar present.
- [`2026-06-06-inbox-group-by-repo-design.md`](2026-06-06-inbox-group-by-repo-design.md) — inbox group-by-repo (FE-fold grouping) (#133).
- [`2026-06-07-inbox-row-layout-design.md`](2026-06-07-inbox-row-layout-design.md) — inbox row layout (bounded-rhythm list, aligned metrics) (#227).
- [`2026-06-07-inbox-taxonomy-design.md`](2026-06-07-inbox-taxonomy-design.md) — inbox taxonomy + filters (ci-failing, needs-re-review) (#262/#263).
- [`2026-06-08-inbox-merged-query-input-design.md`](2026-06-08-inbox-merged-query-input-design.md) — merged query/paste input (type-filter + paste-open) (#262).
- [`2026-06-09-inbox-ci-checks-indicator-design.md`](2026-06-09-inbox-ci-checks-indicator-design.md) — inbox CI + PR-state leading status glyphs (#264, builds on #286).
- [`2026-06-09-inbox-section-order-design.md`](2026-06-09-inbox-section-order-design.md) — customizable inbox section order (#275).
- [`2026-06-10-285-inbox-unread-bar-design.md`](2026-06-10-285-inbox-unread-bar-design.md) — inbox "new changes" unread bar reset-on-view (#285).
- [`2026-07-10-activity-rail-visibility-gate-design.md`](2026-07-10-activity-rail-visibility-gate-design.md) — activity-rail 90s poll gated on `document.visibilityState`, mirroring the #717 inbox precedent (#732, PR #757); the resume-window freshness cue is deferred (see the spec's `## Deferred work`, #753).
- [`2026-06-10-inbox-cohesion-toolbar-design.md`](2026-06-10-inbox-cohesion-toolbar-design.md) — inbox cohesion: toolbar→card + two-layout rail gate + sort restyle (#300).
- [`2026-06-10-inbox-group-by-repo-toggle-design.md`](2026-06-10-inbox-group-by-repo-toggle-design.md) — inbox group-by-repo Settings toggle (#219).
- [`2026-06-10-inbox-manual-refresh-design.md`](2026-06-10-inbox-manual-refresh-design.md) — inbox manual Refresh button (#311).
- [`2026-06-10-inbox-visual-polish-design.md`](2026-06-10-inbox-visual-polish-design.md) — inbox visual polish (CI-glyph centering, per-theme hover, spacing) (#345/#347).
- [`2026-06-11-inbox-ci-status-refresh-design.md`](2026-06-11-inbox-ci-status-refresh-design.md) — inbox CI-status refresh (#355); same-SHA TTL follow-up in [#361](https://github.com/prpande/PRism/issues/361).
- [`2026-06-09-activity-rail-real-data-design.md`](2026-06-09-activity-rail-real-data-design.md) — activity rail real `received_events` data (Phase 1 + Phase 2) (#137); bots Settings UI deferred to [#316](https://github.com/prpande/PRism/issues/316).

### Settings, onboarding, auth & chrome

- [`2026-06-06-settings-redesign-design.md`](2026-06-06-settings-redesign-design.md) — Settings redesign (#134).
- [`2026-06-06-preferences-context-design.md`](2026-06-06-preferences-context-design.md) — `PreferencesContext` dedup (single shared GET) (#143).
- [`2026-06-06-setup-pat-guidance-design.md`](2026-06-06-setup-pat-guidance-design.md) — Setup PAT guidance (classic vs fine-grained) (#213).
- [`2026-06-06-first-run-welcome-landing-design.md`](2026-06-06-first-run-welcome-landing-design.md) — first-run `/welcome` landing (#212).
- [`2026-06-06-help-feedback-surface-design.md`](2026-06-06-help-feedback-surface-design.md) — in-app Help modal + routed Feedback submission (#210/#211).
- [`2026-06-06-header-wordmark-design.md`](2026-06-06-header-wordmark-design.md) — header wordmark (unauthed) (#215).
- [`2026-06-06-ai-toggle-reactivity-design.md`](2026-06-06-ai-toggle-reactivity-design.md) — AI-toggle reactivity via shared `aiPreview` (#221).
- [`2026-06-09-default-ai-preview-on-design.md`](2026-06-09-default-ai-preview-on-design.md) — default AI preview on + decoupled activity-rail flag (#283).
- [`2026-06-10-312-github-reauth-surface-design.md`](2026-06-10-312-github-reauth-surface-design.md) — mid-session GitHub re-auth surface (token-revocation banner + exit-gate) (#312).
- [`2026-06-05-first-run-nav-design.md`](2026-06-05-first-run-nav-design.md) — first-run navigation routing (#130).

### Visual polish

- [`2026-06-04-light-theme-contrast-design.md`](2026-06-04-light-theme-contrast-design.md) — light-theme contrast fixes.
- [`2026-06-04-spinner-design.md`](2026-06-04-spinner-design.md) — branded loading spinner / LoadingScreen visual.
- [`2026-06-04-tabstrip-chrome-design.md`](2026-06-04-tabstrip-chrome-design.md) — PR tab-strip chrome.
- [`2026-06-05-author-avatars-design.md`](2026-06-05-author-avatars-design.md) — author avatars (#127).
- [`2026-06-05-error-box-design.md`](2026-06-05-error-box-design.md) — shared error treatment / ErrorModal (#182).
- [`2026-06-05-keepalive-skeleton-precedence-design.md`](2026-06-05-keepalive-skeleton-precedence-design.md) — keep-alive vs skeleton precedence (#180).
- [`2026-06-05-mermaid-error-leak-design.md`](2026-06-05-mermaid-error-leak-design.md) — Mermaid error-node leak fix (#191).
- [`2026-06-06-loading-affordance-design.md`](2026-06-06-loading-affordance-design.md) — loading affordances / skeletons + global top bar (#181/#147).
- [`2026-06-09-navbar-edge-and-icon-hover-polish-design.md`](2026-06-09-navbar-edge-and-icon-hover-polish-design.md) — nav-bar light-edge + gear icon hover polish (#289/#290).
- [`2026-05-29-design-parity-recovery-design.md`](2026-05-29-design-parity-recovery-design.md) — design-parity recovery roadmap (PR1–PR9).
- [`2026-05-31-design-parity-pr9b-ai-gating-design.md`](2026-05-31-design-parity-pr9b-ai-gating-design.md) — AI-gating for design-parity PR9b.

## In progress

- [`2026-06-25-138-checks-tab-design.md`](2026-06-25-138-checks-tab-design.md) — read-only PR-detail **Checks** tab (live-polled CI check list + tab-strip health glyph) ([#138](https://github.com/prpande/PRism/issues/138)); re-trigger and sibling-endpoint owner/repo validation deferred (see the spec's `## Deferred work`). Plan: [`../plans/2026-06-25-138-checks-tab.md`](../plans/2026-06-25-138-checks-tab.md).
- [`2026-06-10-desktop-cold-start-instrumentation-design.md`](2026-06-10-desktop-cold-start-instrumentation-design.md) — desktop cold-start instrumentation. Part 1 shipped; **Part 2** (splash / compression decision) is open against [#282](https://github.com/prpande/PRism/issues/282), pending a clean-VM cold-start measurement.
- [`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md) — cross-cutting structural items gated to slices. *Now*-gate items shipped (banned-API analyzer, DI extension methods); later-gate items tracked in [`../roadmap.md`](../roadmap.md) § "Architectural readiness".
- [`2026-07-10-reload-banner-self-origin-design.md`](2026-07-10-reload-banner-self-origin-design.md) — stop the PR-detail reload banner from announcing the user's own inline comment posts ([#740](https://github.com/prpande/PRism/issues/740)); nets self-posts at `ActivePrPoller` before raising a comment frame (option G, origin reading). Plan: [`../plans/2026-07-10-reload-banner-self-origin.md`](../plans/2026-07-10-reload-banner-self-origin.md).

## Not started (no committed design doc yet)

Several active threads have open GitHub issues but no design doc on disk yet — they are tracked in GitHub, not here:

- **Code-quality epic** ([#317](https://github.com/prpande/PRism/issues/317)) — duplication / structure / dead-code sweep (sub-issues #319–#338).
- **Comment-composer family** (#352 / #353 / #354) — align Overview/Drafts composer + list UI with the diff-tab CommentCard family.
- **Activity-rail follow-ups** (#359 stale-while-revalidate, #360 configurable window, #315 group-by-repo, #316 bots Settings UI).
- **v2 AI features** — see the prioritized [backlog](../backlog/); design docs land here as each is brainstormed.
