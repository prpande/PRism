---
source-doc: docs/specs/2026-05-11-s5-submit-pipeline-design.md
created: 2026-05-11
last-updated: 2026-05-13
status: open
revisions:
  - 2026-05-11: brainstorm + ce-doc-review pass — recorded brainstorm-time deferrals (12 items in spec § 1.2), doc-review-time deferrals routed to ce-plan, doc-review FYI observations, and forward-looking residual risks for the implementer
  - 2026-05-12: PR #43 review pass — marked Risk R1 (MigrateV3ToV4 signature mismatch) Resolved after spec § 6 was corrected to the JsonObject step shape
  - 2026-05-12: PR0a execution — added the "Implementation-time deferrals" section (IDraftReconciliator dead-code not deleted; IReviewSubmitter CA1040 suppression; GitHub-test concrete return type; PRismWebApplicationFactory override re-typed)
  - 2026-05-12: PR1 execution — R16 applied to spec § 4 (interface now 7 methods, adds DeletePendingReviewThreadAsync); added PR1 implementation-time decisions (GraphQL transport reuse; FindOwn single-query shape; DeletePendingReviewThreadAsync via comment-deletes since GitHub has no thread-delete mutation; CreatedAt → DateTimeOffset; test-fake stubs; Task 19 partial-split skipped). GraphQL input/field shapes confirmed via introspection — recorded in docs/spec/00-verification-notes.md.
  - 2026-05-12: PR2 execution — added PR2 implementation-time decisions (DraftComment.ThreadId trailing `= null` default; PipelineMarker line-state fence detection per R10, ≤3-space cap; PendingReviewThreadSnapshot.CreatedAt added for the multi-marker earliest-adopt; PR-root drafts fail loud in StepAttachThreads; body-cap left to the composer; CA1034/CA1064/CA1032 suppressions on the new union/exception types; no logging in SubmitPipeline so R9's scrub-audit is a no-op for PR2) and PR2 preflight-review fixes (FindOwnPendingReviewAsync widened to include threads we only replied to; Step 3/4 null-snapshot → retryable failure; all overlay UpdateAsync calls wrapped → SubmitFailedException, success-clear swallows; residuals: IsParentThreadGone is fake-only, lost-Begin → foreign-prompt, reply multi-match orders by id)
  - 2026-05-12: PR3 execution — added PR3 implementation-time decisions (endpoint follows R1/R5/R6 + the PR2-shipped SubmitPipeline API over the stale Task 36-38/41 sketches; submit-* bus events named `Submit*BusEvent` and live in PRism.Core/Events implementing IReviewEvent; DraftSubmitted published but not SSE-subscribed; PUT /draft JsonElement op-resolution rule keeps the typed-record-serializing tests green; SubmitErrorDto uses `{code,message}`; body-cap predicate extended with explicit full-suffix EndsWith; SubmitLockRegistry/Handle internal per CA1515; getCurrentHeadShaAsync re-polls IPrReader so the endpoint takes IPrReader; `SubmitEndpointsTestContext` test harness built since the plan's Task 36-39 referenced non-existent factory helpers) and the [Known issue] pre-existing Playwright e2e failures (verified on base commit `d6d15c2`)
  - 2026-05-12: PR4 execution — added PR4 implementation-time decisions (SubmitButton takes `headShaDrift: boolean` not `headSha`/`lastViewedHeadSha`; `useSubmit.state.success.pullRequestReviewId` left empty since no submit-* SSE payload carries the review id — success "View on GitHub" links to the PR page; AI gating lives in PrHeader's `useCapabilities`/`usePreferences` and passes data down — same gate as "self-gating", matches the OverviewTab pattern; the in-flight dialog body stays rendered-but-disabled rather than literally collapsing to header+checklist, per the spec's own "verdict picker frozen but visible" line; foreign-pending-review-prompt + stale-commit-oid dialog states get placeholder UI in PR4, full ForeignPendingReviewModal/StaleCommitOidBanner are PR5). R2 (merged SubmitProgressIndicator), R3 (SubmitInProgressBadge), R4 (real useEventSource API), R12 (250ms-debounced summary auto-save + live preview), R15 (responsive widths via `.modal-dialog:has(.submit-dialog)` + a structural assertion since jsdom doesn't load tokens.css) applied.
  - 2026-05-12: PR4 PR-#48 review fixes — preflight `ce-adversarial-reviewer` (4 Important + 5 Minor, all fixed in place: SSE-races-the-POST clobber, retry-resets-steps, no-refetch-on-success, focus-trap-escapes-in-flight, + 5 minors). Copilot ×1 round (stray repo-root `node_modules/.vite/vitest/.../results.json` untracked + `node_modules/`/`.vite/` added to root `.gitignore`; 3 nits fixed: stale `[open]` deps comment, `summary.length>0`→`.trim()` consistency with SubmitButton, clear `ownsActiveSubmit` on `foreign-pending-review-prompt`). `@claude review` Action (issue #1 fixed: SubmitProgressIndicator renders a ✗ failed row, not the "checking…" spinner, when Step 1/2 fails; #4 fixed: `confirmingRef` guard against double-Confirm during the flushSummary round-trip; #5 fixed: "next slice" → user-facing copy; key-on-canned-data minor → `key={severity:message}`; #2 [eslint-disable react-hooks/exhaustive-deps] = [Skip] — no react-hooks plugin in the config so the directive would fail lint as an unknown-rule reference; #3 [hardcoded github.com in the success link] = [Defer] — GHES is out of PoC scope and the hardcoding is app-wide).
  - 2026-05-13: PR5 execution — full ForeignPendingReviewModal + DiscardConfirmationSubModal + ImportedDraftsBanner + StaleCommitOidBanner + DiscardAllDraftsButton + DiscardAllConfirmationModal + useSubmitToasts shipped (Tasks 53–58 + 60; Task 59 backend pre-Finalize re-poll was already landed in PR2/PR3). Marked the PR4 "[Defer] placeholder UI for foreign-pending-review-prompt + stale-commit-oid" entry Resolved. Added PR5 implementation-time decisions: `useToast` made non-throwing (no-op default context); `notReloadedYet` proxied off `headShaDrift` since no `submit-stale-commit-oid` SSE field carries a wasReloaded flag; stale-banner `currentHeadSha` is `data.pr.headSha` (may lag the real new head until Reload); `ImportedDraftsBanner` rendered in `PrHeader` below the tab strip (where `useSubmit` lives) rather than inside the Drafts-tab panel — `useSubmit` gained `lastResume`/`clearLastResume`; per-draft "Resolved on github.com" row badge deferred (needs the backend to persist `isResolved` on imported `DraftComment`s); `ForeignPendingReviewModal` swaps the parent `<Modal open={!discardOpen}>` for the sub-modal rather than nesting two `<Modal>`s; `useMediaQuery` added as a small reusable hook for the `<600px` label shortening; `submit-duplicate-marker-detected.draftId` naming kept as-is.
  - 2026-05-13: PR5 preflight + PR-#49 review fixes — ce-adversarial-reviewer (2 Important: Resume/Discard flash+focus-jump → PrHeader closes the dialog synchronously before awaiting; double-click → spurious 409 toast → `foreignActionInFlightRef` re-entry guard in useSubmit. 4 Minor: discardAllDrafts→SubmitConflictError parity; Esc handler skipped while delegating; malformed-resume-response defends; createdAt NaN guard). Copilot ×1 round (5 inline: Esc-handler already fixed in the preflight commit; removed the unused `prRef` prop from DiscardAllDraftsButton; threaded `prState` into DiscardAllConfirmationModal so the copy names "closed"/"merged" PR accurately rather than the spec's literal "closed PR"; extracted `prRefKey()` to `api/types.ts` and reuse it in useSubmit + useSubmitToasts; the no-in-flight-state concern is covered by the re-entry guard + synchronous dialog close). Claude Code Review Action: no findings on this PR.
  - 2026-05-13: PR7 execution (DoD E2E test sweep, plan Phase 7 Tasks 61–70) — added the PR7 subsection under "Implementation-time deferrals": the PR0b-vs-PR7-first decision (chose defensive PR7 + `--workers=1`), the `--workers=1` requirement for the e2e suite, the `/test/mark-pr-viewed` + `/test/reset` hardening, the retry-from-each-step E2E covering Begin/AttachThreads/Finalize (not AttachReplies — Core-unit-tested), the marker-collision composer-`unsaved`-not-`rejected` observation, the multi-tab-409-reverts-to-idle observation, the closed-merged loader-cache-bust + stale-commitOID `/reload`-poll flow artifacts, and the `/test/submit/*` endpoint naming/superset vs the plan's Task 61 sketch. Marked the PR1 "test-fake stubs" decision and the PR3 "the shared E2E FakeReviewSubmitter stays NotImplementedException" decision Resolved (FakeReviewSubmitter is now a working in-memory submitter). PR7 is the last S5 PR — S5's demo + DoD-test scope is complete; `status:` stays `open` because the remaining entries here are forward-looking (S6 / P0+) or PR0b (off the demo critical path).
---

# Deferrals — S5 submit pipeline spec

Items considered during brainstorm or surfaced by `compound-engineering:ce-doc-review` that are deliberately not landing in S5. Each entry names the source (brainstorm decision, doc-review persona finding, or planning observation), the severity, the rationale, and the trigger that should reopen the decision.

The 30 decisions enumerated in [`2026-05-11-s5-submit-pipeline-design.md`](2026-05-11-s5-submit-pipeline-design.md) § 17 are the *applied* decisions. This sidecar records the *not-applied* set so future readers can see what was weighed and why each item didn't land.

---

## Brainstorm-time deferrals (target a specific later slice)

### [Defer] Real `IPreSubmitValidator` AI implementation

- **Source:** Brainstorm 2026-05-11 (handoff § "AI placeholder coverage that lights up in S5")
- **Severity:** P2 (PoC scope; v2 feature)
- **Date:** 2026-05-11
- **Reason:** PoC ships `NoopPreSubmitValidator` registered in DI; the placeholder card under `aiPreview: true` renders frontend-side canned data only (matching S0–S4 precedent). Real validators (concrete `Concern` / `Blocking` results that gate Submit Review button rule (d)) ship in v2 P0+ when an `ILlmProvider` is wired and the dogfood + N=3 validation gate has passed.
- **Revisit when:** v2 P0+ kicks off (per `docs/spec/01-vision-and-acceptance.md` § "What 'shipped' means for v2") and the AI feature workstream picks `IPreSubmitValidator` for an early surface.
- **Where the gap lives in code:** PoC will register `NoopPreSubmitValidator` (`PRism.AI.NoopPreSubmitValidator` per `docs/spec/04-ai-seam-architecture.md` § DI registration). v2 swaps to a real impl; no Core changes needed.

### [Defer] Real `IPrChatService` chat backend

- **Source:** Brainstorm 2026-05-11; doc-review surfaced cut from interactive drawer
- **Severity:** P2 (PoC scope; v2 P2-2 feature)
- **Date:** 2026-05-11
- **Reason:** PoC ships the Ask AI button + a static "coming in v2" empty-state container (per spec § 14.2, revised after doc-review). No `IPrChatService` interface exists today; v2 P2-2 introduces both the interface and the implementation. Ship the seam (button + container) without the chat surface to avoid setting up an interaction the tool can't deliver.
- **Revisit when:** v2 P2-2 (PR chat with repo access) starts. C4 empirical gate (clean-end `--resume`) and C8 (head-shift cumulative-injection model behavior) per `docs/spec/00-verification-notes.md` block this work.
- **Where the gap lives in code:** Frontend's Ask AI button is gated on `aiPreview` directly; capability flag `ai.chat` stays `false` in `/api/capabilities`. v2 introduces `PRism.AI.Contracts/IPrChatService.cs` and a `ClaudeCodeChatService` impl per `docs/spec/04-ai-seam-architecture.md` § Sustained chat.

### [Defer] Interactive Ask AI drawer with pre-baked conversation seed

- **Source:** Brainstorm 2026-05-11 (originally in scope for S5 PR6); cut by ce-doc-review (Product-lens + scope-guardian, anchor 100 cross-persona promotion)
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** Originally scoped as a right-side 480px drawer with message bubbles, "AI is typing…" indicator, and a disabled input bar with a "Chat coming in v2" tooltip. Doc-review surfaced the validation-gate footgun: an external trial cohort (N=3 per `docs/spec/01-vision-and-acceptance.md` § validation gate) flipping `aiPreview: true` would hit a chat surface that *looks* real, type into the disabled input, read the tooltip, and file the experience as "tool feels half-done" — a "I went back to GitHub.com" outcome not because the wedge fails but because the demo-mode lies. The S0–S4 placeholder precedent the original design invoked is not analogous: prior placeholders are display surfaces (chips, badges, summary card), not interactive affordances. The drawer is cut to a static empty state (per spec § 14.2) so testers see honest "coming in v2" framing instead of a fake-feeling chat.
- **Revisit when:** v2 P2-2 ships real chat. The button + empty-state container preserves the architectural seam — v2's `IPrChatService` lazy-upgrade slots into the same affordance without testers having seen a fake version first.
- **Where the gap lives in code:** Spec § 14.2 defines the empty-state container; v2 swaps it for the drawer's actual chat surface.

### [Defer] `IPrDetailLoader.GetFiles()` rename/delete map wiring

- **Source:** S4 deferral 7 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md)); originally proposed for S5 PR1; cut by ce-doc-review (Coherence + scope-guardian, anchor 100 cross-persona promotion)
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** Originally proposed as part of S5 PR1 alongside the GitHub adapter work, with the rationale "submit pipeline benefits (drafts on renamed files pre-adapt; drafts on deleted files block per stale-gate)." Doc-review surfaced that the existing reconciliation matrix (S4 PR3) already produces `Stale` for unmapped renames and deletions — the wiring is an *accuracy improvement* (re-anchors renamed-file drafts as `Moved` instead of `Stale`) rather than a submit-pipeline correctness requirement. The submit pipeline's stale-gate rule (b) already enforces blocking on Stale drafts regardless of how the staleness was detected. Bundling the wiring into PR1 inflates PR1's scope (new GraphQL capability seam + reconciliation adapter fix in one PR — two unrelated surfaces) without delivering load-bearing value to S5's demo bar.
- **Revisit when:** S6 polish work picks it up, OR a standalone follow-up PR after S5 ships if dogfooding surfaces "I keep losing draft anchors on renames." Closes S4 deferral 7 when it lands.
- **Where the gap lives in code:** `PRism.Web/Endpoints/PrReloadEndpoint.cs` (or wherever the reload handler lives) currently passes empty `renames` / `deletedPaths` maps to `DraftReconciliationPipeline.ReconcileAsync`. The fix wires `IPrDetailLoader.GetFiles()` results into those maps. Unit tests already cover the pipeline behavior with explicit maps (`PRism.Core.Tests/Reconciliation/Pipeline/RenameTests.cs`, `DeleteTests.cs`); E2E coverage for the full path lands when this ships.

### [Defer] Bulk-discard + `deletePullRequestReview` cleanup on closed/merged PR — *partially shipped in S5*

- **Source:** S4 deferral 1 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Status update:** Closed in S5 — see spec § 13. The bulk-discard button, confirmation modal, courtesy `deletePullRequestReview` call, and `submit-orphan-cleanup-failed` toast all land in S5 PR5.
- **Note:** Listed here for traceability; the original S4 deferral entry is now resolved.

### [Defer] PR-reopen reconciliation + foreign-pending-review prompt — *closed in S5*

- **Source:** S4 deferral 2 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Status update:** Closed in S5 — see spec § 11. The foreign-pending-review modal with TOCTOU defense ships in S5 PR5.

### [Defer] `IReviewService` capability split — *closed in S5*

- **Source:** S4 deferral 3; ADR-S5-1 ([`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md))
- **Status update:** Closed in S5 — see spec § 3. The split lands as PR0 (pure refactor).

### [Defer] PR3 verdict-clear wire-shape gap — *closed in S5*

- **Source:** S4 deferral 5 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Status update:** Closed in S5 — see spec § 10. Switching the patch wire-shape to `JsonElement`-based parsing (option (b) from S4 deferral 5) lands in S5 PR3.

### [Defer] `markAllRead` + submit-endpoint authorization tightening to ownership-strict

- **Source:** S4 deferral 6 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md)); ce-doc-review security-lens RR-001
- **Severity:** P3 (PoC scope per `docs/spec/02-architecture.md` § 6.2 threat model)
- **Date:** 2026-05-11
- **Reason:** Spec § 7.1 / § 13.3 explicitly adopt the same broader-than-spec authorization pattern (`cache.IsSubscribed(prRef)` — any cookieSessionId subscribed to this PR ref) that `markAllRead` uses. Tightening to subscriber-ownership across both endpoints in one swing is a separate cleanup; PoC threat model (single-user, localhost, OriginCheckMiddleware + SameSite=Strict + per-process session token) accepts the broader pattern. The risk materializes only if multi-tab replay of a session token from a stale background tab fires a destructive endpoint (discard-all, foreign-pending-review discard) on a PR the submitting tab did not initiate; TOCTOU defense + confirmation modals reduce but do not eliminate this surface.
- **Revisit when:** Either the threat model materially changes (e.g., multi-user setup, networked deployment) OR S6 polish work hardens both endpoints together. Tightening one without the other adds inconsistency without adding security.
- **Where the gap lives in code:** `PRism.Web/Endpoints/MarkAllReadEndpoint.cs` and the new submit endpoints in PR3.

### [Defer] `IActivePrCache.HighestIssueCommentId` populated by `ActivePrPoller`

- **Source:** S4 deferral 4 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** Submit pipeline's head-shift gate (rule (f)) compares `head_sha` only, not per-issue-comment IDs. The poller does not need to grow a new fetch in S5. The MarkAllRead button continues to no-op the backend cursor advance in production; the SSE event still fires, the inbox badge resolves locally.
- **Revisit when:** A user-visible feature surfaces that needs per-comment-id ordering (e.g., a "since last visit" filter on the existing-comments inline rendering) OR dogfooding shows users actually using markAllRead on real PRs and noticing the no-op.
- **Where the gap lives in code:** `IReviewService.PollActivePrAsync` (post-split: `IPrReader.PollActivePrAsync`) returns a count, not an ID. The poller (`PRism.Web/Polling/ActivePrPoller.cs` or equivalent) writes `null` to `HighestIssueCommentId`.

### [Defer] Discard-failure consolidated toast / inline-error system

- **Source:** S4 deferral 8 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** S5 uses a one-time toast for the bulk-discard courtesy `deletePullRequestReview` failure (per spec § 13.2 step 4) and an inline banner + Retry for submit-pipeline failures (per spec § 8.3). These are bespoke per-surface error UX; a consolidated toast/inline-error system (with error-bus, severity badge vocabulary, accessibility contract) ships in S6 polish where multiple surfaces benefit.
- **Revisit when:** S6 polish work consolidates error UX across composers, submit dialog, foreign-pending-review modal, and any other surface that surfaces transient failures.
- **Where the gap lives in code:** S5 ships independent toast call sites; S6 introduces a shared error component or hook.

### [Defer] File-fetch concurrency cap on reload

- **Source:** S4 deferral 9 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** S4 ships sequential reconciliation; cap deferred until dogfooding shows >5s reload on 50-draft PRs. S5's submit pipeline is also sequential by design (per § 4 / decision 6); the same cap pattern would apply to submit fan-out if it lands, but the throughput envelope (per § 17 #ADV-S5-08 FYI) hasn't surfaced as a real concern yet.
- **Revisit when:** Dogfooding hits the latency cliff on either reload or submit fan-out for large reviews.
- **Where the gap lives in code:** `PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs` (sequential foreach over drafts) and the analogous `SubmitPipeline.AttachThreads` step.

### [Defer] Generic merger walker for future array fields in `useDraftSession`

- **Source:** S4 deferral 10 ([`2026-05-09-s4-drafts-and-composer-deferrals.md`](2026-05-09-s4-drafts-and-composer-deferrals.md))
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** S5 does not introduce a third user-edited array on `ReviewSessionDto`. The submit dialog uses the existing `DraftSummaryMarkdown` string field for PR-level summary; no co-edit array. The diff-and-prefer merger in `useDraftSession` (S4 Task 36) keeps its hardcoded shape.
- **Revisit when:** A future slice adds a third user-edited array on `ReviewSessionDto` that needs open-composer protection (i.e., something the user is actively editing, not display-only data like `IterationOverrideDto[]`).
- **Where the gap lives in code:** `frontend/src/hooks/useDraftSession.ts` merger step (S4 Task 36).

### [Defer] Dangling-reply detection (parent thread deleted after successful reply submit)

- **Source:** Spec § 5.2 step 4 "Dangling-reply edge case" (inherited from `docs/spec/03-poc-features.md` § 6)
- **Severity:** P3 (accepted edge per spec § 6)
- **Date:** 2026-05-11
- **Reason:** If a reply was successfully posted in a prior submit and the parent thread is later deleted by its author, the reply persists on github.com as an orphan with a missing parent. PRism does not actively detect this case during submit retry — the verify step checks "does the reply still exist," not "does its parent still exist." Spec accepts this as an edge case; the user's content is preserved on GitHub, just without conversational context.
- **Revisit when:** A future P4 polish item adds poll-time detection of dangling replies and surfaces a "your reply on PR #X lost its parent" notification.
- **Where the gap lives in code:** `SubmitPipeline.AttachReplies` step's verify branch (per spec § 5.2 step 4).

### [Defer] ADR-S5-2 partial-class split of `GitHubReviewService`

- **Source:** ADR-S5-2 ([`2026-05-06-architectural-readiness-design.md`](2026-05-06-architectural-readiness-design.md)); spec § 1.2 non-goals
- **Severity:** P3 (optional)
- **Date:** 2026-05-11
- **Reason:** Not load-bearing; do during PR1 if `GitHubReviewService.cs` becomes unwieldy after the new submit methods land. Spec § 16 PR1 carries the conditional inclusion.
- **Revisit when:** PR1 implementation makes the file feel too large to navigate; OR a later slice adds another batch of methods that pushes it past comfort.
- **Where the gap lives in code:** `PRism.GitHub/GitHubReviewService.cs`.

### [Defer] Multi-line / range comments

- **Source:** S4 deferral (general; doc-review noted "Best landing point: a focused multi-line slice between S5 and S6, OR P4 backlog")
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** Reconciliation matrix doubles in dimensionality with multi-line; expanding before single-line is dogfooded is premature. The submit pipeline doesn't depend on multi-line semantics.
- **Revisit when:** Dogfooding shows reviewers asking for multi-line on real PRs (multi-line is GitHub's secondary affordance via shift-click; PRism could ship single-line-only and gather signal). Best landing point is a focused multi-line slice between S5 and S6, OR P4 backlog.
- **Where the gap lives in code:** Single-line is encoded in `DraftComment` (no `start_line` field). Multi-line would extend `DraftComment` with `StartLineNumber` + reconciliation matrix updates.

---

## Brainstorm-time deferrals (target S6 polish)

### [Defer] File-viewed graph-walk semantics

- **Source:** S3 deferral 4 ([`2026-05-06-s3-pr-detail-read-deferrals.md`](2026-05-06-s3-pr-detail-read-deferrals.md)); brainstorm 2026-05-11 explicitly considered for S5 and punted to S6
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** Originally named "Likely S4 or S5" by the S3 deferral. S4 didn't ship it. S5 brainstorm explicitly considered pulling it in; rejected because (a) parallel to submit, no submit-pipeline coupling; (b) own DTO + frontend compute surface; (c) S5 is already 8 PRs against a tight DoD bar; (d) S6's "polish" framing is the right home for "subtly-wrong affordance" cleanup. Risk: S6 is the *last* slice before the validation gate, so this is the final chance to fix it before the N=3 trial — flagged as a residual concern in product-lens RR-01.
- **Revisit when:** S6 polish work picks it up. Backend surfaces `ViewedFiles` in `PrDetailDto` and commit `changedFiles` data, enabling the frontend to compute accurate viewed status per spec § 7.2.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — `viewedPaths` is `useState<Set<string>>(new Set())` with no initialisation from backend data.

### [Defer] Shiki syntax highlighting in DiffPane

- **Source:** S3 PR8 deferral ([`2026-05-06-s3-pr-detail-read-deferrals.md`](2026-05-06-s3-pr-detail-read-deferrals.md))
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** Visual-only polish with no submit-pipeline coupling; S5 is already at-capacity against the DoD bar. The S3 deferral originally said "S5 or S6 polish round"; narrowed to S6 in this brainstorm.
- **Revisit when:** S6 polish round addresses syntax coloring across the diff surface.
- **Where the gap lives in code:** `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`.

---

## Doc-review-time deferrals (deferred to `ce-plan`)

These items surfaced during the 7-persona ce-doc-review pass and are deferred to the planning step rather than the spec. The plan picks each based on codebase exploration.

### [Defer] PR0a/PR0b split — capability split + empirical gates separate from state-leak fix?

- **Source:** ce-doc-review scope-guardian SG-02 (anchor 75)
- **Severity:** P2 (planning decision)
- **Date:** 2026-05-11
- **Reason:** Spec § 2.3 + § 16 PR0 bundle the IReviewService capability split + C6/C7/C9 empirical gates + Playwright multi-spec state-leak fix into one PR. SG-02 surfaced that the state-leak has zero dependency on the other items, so the bundling is sequencing-by-convention. The escalation valve in § 2.3 ("if root-cause exceeds 1 day, escalate") makes the worst-case manageable, but the cleanest split keeps unrelated risk profiles separate.
- **Revisit when:** ce-plan reads the codebase, scopes the state-leak fix, and decides whether splitting PR0 into PR0a (refactor + gates) and PR0b (state-leak fix) buys schedule benefit. If the state-leak hypothesis converges on a same-day fix during PR0 scoping, keep one PR; otherwise split.

### [Defer] Octokit GraphQL helper vs raw `HttpClient` for `GitHubReviewService.Submit.cs`

- **Source:** Spec § 18.2 (deferred to planning)
- **Severity:** P3 (planning decision)
- **Date:** 2026-05-11
- **Reason:** PR1 implementer picks based on existing GraphQL usage in `PRism.GitHub`. Currently no GraphQL surface in PRism; both paths are greenfield. Octokit's GraphQL helper is more typed; raw `HttpClient` is more flexible for evolving multi-mutation patterns.
- **Revisit when:** ce-plan PR1 task definition.

### [Defer] Per-step persistence boundary inside `SubmitPipeline`

- **Source:** Spec § 18.2 (deferred to planning); feasibility R3
- **Severity:** P2 (planning decision)
- **Date:** 2026-05-11
- **Reason:** Spec § 5.2 step 3 says "persist after every stamp" — does each successful per-thread `AttachThreadAsync` call `AppStateStore.UpdateAsync` directly, or does the pipeline accumulate updates and persist at step-boundary granularity (after all threads attached)? Both produce correct lost-response recovery; per-stamp persistence has higher disk write rate but stronger recovery; per-step has cleaner control flow but loses per-thread crash recovery within a step.
- **Revisit when:** ce-plan PR2 task definition. Recommendation: per-stamp persistence (matches spec wording; the disk-write cost is minimal in PoC scope and the stronger crash recovery is what the spec promises).

### [Defer] `submit-progress` SSE event payload shape (PascalCase vs kebab-case)

- **Source:** Spec § 18.2 (deferred to planning)
- **Severity:** P3 (planning decision)
- **Date:** 2026-05-11
- **Reason:** Existing SSE events use camelCase property names; the kebab-vs-PascalCase choice for enum *values* is a small consistency call. PoC convention TBD.
- **Revisit when:** ce-plan PR3 task definition.

### [Defer] `SensitiveFieldScrubber` blocked-fields extension

- **Source:** ce-doc-review security-lens SEC-005 (anchor 50, FYI); spec § 18.2
- **Severity:** P2 (planning decision; lands in PR3)
- **Date:** 2026-05-11
- **Reason:** Existing scrubber blocks `subscriberId`, `pat`, `token`. Submit pipeline introduces new structured-log fields: `pendingReviewId`, `threadId`, `replyCommentId`. These are live GitHub-issued identifiers; if logged, could be correlated with a specific user's in-flight review. Add to `BlockedFieldNames` before any submit-pipeline logging call sites land.
- **Revisit when:** PR3 implementation; add the three field names to the blocked list before merging.
- **Where the gap lives in code:** `PRism.Web/Logging/SensitiveFieldScrubber.cs`.

### [Defer] Submit dialog component placement (modal vs portal vs inline)

- **Source:** Spec § 18.2 (deferred to planning); ce-doc-review design-lens DQ-01
- **Severity:** P3 (planning decision)
- **Date:** 2026-05-11
- **Reason:** Existing `<Modal>` component uses `className="modal-backdrop"` without a portal — renders in the React tree wherever it's mounted. If the Submit dialog is mounted inside `PrHeader` (where the Submit Review button lives), a scrolling PrDetail page could clip the dialog. Plan should verify the existing Modal's non-portal approach works for a 720px-wide scrollable dialog or decide to introduce `React.createPortal` here.
- **Revisit when:** ce-plan PR4 task definition.

### [Defer] Confirmation sub-modal for Resume — pre-fetch vs post-fetch

- **Source:** Spec § 18.2 (deferred to planning); ce-doc-review design-lens DQ-02
- **Severity:** P3 (planning decision)
- **Date:** 2026-05-11
- **Reason:** Spec § 11.1 sends Resume request immediately on single-click with TOCTOU re-fetch server-side; user sees no confirmation before import. Alternative: gate with a "found N threads — continue?" pre-fetch confirmation. Current shape is single-click + the staleness banner above imported drafts; adding a sub-modal would add a click but provide pre-action visibility.
- **Revisit when:** ce-plan PR5 task definition.

---

## Doc-review FYI observations (not actioned, not blocking)

These items came up at confidence anchor 50 (verified-but-advisory) during ce-doc-review. Listed for traceability; no spec action required.

### [Skip] V4 schema migration with empty transform body is "ceremony"

- **Source:** ce-doc-review scope-guardian SG-04 (anchor 50, FYI)
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** Spec § 6 introduces a v3→v4 migration step whose body is a no-op (additive `ThreadId` field; null-default handled by deserializer). SG-04 argued this is unnecessary ceremony — the migration framework's `Steps[]` array doesn't require every structural change to produce a step.
- **Why skipped:** Counter-argument: the user's standing memory feedback ("Document plan deviations in deferrals/plan — capture the decision visibly, never silent") + spec § 4.5's "schema-versioned migration" framing make the visible version bump worth the modest noise. Empty migration files document the schema change for chronological scanning even when no transform is needed.
- **Revisit when:** N/A unless future contributors raise the migration-noise concern with new evidence.

### [Skip] Dialog pixel widths in spec are implementer judgment

- **Source:** ce-doc-review scope-guardian SG-05 (anchor 50, FYI)
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** Spec § 8.5 includes a responsive breakpoint table with explicit pixel widths (720px dialog, 480px modals). SG-05 argued these are implementer-time CSS judgments that don't belong in the spec.
- **Why skipped:** Counter-argument: the responsive table is a coherence surface — without it, four different surfaces (dialog, foreign-pending-review modal, bulk-discard sub-modal, Ask AI empty state) would have inconsistent breakpoints. The table is the contract the implementer commits to; CSS is the implementation.
- **Revisit when:** N/A unless the implementer pushes back on the specific values during PR4.

### [Skip] § 17 enumerates 30 decisions, several restating spec-body content

- **Source:** ce-doc-review scope-guardian SG-06 (anchor 50, FYI)
- **Severity:** P3
- **Date:** 2026-05-11
- **Reason:** Spec § 17 doubles up on content already in the spec body (e.g., #8 PR-level summary in dialog, #9 Esc behavior, #10 Cancel disabled). SG-06 argued for trimming.
- **Why skipped:** Counter-argument: the explicit decision-log is the project's auditing format. The list serves as a flat scannable register of every choice made, with cross-references back to the spec section. Redundancy with the spec body is a feature for auditability, not noise.
- **Revisit when:** N/A unless future contributors raise the duplication concern with use-case evidence.

### [FYI] Sequential fan-out + Cancel-disabled is unbounded for large reviews

- **Source:** ce-doc-review adversarial ADV-S5-08 (anchor 50, FYI)
- **Severity:** P2 (advisory)
- **Date:** 2026-05-11
- **Reason:** A 50-draft + 20-reply review hits ~71 sequential GitHub round-trips at p50 ~500ms = 35-90 seconds of pipeline. Cancel is disabled; dialog locked; per-step progress is the only feedback. No abort path; closing the tab leaves the pipeline running server-side.
- **Why not actioned:** PoC dogfooding hasn't surfaced this as a real concern. Adding a soft-abort (Cancel enabled at step boundaries only) or a throughput-envelope advisory in the spec is premature. Revisit if first dogfooding session hits the latency cliff.
- **Revisit when:** Dogfooding shows reviewers composing 50+ draft reviews regularly.

### [FYI] PR0 state-leak escalation has no defined fallback if root-cause is multi-week

- **Source:** ce-doc-review adversarial ADV-S5-09 (anchor 50, FYI)
- **Severity:** P2 (advisory)
- **Date:** 2026-05-11
- **Reason:** Spec § 2.3 has an escalation valve ("if root-cause exceeds 1 day of refactor, escalate to user") but no fallback if escalation reveals a multi-week refactor. The spec's hard commitments (§ 15.3 "no test.fixme" + decision 21 "no more test.fixme suites in S5") would then collide with reality.
- **Why not actioned:** Partially addressed by spec § 18.2's PR0a/PR0b split option. The full-fledged "option A vs option B" fallback (block S5 vs accept tagged test.fixme) is escalation-time decision rather than spec content.
- **Revisit when:** PR0 state-leak investigation actually escalates.

### [FYI] PR6 weight may shrink to fold into PR4

- **Source:** ce-doc-review product-lens P3 (anchor 50, FYI)
- **Severity:** P3 (advisory)
- **Date:** 2026-05-11
- **Reason:** With the Ask AI drawer cut to a static empty state (decision 16, post-revision), PR6 carries only the validator card slot wiring + the Ask AI button + empty state container. PR4 is the natural home.
- **Status (2026-05-12):** Actioned in the plan — PR6 is folded into PR4. With PR0 also pre-split into PR0a + PR0b, the net deliverable count is 8 (PR0a, PR0b, PR1, PR2, PR3, PR4, PR5, PR7). Reflected in spec § 16 / § 17 #22, `docs/roadmap.md`, and `docs/specs/README.md`.

---

## Forward-looking residual risks (for plan and implementer)

These aren't deferred decisions — they're known unknowns the plan / implementer should watch.

### [Resolved] `MigrateV3ToV4` example signature mismatch with actual migration pipeline

- **Source:** ce-doc-review feasibility R1
- **Severity:** P3 (doc-internal accuracy issue)
- **Date raised:** 2026-05-11 · **Resolved:** 2026-05-12
- **Reason:** An earlier doc-review draft of spec § 6 sketched the migration as `AppState Apply(AppState v3) => v3 with { Version = 4 }`, which doesn't compile against `AppStateStore.MigrationSteps` (operates on `JsonObject → JsonObject`).
- **Resolution:** Spec § 6 now shows the correct `JsonObject` step (`public static JsonObject MigrateV3ToV4(JsonObject root) { root["version"] = 4; return root; }`) wired into `MigrationSteps[]`, plus a "Note on shape" paragraph explaining why the `with`-expression sketch would not compile. No PR2 correction needed; left here for traceability.

### [Risk] `IProgress<SubmitProgressEvent>` → SSE bridge has no codebase precedent

- **Source:** ce-doc-review feasibility R2
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** Existing `SseChannel` publishes only via `IReviewEventBus`. Spec § 5.1 + § 7.4 introduce an `IProgress<SubmitProgressEvent>` impl that publishes `submit-progress` SSE events; the bridge needs to either route progress events through the bus (extending `SseEventProjection.Project` with a new arm — fits FanoutProjected pattern + threat-model defenses) or expose a side-channel `SseChannel` API.
- **Action:** ce-plan PR3 picks. Recommendation: bus-routed (matches existing pattern).

### [Risk] PR0 scope is largest of the 8-PR cut

- **Source:** ce-doc-review feasibility R4 + scope-guardian SG-02
- **Severity:** P2
- **Date:** 2026-05-11
- **Reason:** ADR-S5-1 capability split touches every consumer of `IReviewService` across `PRism.Web` + tests + Playwright fake. C6/C7/C9 empirical gates are sub-day. Playwright state-leak investigation is unbounded. The spec's escalation valve mitigates worst case but PR0's combined surface is still the largest in the slice.
- **Action:** Watch for PR0 split during planning per § 18.2; the state-leak fix can land in PR0b in parallel with PR1 if it converges on >same-day.

### [Risk] Per-PR submit lock must NOT be `AppStateStore._gate`

- **Source:** ce-doc-review adversarial residual on submit lock vs _gate
- **Severity:** P1 (deadlock vector if implemented incorrectly)
- **Date:** 2026-05-11
- **Reason:** Spec § 7.1 says the per-PR submit lock is "a separate primitive from `AppStateStore._gate`." Putting submit-pipeline serialization on `_gate` would (a) block every other PR's draft writes for the duration of any one PR's submit, (b) re-introduce the publication-vs-_gate ordering hazard the § 5.2 step 5 paragraph defends against. Implementer must register the lock as a separate primitive (e.g., `SemaphoreSlim` keyed by `prRef` in DI).
- **Action:** PR3 implementation. Tested by the multi-tab simultaneous-submit test in PR7.

### [Risk] TOCTOU Snapshot B → DeletePendingReviewAsync window

- **Source:** ce-doc-review adversarial residual + security-lens SEC-002
- **Severity:** P3 (microseconds wide; theoretical)
- **Date:** 2026-05-11
- **Reason:** Spec § 7.2/7.3 re-fetch Snapshot B before acting, but the window between Snapshot B and the actual `DeletePendingReviewAsync` call is microseconds wide. Theoretically vulnerable but not exploitable without an adversary who can race inside the same RPC.
- **Action:** Accepted as residual; flagged for awareness only. No code change required.

### [Risk] Cross-tab DraftId collisions during simultaneous draft creation

- **Source:** ce-doc-review adversarial residual
- **Severity:** P3 (out of scope for S5)
- **Date:** 2026-05-11
- **Reason:** If state.json's session is per-PR-not-per-tab (which the S4 design implies), then across-tab DraftId collisions during submit are also possible if both tabs created drafts at the same time and the cross-tab presence banner from S4 was dismissed.
- **Action:** Out of scope for S5; revisit if dogfooding surfaces it.

### [Risk] Snapshot A→B body-level staleness is not detected (count-only check)

- **Source:** PR #43 review feedback (claude-bot, high priority — surfaced post-doc-review)
- **Severity:** P3 (silent acceptance of an edge case)
- **Date:** 2026-05-11
- **Reason:** Spec § 11.1 (revised) computes Snapshot A↔B staleness entirely on the frontend by comparing thread/reply counts retained from the SSE event against the resume endpoint's 200 response. Per-thread body-level changes (same count, different content) are not detected — doing so would require carrying per-thread body hashes through the `submit-foreign-pending-review` SSE event, which the threat-model defense in § 7.5 currently keeps body-free. The dominant attacker / collaborator case (thread added or removed during the prompt delay) is captured; the residual case (thread body edited in place during the prompt delay) silently flows through to the user's adjudication panel where they can still edit / discard before re-publishing.
- **Action:** Accepted as PoC residual. If dogfooding surfaces a real instance where in-place body edits during the prompt window matter, add per-thread body-hash carriage to the SSE payload (the hash is privacy-preserving and the threat-model surface is narrower than full bodies). PR5 implementer carries the count-only check; no spec change without new evidence.

---

## Implementation-time deferrals (surfaced during PR execution)

Decisions made while executing the plan that diverge from a literal task body or the "Files touched" lists. Captured here so a reviewer comparing the PR to the plan sees the rationale.

### [Decision] `DraftComment.ThreadId` ships with a trailing `= null` default

- **Source:** PR2 execution (2026-05-12)
- **Affects:** Plan Task 21 Step 5 (which shows `string? ThreadId);` with no default and instructs "Every existing constructor call site for `DraftComment` must pass `ThreadId` … fix each"); spec § 6's `DraftComment` code block (also no default).
- **Decision:** Added `string? ThreadId = null` rather than a required positional parameter. Trailing defaults on persistent-state records already have precedent in the codebase (`DraftThreadRequest.{StartLine, StartSide}` are `= null` reserved fields), and `ThreadId` is *only* ever a non-null value when `SubmitPipeline.AttachThreads` stamps it — every other construction site (composer endpoints, reconciliation test fixtures, and PR2's own pipeline-test fixtures) wants `null`. The default avoids touching ~21 unrelated call sites across 9 files and keeps the pipeline-test fixtures terse. JSON-deserialization behavior is unchanged either way (absent property → `null`). `DraftReply.ReplyCommentId` stays without a default because it sits mid-list and a trailing default is the only kind C# allows — the asymmetry is mechanical, not a convention break.
- **Revisit when:** N/A — intended end state. If a future field on `DraftComment` genuinely must be supplied at every call site, make it non-defaulted then.

### [Defer] PR-root drafts are not submittable via the pending-review pipeline

- **Source:** PR2 execution (2026-05-12)
- **Affects:** Plan Task 27 Step 3 (`StepAttachThreadsAsync` — the plan's code does `FilePath: draft.FilePath ?? throw new InvalidOperationException(...)`); spec § 5.2 step 3 (iterates "each `DraftComment`" without addressing the PR-root case).
- **Decision:** A `DraftComment` with `FilePath`/`LineNumber` null (a PR-root comment — created by `PUT /draft`'s `addPrComment` patch with `Side: "pr"`) can't be attached as an inline thread on a pending review: GitHub's `addPullRequestReviewThread` requires a path + line, and a pending review has no "PR-root comment" slot distinct from the review summary body. Rather than the plan's `InvalidOperationException` (which would escape `SubmitAsync`'s `catch (SubmitFailedException)` unhandled) or silently dropping the user's comment, `StepAttachThreadsAsync` throws `SubmitFailedException(AttachThreads, "draft … has no diff anchor; …")` — surfacing as a `SubmitOutcome.Failed` the user can act on (discard / rewrite). Folding PR-root drafts into the review summary on submit is a possible v2 behavior; it's a design choice the spec doesn't make today.
- **Revisit when:** Dogfooding surfaces users actually creating PR-root drafts and expecting them to submit, OR a follow-up adds "merge PR-root drafts into the review summary on submit" to the spec.

### [Defer] Body-cap (GitHub's ~65 536-char review-comment limit, marker overhead included) enforcement is composer-side

- **Source:** PR2 execution (2026-05-12); spec § 4 ("body-cap accounting includes the marker") + the user's PR2 task summary listing it under Task 22.
- **Affects:** Plan Task 22 (`PipelineMarker` — the plan's code has no body-cap logic); spec § 4.
- **Decision:** `PipelineMarker.Inject` does not truncate. The plan's Task 22 implementation has no body-cap handling either; the spec's "body-cap accounting includes the marker" is satisfied by the composer's `PUT /draft` cap (PR3 Task 41) reserving room for the marker (`Prefix.Length` + draft id + `Suffix.Length` + separators + a possible fence-close). `PipelineMarker.GitHubReviewBodyMaxChars` is exposed as a public const for that composer cap to subtract from. If an over-cap body ever reaches `Inject` anyway, `AttachThreadAsync` fails GitHub-side and the pipeline returns `Failed(AttachThreads, …)` — retryable once the user trims.
- **Revisit when:** PR3 implements the `PUT /draft` cap and decides exactly how much overhead to reserve; or dogfooding hits a "my long comment got rejected on submit with no warning" report (then move a defensive truncation into `Inject`).

### [Decision] PR2 widens `FindOwnPendingReviewAsync` to include threads the pending review only replied to

- **Source:** PR2 preflight adversarial review (2026-05-12) — flagged Critical: Step 4 would demote every reply to Stale in production.
- **Affects:** `PRism.GitHub/GitHubReviewService.Submit.cs` (`FindOwnPendingReviewAsync` thread filter) — a PR1-shipped method; touched here because PR2's Step 4 depends on it being correct, and spec § 5.2 step 4 ("verify the reply comment still exists … the snapshot from Step 1 enumerates per-thread comments; check there") assumes the snapshot includes a reply's parent thread.
- **Decision:** PR1 grouped review threads to the pending review by their *root* comment's `pullRequestReview.id`. That's right for threads the pending review *created* (Step 3's lost-response marker scan), but a `DraftReply` replies to an *existing* comment whose thread's root belongs to a *prior* review — so that thread was being filtered out, and Step 4's `parent is null` branch (intended for "the parent thread was deleted") fired for *every* reply: demote-to-Stale + `Failed(AttachReplies)`, breaking the demo's "reply to a comment, submit" flow. PR2 changes the filter to "include a thread iff our pending review owns *any* comment on it" (the query already fetches each comment's `pullRequestReview.id`). A replied-to-only thread's `BodyMarkdown` is its (foreign) root comment's body — which carries no PRism marker, so Step 3's marker scan never false-adopts it; its `Comments` include our reply (with our marker), so Step 4's verify + the lost-response reply-adoption work. `GitHubReviewServiceSubmitFindOwnTests` gains a case for this.
- **Revisit when:** N/A — intended end state. (If PR1's narrower behavior was relied on anywhere else, this would surface; nothing in the codebase did.)

### [Decision] `FindOwnPendingReviewAsync` now fails loud on a truncated per-thread comment chain

- **Source:** PR2 review (2026-05-12) — Copilot flagged that widening the thread filter to "any comment is ours" made the inclusion decision depend on `comments(first: 100)` not being truncated.
- **Affects:** `PRism.GitHub/GitHubReviewService.Submit.cs` (`FindOwnPendingReviewAsync`), and the PR1 deferral "[Defer] Review-thread pagination in `FindOwnPendingReviewAsync`" which had said the per-thread `comments(first: 100)` cap was "left without a guard … a truncated reply chain degrades gracefully".
- **Decision:** With the filter widened, a truncated comment chain is no longer harmless — if a thread has >100 comments and our pending reply is on page 2, the inclusion test (`comments.Any(c => c.pullRequestReview.id == pendingReviewId)`) returns false → the thread is wrongly excluded → Step 4's `parent is null` branch demotes a reply we actually posted. So `FindOwnPendingReviewAsync` now reads `comments.pageInfo.hasNextPage` per thread and throws `GitHubGraphQLException` on any thread with >100 comments — same fail-loud-over-partial stance as the existing `reviewThreads.hasNextPage` guard, with the same trade-off (a submit on a PR that has *any* review thread with >100 comments fails visibly until cursor pagination lands). 100+ comments on a single review thread is exotic enough for a 1-user PoC, and the loud failure names exactly what happened. Cursor pagination on both `reviewThreads` and `comments` is the proper fix (deferred); a general GraphQL-connection-pagination utility in `PRism.GitHub` would cover this, the timeline cap, and this one together.
- **Revisit when:** Dogfooding hits a PR with a >100-comment review thread, OR the GraphQL-connection-pagination utility lands.

### [Residual] Step 4's `IsParentThreadGone` message-match is fake-only; the real adapter path self-heals in two attempts

- **Source:** PR2 preflight adversarial review (2026-05-12).
- **Affects:** `SubmitPipeline.StepAttachRepliesAsync` — the `catch (Exception ex) when (IsParentThreadGone(ex))` branch.
- **Reason:** `IsParentThreadGone` matches `ex.Message`, but `GitHubGraphQLException` (which `PRism.Core` can't reference by type) puts the GraphQL error text in `ErrorsJson`, not `Message`. So if the parent thread is deleted *between* the Step-4 snapshot fetch and the `AttachReplyAsync` call, the catch-when filter is false → the generic catch produces `Failed(AttachReplies, "GitHub GraphQL request returned N error(s).")` without demoting. On retry the snapshot now reflects the deletion → the `parent is null` branch demotes properly. So it self-heals in two attempts with a slightly cryptic message on the first; the `IsParentThreadGone` match still works for the `InMemoryReviewSubmitter` fake (which throws `HttpRequestException("NOT_FOUND: …")`). The clean fix is a typed not-found exception in `PRism.Core` thrown by the adapter — deferred.
- **Revisit when:** A `PRism.Core`-level "node not found" exception type is introduced, or dogfooding shows the two-attempt self-heal is confusing in practice.

### [Residual] Lost `addPullRequestReview` response → the pipeline's own pending review is surfaced as "foreign"

- **Source:** PR2 preflight adversarial review (2026-05-12); spec § 5.2 step 1 already chooses this.
- **Affects:** `SubmitPipeline` Step 1's `else` branch (PendingReviewId null / mismatched → `ForeignPendingReviewPromptRequired`).
- **Reason:** If `BeginPendingReviewAsync` succeeds server-side but the response (or the subsequent `StampPendingReview` persist) is lost, the session has `PendingReviewId == null` while a pending review exists on the PR with no threads yet (so no marker to recognise it by). Step 1 can't tell it's ours → returns `ForeignPendingReviewPromptRequired`; the endpoint's modal lets the user Resume it. Recovery exists; the modal copy should hedge ("a pending review exists that PRism has no local record of") rather than assert another author.
- **Revisit when:** PR3/PR4 write the foreign-pending-review modal copy.

### [Decision] PR0a does NOT delete the `IDraftReconciliator` AI seam dead code

- **Source:** PR0a execution (2026-05-12)
- **Affects:** Plan Phase 1a "Files touched" list ("Delete: `PRism.AI.Contracts/Seams/IDraftReconciliator.cs` … `Noop/NoopDraftReconciliator.cs` … `PRism.AI.Placeholder/PlaceholderDraftReconciliator.cs` … `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs`"), annotated "legacy seam not consumed; retired with `DraftReview`".
- **Decision:** Kept all four files. `IDraftReconciliator` is **not** related to `DraftReview` — its method is `ReconcileAsync(PrReference, IReadOnlyList<DraftCommentInput>, …) → IReadOnlyList<DraftReconciliation>`, none of which touch the retired `DraftReview` record. It is also still wired: `PRism.Web/Composition/ServiceCollectionExtensions.cs` registers `NoopDraftReconciliator` / `PlaceholderDraftReconciliator` in the `AiSeamSelector` Noop/Placeholder dictionaries. Deleting it would mean editing the AI composition root for a change unrelated to the `IReviewService` capability split — out of PR0a's stated scope ("Land the architectural prerequisites" for the submit pipeline). PR0a deletes only `IReviewService.cs` and `PRism.Core.Contracts/DraftReview.cs` (the latter genuinely orphaned once the `SubmitReviewAsync` stub is removed).
- **Revisit when:** A dedicated AI-seam-cleanup PR (or whenever `IDraftReconciliator` is either given a real consumer in v2 or formally removed from `AiSeamSelector`). Not blocking S5.

### [Decision] `IReviewSubmitter` carries a CA1040 suppression

- **Source:** PR0a execution (2026-05-12)
- **Affects:** Plan Task 1 Step 4 (bare empty `interface IReviewSubmitter {}` code block).
- **Decision:** The repo's analyzer config treats CA1040 ("Avoid empty interfaces") as a build error, so the literal code block does not compile. Added `[SuppressMessage("Design", "CA1040:Avoid empty interfaces", Justification = "Intentional empty capability seam … PR1 fills it with the seven pending-review pipeline methods.")]` to `PRism.Core/IReviewSubmitter.cs`. PR1 removes the suppression once the seven methods land.
- **Revisit when:** PR1 (the suppression should be deleted in the same commit that adds the methods).

### [Decision] `tests/PRism.GitHub.Tests/*` factory helpers return the concrete `GitHubReviewService`

- **Source:** PR0a execution (2026-05-12)
- **Affects:** Plan Task 3's "swap to the narrowest sub-interface" rule.
- **Decision:** That rule targets *production* consumers. The 7 GitHub adapter test files had `private static IReviewService NewService(…)` / `Make(…)` helpers that construct `new GitHubReviewService(…)`. Changed the return type to the concrete `GitHubReviewService` rather than picking a per-file sub-interface — these tests exercise the GitHub adapter directly, so the concrete type is the honest contract and avoids an arbitrary interface choice per file.
- **Revisit when:** N/A — this is the intended end state for adapter-level tests.

### [Decision] `PRismWebApplicationFactory.ReviewServiceOverride` re-typed; `StubReviewService` narrowed

- **Source:** PR0a execution (2026-05-12)
- **Affects:** `tests/PRism.Web.Tests/TestHelpers/PRismWebApplicationFactory.cs`.
- **Decision:** `ReviewServiceOverride` was typed `IReviewService?` (the now-deleted composite). Re-typed to `PrDetailFakeReviewService?` (the only type ever assigned to it); that fake now implements all four capability interfaces and the factory binds the single instance to all four seams — preserving the old single-override semantics exactly. `StubReviewService` (the `ValidateOverride` branch) is narrowed to `IReviewAuth` since `ValidateCredentialsAsync` is the only method it implemented meaningfully. Added a private `ReplaceSingleton<T>` helper to dedupe the remove-then-add pattern.
- **Revisit when:** N/A.

### [Decision] PR1 reuses the adapter's existing GraphQL transport rather than the plan's greenfield `GraphqlAsync` helper

- **Source:** PR1 execution (2026-05-12)
- **Affects:** Plan Phase-2 Task 12 Step 4 (the `GraphqlAsync` helper + `application/json` Accept header + `"graphql"` relative endpoint + `HttpRequestException`-on-errors code block); Tasks 13–17 test assertions (`HttpRequestException` → `GitHubGraphQLException`).
- **Decision:** `GitHubReviewService` already has a GraphQL transport — `PostGraphQLAsync(query, variables, ct)` + `HostUrlResolver.GraphQlEndpoint(_host)` (absolute URL, GHES-aware) + `GitHubGraphQLException` + `ThrowIfGraphQLErrorsWithoutData`. The plan's code samples were written as if the adapter were greenfield. PR1 reuses `PostGraphQLAsync` and adds one thin wrapper, `PostSubmitGraphQLAsync`, that is *stricter* about errors: it throws `GitHubGraphQLException` on ANY non-empty `errors` array (a mutation that reports errors did not apply, so partial-data tolerance — correct for the read-side multi-field fetches — would be wrong here) and on a missing `data` object. Spec § 4 § note updated to point at this. All submit-method tests assert `GitHubGraphQLException` for the GraphQL-error path.
- **Revisit when:** N/A — this is the intended end state. The spec explicitly delegated transport choice to the implementer per `PRism.GitHub` conventions (§ 4).

### [Decision] `FindOwnPendingReviewAsync` uses one schema-correct query, not the plan's two-call `viewer{login}` + `review.threads` shape

- **Source:** PR1 execution (2026-05-12)
- **Affects:** Plan Task 17 Step 3 + Step 4 (the `ResolveViewerLoginAsync` two-call sequence and the `reviews(...){nodes{... threads(first:100){...}}}` query) and Test 3's assertions (`author: { login:` → `viewerDidAuthor`).
- **Decision:** The plan's query referenced `PullRequestReview.threads`, which does not exist in GitHub's GraphQL schema — `PullRequestReview` exposes `comments`, and the thread-level fields the snapshot needs (`isResolved`, `diffSide`, `line`, `originalLine`) live on `PullRequestReviewThread`, reachable via `pullRequest.reviewThreads`. The implementation issues one round-trip: `reviews(first: 50, states: [PENDING]){nodes{id viewerDidAuthor commit{oid} createdAt}}` + `reviewThreads(first: 100){nodes{id path line diffSide originalLine isResolved comments(first:100){nodes{id body originalCommit{oid} pullRequestReview{id}}}}}`. It picks the viewer's pending review via `viewerDidAuthor` (so no separate `viewer{login}` lookup is needed) and groups review threads to it by their root comment's `pullRequestReview.id`. `OriginalCommitOid` comes from the root comment's `originalCommit.oid`; `OriginalLineContent` stays empty for PR5's Resume endpoint to enrich (it has no file content).
- **Revisit when:** N/A — this is the intended end state. If a future read needs richer per-thread data, extend the same query.

### [Decision] `DeletePendingReviewThreadAsync` is implemented via comment-deletes — GitHub has no `deletePullRequestReviewThread` mutation

- **Source:** PR1 execution (2026-05-12), surfaced by the pr-autopilot preflight review (schema introspection)
- **Affects:** Plan Task 16 (which describes "a `deletePullRequestReviewThread` GraphQL mutation taking `pullRequestReviewThreadId`") and Task 29 (the multi-marker-match defense, which calls `DeletePendingReviewThreadAsync` to drop duplicate threads).
- **Decision:** GitHub's GraphQL `Mutation` type has no `deletePullRequestReviewThread` (introspection confirmed: `DeletePullRequestReviewThreadInput` resolves to `null`; the only delete mutations are `deletePullRequestReview` and `deletePullRequestReviewComment`). A review thread disappears once its last comment is deleted, so the adapter implements `DeletePendingReviewThreadAsync(reference, threadId, ct)` by (1) resolving the thread's comment IDs via `node(id: $threadId){ ... on PullRequestReviewThread { comments(first:100){nodes{id}} } }`, then (2) deleting each via `deletePullRequestReviewComment(input:{id})`. A `node:null` result (thread already gone) is treated as success — the caller is best-effort. The **interface signature is unchanged** (still takes a thread ID), so PR2's Task 29 needs no rework: it still calls `DeletePendingReviewThreadAsync(reference, dupThreadId, ct)` exactly as planned. In the multi-marker scenario the duplicate threads carry only their body comment (replies are attached to the one adopted thread), so this is a single delete per duplicate; the loop covers the rare with-replies case. Spec § 4's `DeletePendingReviewThreadAsync` comment was updated to note the implementation. Also confirmed by the same introspection pass: the add/submit input shapes the plan used (`AddPullRequestReviewInput.{pullRequestId,commitOID,body}`, `AddPullRequestReviewThreadInput.{pullRequestReviewId,body,path,line,side}`, `AddPullRequestReviewThreadReplyInput.{pullRequestReviewId,pullRequestReviewThreadId,body}`, `SubmitPullRequestReviewInput.{pullRequestReviewId,event}`, `DeletePullRequestReviewInput.{pullRequestReviewId}`) are all correct, and the `FindOwnPendingReviewAsync` query's field set (`PullRequest.reviews(first,states)`, `PullRequestReview.{viewerDidAuthor,commit.oid,createdAt}`, `PullRequest.reviewThreads`, `PullRequestReviewThread.{path,line,diffSide,originalLine,isResolved,comments}`, `PullRequestReviewComment.{id,body,originalCommit.oid,pullRequestReview.id}`) all exist — recorded in `docs/spec/00-verification-notes.md`.
- **Revisit when:** N/A — this is the intended end state. If GitHub ever adds a real thread-delete mutation, the adapter can switch to the single-call form without changing the interface.

### [Decision] `OwnPendingReviewSnapshot.CreatedAt` is `DateTimeOffset`, not `DateTime`

- **Source:** PR1 execution (2026-05-12), surfaced by the pr-autopilot preflight review
- **Affects:** Spec § 4's `OwnPendingReviewSnapshot` code block (originally `DateTime CreatedAt`).
- **Decision:** Every GitHub-sourced timestamp the `PRism.GitHub` adapter projects uses `DateTimeOffset` (e.g. `Pr.CreatedAt` via `JsonElement.GetDateTimeOffset()`, the clustering timeline records). Using `DateTime` here would be the odd one out and lose the original offset. Changed the record field to `DateTimeOffset` and the adapter to `ca.GetDateTimeOffset()`; spec § 4 updated to match. The spec text was the inconsistency, not the code intent.
- **Revisit when:** N/A.

### [Decision] PR1 temp stubs land directly in `GitHubReviewService.Submit.cs`; two test fakes get matching stubs

- **Source:** PR1 execution (2026-05-12)
- **Affects:** Plan Task 11 Step 7 (which puts `NotImplementedException` stubs in `GitHubReviewService.cs` and migrates them to `GitHubReviewService.Submit.cs` per task) and the Phase-2 "Files touched" list (which omits `PRism.Web/TestHooks/FakeReviewSubmitter.cs` and `tests/PRism.Web.Tests/TestHelpers/PrDetailFakeReviewService.cs`).
- **Decision:** `GitHubReviewService.Submit.cs` is created in Task 11 with the seven `NotImplementedException("PR1 Task NN")` stubs; Tasks 12–17 replace each with the real implementation. Same end state as the plan's "stub in `.cs`, migrate to `.Submit.cs`" dance, with one fewer file churn. Separately, the plan's Phase-2 file list missed two test fakes that implement `IReviewSubmitter` from PR0a: `FakeReviewSubmitter` (Web, registered in dev/test mode) and `PrDetailFakeReviewService` (Web.Tests). Both got the seven methods as `NotImplementedException` stubs in Task 11 so the build stays green — nothing exercises the submit path yet (the submit endpoint arrives in PR3; a working in-memory pending review arrives with PR4/PR7's tests, plan Task 61).
- **Revisit when:** PR7 (plan Task 61) fleshes out the Web `FakeReviewSubmitter` for the DoD E2E suite.

### [Decision] PR1 skips Task 19 (ADR-S5-2 partial-class split of `GitHubReviewService.cs`)

- **Source:** PR1 execution (2026-05-12)
- **Affects:** Plan Task 19 (conditional: "run only if `GitHubReviewService.cs` has grown unwieldy after Tasks 12–18 landed").
- **Decision:** PR1 added **zero** lines to `GitHubReviewService.cs` — all of the new GraphQL code lives in the new partial `GitHubReviewService.Submit.cs`. The original file's size (~1100 lines) is unchanged from before S5, so the split would be a refactor unrelated to "implement the submit methods" and is out of PR1's scope. Deferred per ADR-S5-2's own "optional / do it when it feels too large" framing.
- **Revisit when:** A later slice adds another batch of methods to `GitHubReviewService.cs` proper, or a maintainer raises the file-size concern with concrete navigation pain.

### [Defer] Review-thread pagination in `FindOwnPendingReviewAsync`

- **Source:** PR1 execution (2026-05-12), surfaced by the `claude[bot]` PR #45 review
- **Severity:** P3 (PoC-acceptable cap; fails loud rather than silently wrong)
- **Date:** 2026-05-12
- **Reason:** `FindOwnPendingReviewAsync` fetches `reviewThreads(first: 100)` (and `comments(first: 100)` per thread) on a single page. A PR with more than 100 review threads would truncate — and connection truncation is not a GraphQL `errors`-array event, so `PostSubmitGraphQLAsync`'s strict error check can't catch it. Rather than return a partial snapshot the submit pipeline would act on (risking duplicate-thread creation or dropped drafts on Resume), the method now reads `reviewThreads.pageInfo.hasNextPage` and throws `GitHubGraphQLException` when it's `true` — fail-loud, consistent with the rest of the submit pipeline. Cursor pagination (mirroring the deferred timeline pagination in `GetPrDetailAsync`) is the proper fix; 100 threads is plenty for the PoC dogfood scenario, and the loud failure makes the cap visible if a real PR ever hits it. (The analogous `comments(first: 100)` per-thread cap is left without a guard — a single thread with >100 comments is far less plausible than a PR with >100 threads, and a truncated reply chain degrades gracefully rather than risking duplicates.)
- **Revisit when:** Dogfooding hits a PR with >100 review threads, OR a general GraphQL-connection-pagination utility lands in `PRism.GitHub` (it would naturally cover this and the timeline cap together).
- **Where the gap lives in code:** `PRism.GitHub/GitHubReviewService.Submit.cs` — `FindOwnPendingReviewAsync`'s `reviewThreads(first: 100)` query + the `hasNextPage` guard.

### [Decision] PR3 endpoints follow the doc-review revisions + the PR2-shipped SubmitPipeline API, not the stale Phase-3/Phase-4 task-body sketches

- **Source:** PR3 execution (2026-05-12)
- **Affects:** Plan Tasks 34 (bus events in `PRism.Web/Events` implementing a `IReviewBusEvent` marker; `SseEventProjection` instance with a framed-string `Project`), 36 (`SubmitAsync(... progress, PersistAsync, ct)` + endpoint resolving `IActivePrCache` only), 37 (`PipelineMarker.StripIfPresent` only; no `OriginalLineContent` enrichment in the code block), 38, 41 (`{ patch: "draftVerdict", draftVerdict: null }` discriminator wire-shape).
- **Decision:** The plan's "Doc-review revisions (2026-05-12)" block (R1, R4–R11) and the PR2-shipped `SubmitPipeline` public API are authoritative where they conflict with a task body — followed both. Concretely: (a) `SubmitPipeline.SubmitAsync` has no `persistAsync` param (R1); the endpoint resolves `IAppStateStore` from DI, the session is already persisted under `reference.ToString()` (the endpoint loads it from there), and the endpoint maps the `SubmitOutcome` to bus events. (b) The endpoint constructs `new SubmitPipeline(submitter, stateStore, onDuplicateMarker: …, getCurrentHeadShaAsync: …)` where `getCurrentHeadShaAsync` re-runs `IPrReader.PollActivePrAsync` (R11) — so the endpoint takes `IPrReader` as a handler parameter (the Task 36 sketch took `IActivePrCache` only). (c) `IReviewEventBus` is generic (`Publish<TEvent>(TEvent) where TEvent : IReviewEvent`); the bus events live in `PRism.Core/Events/SubmitBusEvents.cs` implementing `IReviewEvent` (R5), not `PRism.Web/Events/`. (d) `SseEventProjection` keeps its existing `internal static class` + `public static (string EventName, object Payload) Project(IReviewEvent) => evt switch {...}` tuple shape (R6) — five `case` arms added returning camelCase, counts-only wire records; `SseChannel` gains five `Subscribe<…>` calls + per-PR fanout. (e) Resume enriches `OriginalLineContent` from `IPrReader.GetFileContentAsync` at `OriginalCommitOid` (R7) and strips ALL marker prefixes via the new `PipelineMarker.StripAllMarkerPrefixes` (R8). (f) Task 41's `{ patch: ... }` discriminator was a sketch error — the actual `PUT /draft` wire-shape is flat (one named property = one operation), and spec § 10's own sketch says "iterate body's enumerable properties"; followed the spec.
- **Revisit when:** N/A — a follow-up pass folding the revisions into the task bodies would close the gap; until then this entry + the plan's revisions block are the source of truth.

### [Decision] submit-* bus events are named `Submit*BusEvent` (a localized exception to the no-suffix `PRism.Core/Events` convention)

- **Source:** PR3 execution (2026-05-12)
- **Affects:** The existing `PRism.Core/Events` records (`StateChanged`, `DraftSaved`, `DraftDiscarded`, `DraftSubmitted`, `InboxUpdated`, `ActivePrUpdated`) carry no `*Event`/`*BusEvent` suffix.
- **Decision:** The five new records — `SubmitProgressBusEvent`, `SubmitForeignPendingReviewBusEvent`, `SubmitStaleCommitOidBusEvent`, `SubmitOrphanCleanupFailedBusEvent`, `SubmitDuplicateMarkerDetectedBusEvent` — keep the `*BusEvent` suffix the plan / spec / tests use, because the obvious no-suffix name `SubmitProgress` collides conceptually with `SubmitProgressEvent` (the pipeline's `IProgress<>` payload in `PRism.Core.Submit.Pipeline`, a different namespace) and the `*BusEvent` suffix makes the wire-bound-vs-internal distinction explicit at every reference. A small consistency cost paid deliberately.
- **Revisit when:** N/A — intended end state.

### [Decision] The submit endpoint publishes `DraftSubmitted` on Success but `SseChannel` does not subscribe to it

- **Source:** PR3 execution (2026-05-12); spec § 17 #25 / § 5.2 step 5 (endpoint publishes `DraftSubmitted` + `StateChanged` after the success-clear).
- **Affects:** `SseEventProjection`'s comment that said "when S5 wires the submit path, add the `DraftSubmitted -> (...)` arm here in lockstep with the SseChannel subscription".
- **Decision:** The `/submit` endpoint publishes `DraftSubmitted` (forward-compat marker, per the spec) AND `StateChanged` on Success. `SseChannel` subscribes to `StateChanged` (already wired) but NOT to `DraftSubmitted`, and there is no `SseEventProjection` arm for it — the frontend learns a review was submitted from the `state-changed` event that fires alongside (and re-fetches the cleared session), so a dedicated `draft-submitted` SSE event would be unconsumed. This keeps the existing "no producer, no subscriber" stance precise (now there's a producer, still no subscriber, which is fine — the `ArgumentOutOfRangeException` default arm only fires if something subscribes without adding the arm). Updated the `SseEventProjection` comment to reflect this.
- **Revisit when:** A future change actually subscribes `SseChannel` to `DraftSubmitted` (then the projection arm must land in the same change).

### [Decision] `PUT /draft` JsonElement op-resolution: a lone "real" op wins; a spurious present-null on the other scalar kind is ignored

- **Source:** PR3 execution (2026-05-12)
- **Affects:** Spec § 10's `ReviewSessionPatchParser.Parse` sketch ("each present property is one operation; … exactly one operation per request"); plan Task 41.
- **Decision:** A naive "every present property is an operation" rule would break every existing `PrDraftEndpointTests` case — they `PutAsJsonAsync(url, ReviewSessionPatch_record)`, which serializes all 12 record fields including the 11 nulls (`{"draftVerdict":null, "newDraftComment":{...}, "draftSummaryMarkdown":null, …}`), so a `draftVerdict:null` would always count as a (clear) op alongside the real one → "more than one field set" → 400. Rule actually used: classify each known property as a **real op** (an object kind with an object value, a bool kind with `true`, or a scalar kind `draftVerdict`/`draftSummaryMarkdown` with a non-null value) or a **clear op** (a scalar kind with explicit `null`). If exactly one real op is present it wins and any clear-op on the other scalar kind is ignored (the spurious-nulls case the typed-record serialization emits); otherwise a lone clear op wins; otherwise 400. This is a strict superset of the historic `EnumerateSetFields` behavior plus the new "`{"draftVerdict":null}` alone clears the verdict". `{"draftVerdict":null,"draftSummaryMarkdown":null}` (two clear candidates) → 400, exactly as the historic all-null patch did. All 20 existing `PrDraftEndpointTests` pass unchanged.
- **Revisit when:** N/A — intended end state. (When PR4's frontend gains a "clear verdict" patch kind it will send `{"draftVerdict":null}` alone, which this rule handles.)

### [Decision] Submit-family endpoints use a `{ code, message }` error shape; `SubmitLockRegistry`/`Handle` are `internal`; the body-cap predicate gets explicit full-suffix `EndsWith`es

- **Source:** PR3 execution (2026-05-12)
- **Affects:** Several plan code-block details.
- **Decision:** (a) `SubmitErrorDto(string Code, string Message)` — the submit surface standardises on `{ code, message }` (matching spec § 7's error-discriminator contracts and the marker-prefix-collision `{ code }` shape), distinct from the legacy `{ error: "…" }` shape `PrDraftEndpoints` / `PrReloadEndpoints` use. (b) `SubmitLockRegistry` + `SubmitLockHandle` are `internal sealed` (not `public` as the plan's code block had them) — `PRism.Web`'s analyzer config flags public types (CA1515); `PRism.Web.Tests` reaches them via `InternalsVisibleTo`. (c) The `Program.cs` body-cap `UseWhen` predicate was extended with explicit full-path `EndsWith` checks for each of the four new POST routes — a bare `EndsWith("/submit")` does not match `/submit/foreign-pending-review/resume`, so the resume/discard suffixes are spelled out in full. (d) The CA1031 broad-catch in the fire-and-forget pipeline dispatch and the courtesy-delete failure path, plus a `CA2000` suppression on the lock handle whose ownership transfers into the `Task.Run` lambda, and `LoggerMessage.Define` delegates (CA1848) — standard repo-analyzer accommodations.
- **Revisit when:** N/A.

### [Decision] PR3's `SubmitEndpointsTestContext` test harness; the shared E2E `FakeReviewSubmitter` stays `NotImplementedException`

- **Source:** PR3 execution (2026-05-12)
- **Affects:** Plan Tasks 36–39's test code, which referenced `_factory.SeedSessionAsync` / `SeedPendingReview` / `InjectSlowSubmitter` / `InjectDeletePendingReviewFailure` / `LoadStateAsync` / `PublishedBusEvents` — none of which existed.
- **Decision:** Built `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointsTestContext.cs` (a per-test harness wrapping a `PRismWebApplicationFactory`-derived server via `WithWebHostBuilder`) plus the doubles it injects: `TestReviewSubmitter` (controllable `OwnPendingReview` / `BeginDelay` / `DeletePendingReviewException`; a minimal in-memory pending review so the pipeline's Step-3 snapshot re-fetch isn't null), `TestPrReader` (configurable `HeadSha` for `PollActivePrAsync` + `FileContents` map for `GetFileContentAsync`), `FakeReviewEventBus` (records published `IReviewEvent`s), `AllSubscribedActivePrCache` (`IsSubscribed → true`, configurable `GetCurrent`), and a `TestPoll.UntilAsync` helper for the fire-and-forget pipeline. The shared E2E `FakeReviewSubmitter` (`PRism.Web/TestHooks/`, registered under `PRISM_E2E_FAKE_REVIEW=1`) is left as `NotImplementedException` stubs — PR7 (plan Task 61) fleshes it out for the DoD E2E suite, per the PR1 deferral above.
- **Revisit when:** PR7 builds the working in-memory pending review backing the E2E fake.

### [Known issue] Pre-existing Playwright e2e failures on `main` — verified on base commit `d6d15c2`

- **Source:** PR3 execution (2026-05-12) — `npx playwright test` on this branch surfaced 8 unexpected failures (`cold-start.spec.ts` ×3, `inbox.spec.ts` ×4, `s4-drafts-survive-restart.spec.ts` ×1) plus the known `test.fixme` skips.
- **Severity:** P2 (e2e suite instability; the demo-critical paths are covered by the .NET endpoint tests + frontend vitest).
- **Date:** 2026-05-12
- **Reason:** Re-ran `cold-start.spec.ts` + `inbox.spec.ts` against the PR3 base commit (`d6d15c2`, before any S5-PR3 change) in a throwaway worktree — the **same** failures reproduce (`expect(getByRole('button', { name: /continue/i })).toBeDisabled()` at `/setup` → "element(s) not found"; analogous timeouts in `inbox`). So the failures are not a PR3 regression. PR3 itself is green on `dotnet test PRism.sln` (714 passed / 1 skip) and `frontend`'s `npm run lint` + `npm run build` + `vitest` (514 passed). This is the same e2e-suite instability the spec § 16 PR0b row / spec § 2.3 / the brainstorm-time PR0b deferral already owns ("Playwright multi-spec state-leak root-cause + fix"); PR0b is off the demo critical path.
- **Revisit when:** PR0b root-causes and fixes the e2e state-leak / setup-screen flakiness. Until then, PR3 (and any subsequent backend PR) verifies via the .NET + vitest suites and notes the pre-existing e2e state.

### [Decision] `SubmitButton` takes a `headShaDrift: boolean` prop, not the plan's `headSha` / `lastViewedHeadSha`

- **Source:** PR4 execution (2026-05-12)
- **Affects:** Plan Task 46's `SubmitButton.tsx` props sketch (`headSha: string; lastViewedHeadSha: string`) and the matching test.
- **Decision:** The component never needs the SHAs themselves — rule (f) is "the most-recent active-PR poll observed drift" (spec § 9). `PrHeader` already has `useActivePrUpdates(...).headShaChanged`; passing the boolean keeps the SHA comparison in one place and the button dumb. `PrDetailPage` → `PrHeader headShaDrift={updates.headShaChanged}` → `SubmitButton headShaDrift={...}`. The dialog never receives it (drift disables the header button, so the dialog can't open under drift) — `submitDisabledReason` is called with `false` inside the dialog.
- **Revisit when:** N/A — intended end state.

### [Decision] `useSubmit.state` `success.pullRequestReviewId` is left empty; the success "View on GitHub" link targets the PR page

- **Source:** PR4 execution (2026-05-12)
- **Affects:** Spec § 8.4's `SubmitState` union (`{ kind: 'success', pullRequestReviewId: string }`); plan Task 45 / Task 49's "View on GitHub →" link.
- **Decision:** None of the five `submit-*` SSE payloads carry the new review id — that's the deliberate threat-model defense (spec § 7.4 / § 17 #2 / #26: "counts + step names only, no per-draft IDs, no review id"). The `submitReview` POST returns `{ outcome: "started" }`, not the id either. So the frontend has no review id to put in the `success` state. `useSubmit` transitions to `success` on `submit-progress { step: 'Finalize', status: 'Succeeded' }` with `pullRequestReviewId: ''`, and `SubmitDialog`'s success footer links to `https://github.com/{owner}/{repo}/pull/{number}` (the PR conversation page, where the just-submitted review is the latest entry). The `pullRequestReviewId` field stays on the union for shape-compat with the spec; populating it would need either a non-defense-compliant SSE field or a follow-up read of the review list — out of PoC scope.
- **Revisit when:** A future iteration adds a deep-link to the specific submitted review (would need a post-submit `viewer.pullRequestReview` fetch, or a one-off "review submitted, id=X" event scoped to the initiating tab).

### [Decision] AI gating for the header surfaces happens in `PrHeader` (the parent), not self-gated inside each slot

- **Source:** PR4 execution (2026-05-12)
- **Affects:** The S4-deferrals note "[Decision] PR4 AI placeholder slots self-gate via useCapabilities() + usePreferences()"; spec § 14.1 / § 14.2.
- **Decision:** `PrHeader` calls `useCapabilities()` + `usePreferences()`, derives `aiPreview` and `validatorResults = (aiPreview && capabilities?.preSubmitValidators) ? CANNED : []`, and passes `aiPreview` to `<AskAiButton>` and `validatorResults` to `<SubmitDialog>` → `<PreSubmitValidatorCard results={...}>`. The leaf components are pure "data-or-nothing" renderers (`AskAiButton` → null when `!aiPreview`; `PreSubmitValidatorCard` → null when `results.length === 0`) — exactly the established `OverviewTab` → `AiSummaryCard summary={...}` / `PrDescription aiPreview={...}` pattern. "Self-gating inside the slot" and "gating in the parent that owns the hooks" are the same gate (`capabilities?.<flag> && preferences?.aiPreview`); placing it in the parent matches the codebase and keeps the slot components trivially unit-testable (no hook mocks). `PrHeader.test.tsx` mocks the two hooks; `PrDetailPage.test.tsx` already tolerates their fetches.
- **Revisit when:** N/A — intended end state.

### [Decision] During the pipeline run the dialog body stays rendered (verdict / summary / counts disabled), not collapsed to header + checklist

- **Source:** PR4 execution (2026-05-12)
- **Affects:** Spec § 8.3 #2 ("the dialog body collapses to: 1. Header 2. Checklist") read against the later "verdict picker frozen … `aria-disabled="true"` and visually desaturated" line in the same section.
- **Decision:** `SubmitDialog` keeps the verdict picker, validator card, summary textarea, and counts block mounted during `in-flight` (all `disabled`), and renders the `SubmitProgressIndicator` in the progress section. The spec's "collapses to header + checklist" and its "verdict picker frozen but visible" lines can't both be literally true; the latter is the more specific instruction (it names the exact ARIA state of a still-rendered control), so the dialog keeps the body. The progress indicator (Phase A neutral row → Phase B checklist, merged per R2) is the focal element during the run; the desaturated picker/summary above it carry the "frozen, will resume" affordance the spec asks for.
- **Revisit when:** A reviewer or dogfooding prefers the literal collapse — then drop the body sections to `display:none` (or unmount them) while `in-flight` and re-add on `failed` / `success`.

### [Resolved] The `foreign-pending-review-prompt` and `stale-commit-oid` dialog states get placeholder UI in PR4; the full ForeignPendingReviewModal + StaleCommitOidBanner land in PR5

- **Source:** PR4 execution (2026-05-12) — already foreshadowed by the handoff ("PR4 wires useSubmit's handling of the submit-stale-commit-oid event + the retry() method, the full banner component is PR5") and spec § 16 PR5 row.
- **Affects:** Spec § 11 (foreign-pending-review modal) / § 12 (stale-`commitOID` retry UX) — PR5 scope.
- **Decision:** PR4 landed the state-machine plumbing (`useSubmit` transitions on `submit-foreign-pending-review` and `submit-stale-commit-oid`, plus `retry()` / `resumeForeignPendingReview()` / `discardForeignPendingReview()` API helpers) and a minimal in-dialog surface for each: a `banner-warning` strip + a "Cancel — nothing was submitted" button (and, for `stale-commit-oid`, a "Recreate and resubmit" primary calling `retry()`). The Snapshot-A/B count-staleness note, the IsResolved pre-flight banner, the Resume/Discard buttons + confirmation sub-modal, the not-yet-Reloaded disabled-with-tooltip variant, and the full `§ 12` banner copy are PR5 (plan Tasks 53–60).
- **Resolved:** PR5 (2026-05-13). `SubmitDialog` now early-returns `<ForeignPendingReviewModal>` for `kind === 'foreign-pending-review-prompt'` and a `<Modal>` wrapping `<StaleCommitOidBanner>` for `kind === 'stale-commit-oid'` (body collapsed to the banner; the banner owns Cancel + "Recreate and resubmit"). `useSubmit` gained `lastResume`/`clearLastResume`; `PrHeader` renders `<ImportedDraftsBanner>` from it. See the PR5 implementation-time entries below for the residual narrowings (`notReloadedYet` proxy, `currentHeadSha` lag, per-draft IsResolved row badge deferred).

### [Defer] The Submit dialog's "View on GitHub" link hardcodes `https://github.com` — no GHES host plumbed through

- **Source:** PR4 `@claude review` Action pass on PR #48 (2026-05-12) — issue #3 ("low-priority for the PoC cohort, but worth recording").
- **Affects:** `frontend/src/components/PrDetail/SubmitDialog/SubmitDialog.tsx` — the success-state `prUrl = \`https://github.com/${owner}/${repo}/pull/${number}\``.
- **Decision:** The PoC supports a configurable `github.host` (and `AuthState.host` is exposed via `useAuth`), but no existing frontend surface threads it through to "view on github.com" links — the inbox/PR-detail paths use relative API routes. Wiring `host` PrDetailPage → PrHeader → SubmitDialog (or having SubmitDialog call `useAuth()`) for the success link is a small, isolated change; deferred because (a) GHES is a v2/stretch concern for the N=3 cohort, (b) the same hardcoding exists wherever else the app links out to github.com (so fixing it here alone would be inconsistent), and (c) the success state's primary affordance is the Close button — the link is secondary. A follow-up that adds GHES-aware external links should sweep all of them at once.
- **Revisit when:** A GHES user is in scope, OR a follow-up does an app-wide "external github.com link" host-awareness pass.

### [Skip] `// eslint-disable-next-line react-hooks/exhaustive-deps` on PrHeader's success-refetch effect

- **Source:** PR4 `@claude review` Action pass on PR #48 (2026-05-12) — issue #2 (suggested adding the suppression comment to the `useEffect(() => { if (success) onSessionRefetch?.() }, [submit.state.kind])`).
- **Affects:** `frontend/src/components/PrDetail/PrHeader.tsx` — the effect intentionally omits `onSessionRefetch` from its deps (it's re-created each render by `PrDetailPage`; including it would re-run the effect — and the refetch — every render while in `success`).
- **Decision:** Not adding the directive. This project's `eslint.config.js` (flat config) registers only `@eslint/js` recommended + `@typescript-eslint` recommended — there is **no `eslint-plugin-react-hooks`**, so a `// eslint-disable-next-line react-hooks/exhaustive-deps` comment references an unknown rule and eslint *errors* on it ("Definition for rule 'react-hooks/exhaustive-deps' was not found" — hit and removed earlier in `SubmitDialog`). The plain explanatory comment above the deps array conveys the intent; if `eslint-plugin-react-hooks` is ever added project-wide, that change can add the directives everywhere they're needed in one pass.
- **Revisit when:** `eslint-plugin-react-hooks` is added to `frontend/eslint.config.js`.

### [Decision] `useToast` is non-throwing — a no-op default context replaces the "must be used within ToastProvider" guard

- **Source:** PR5 execution (2026-05-13)
- **Affects:** `frontend/src/components/Toast/useToast.ts` — previously `createContext<ToastApi | null>(null)` with `useToast()` throwing `"useToast must be used within ToastProvider"`.
- **Decision:** PR5 wires `useToast()` into `PrHeader` (TOCTOU-409 toast + `useSubmitToasts`). `PrHeader` / `PrDetailPage` are rendered bare in their unit tests (no `ToastProvider`), so the throw would have broken ~25 existing tests. Rather than wrapping every affected `render()` call, the context now defaults to a frozen no-op `{ toasts: [], show: () => {}, dismiss: () => {} }` — mirroring `useEventSource()` returning `null` outside its provider and being handled gracefully. The real `ToastProvider` is still mounted in `App.tsx`, so production behavior is unchanged; a component accidentally rendered outside the provider degrades to silent no-op toasts rather than crashing. Trade-off accepted: the "you forgot the provider" guard is gone, but for a PoC the testability + consistency win.
- **Revisit when:** A future refactor wants the guard back — re-add it behind a `__DEV__` check, or wrap the affected test renders in a `renderWithProviders` helper.

### [Decision] The stale-`commitOID` banner's not-yet-Reloaded variant is gated on `headShaDrift`, not a server-supplied flag

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Spec § 12 "not-yet-Reloaded variant" (the second banner sentence + the disabled "Recreate and resubmit"); `StaleCommitOidBanner` `notReloadedYet` prop; `SubmitDialog` / `PrHeader` / `PrDetailPage` wiring.
- **Decision:** Spec § 12 says the variant fires "if the pipeline detected stale-`commitOID` server-side without an intervening Reload". The `submit-stale-commit-oid` SSE payload (`{ prRef, orphanCommitOid }`) carries no "wasReloaded" flag, so the frontend can't read that state directly. PR5 proxies it with `headShaDrift` (= `useActivePrUpdates(...).headShaChanged`, cleared by the Reload button): if the "PR updated — Reload" banner is still up, the user hasn't Reloaded → `notReloadedYet = true`. This under-reports in the corner where the poller hasn't yet observed a push that the pipeline's server-side check caught — but the pipeline's pre-Finalize head_sha re-poll (R11) is the downstream net (a recreate-then-push aborts back to the Reload banner). The component takes `notReloadedYet` as a plain prop, so the proxy can be swapped for a real signal later without touching `StaleCommitOidBanner`.
- **Revisit when:** `submit-stale-commit-oid` (or a follow-up event) gains a `wasReloadedSincePendingReview` flag, or the frontend tracks Reload clicks against `pendingReviewCommitOid`.

### [Decision] The stale-`commitOID` banner shows `data.pr.headSha`, which may briefly lag the real new head

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Spec § 12 banner copy ("Recreating the review against the new head sha {currentHeadSha[0..7]}"); `SubmitDialog.currentHeadSha`, threaded from `PrDetailPage` → `PrHeader` → `SubmitDialog` as `data?.pr.headSha`.
- **Decision:** `currentHeadSha` is the PR's last GET-fetched head sha (`usePrDetail`'s `data.pr.headSha`). After a server-side stale-`commitOID` detection with no intervening Reload, that's still the *old* head, so the displayed sha is stale-ish until the user clicks Reload (which refetches the PR detail). For a PoC banner this is acceptable — the message is informational and self-corrects on Reload; the banner renders gracefully when `currentHeadSha` is empty (drops the "against the new head sha …" clause).
- **Revisit when:** The banner needs to be exactly right pre-Reload — thread `useActivePrUpdates(...).newHeadSha` (the `pr-updated` SSE payload's `newHeadSha`) down alongside `headShaDrift`.

### [Defer] No per-draft "Resolved on github.com" badge on imported draft rows — `ImportedDraftsBanner` carries the aggregate warning only

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Spec § 11.1 "each imported draft carrying `isResolved=true` gets a 'Resolved on github.com' badge" — only the aggregate "N imported thread(s) were resolved …" pre-flight banner shipped (`ImportedDraftsBanner`).
- **Decision:** The resume 200 response's `ImportedThread.isResolved` is consumed by `useSubmit` to compute `lastResume.hasResolvedImports` (drives the banner), but the *persisted* `DraftComment` entries that the resume imports into the session don't carry an `isResolved` field — PR3's resume-import logic didn't add one, and adding it touches the backend `DraftComment` record + the resume endpoint's import path + the `ReviewSessionDto` wire shape, which is out of PR5's frontend scope. So a reviewer adjudicating the imported drafts in the Drafts tab sees the banner but not a per-row badge. The banner covers the spec's intent (warn before re-publishing resolved threads); the per-row badge is a polish item.
- **Revisit when:** A backend follow-up persists `isResolved` on imported `DraftComment`s — then the Drafts-tab draft-row component renders the badge keyed off it.

### [Decision] `ImportedDraftsBanner` renders in `PrHeader` below the tab strip, not inside the Drafts-tab panel

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Plan Task 54 (places the component at `ForeignPendingReviewModal/ImportedDraftsBanner.tsx` but doesn't specify a mount point; the spec says "above the imported drafts"); `useSubmit` API (`lastResume` / `clearLastResume` added); `PrHeader` render tree.
- **Decision:** `useSubmit` is instantiated inside `PrHeader`, and the Drafts tab is rendered via `<Outlet>` in `PrDetailPage` (a sibling of `PrHeader`, not a child) — so `PrHeader` can't pass the resume snapshot down into the Drafts tab without hoisting `useSubmit` or adding a context. Instead, `useSubmit` gained `lastResume: ResumeSummary | null` (set in `resumeForeignPendingReview` from the resume 200 + the SSE Snapshot-A counts) + `clearLastResume()`, and `PrHeader` renders `<ImportedDraftsBanner>` from it directly below `<PrSubTabStrip>` — visible regardless of which tab is active. Cleared on the next successful submit. When counts matched and nothing was resolved, the banner renders `null`, so the common case is invisible.
- **Revisit when:** `useSubmit` is hoisted to `PrDetailPage` — then the banner could move into the Drafts-tab panel proper.

### [Decision] PR5 ships no backend code — Task 59 (pre-Finalize `head_sha` re-poll) was already implemented in PR2/PR3

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Plan Task 59 ("Modify `PRism.Core/Submit/Pipeline/SubmitPipeline.cs` — add the re-poll between Step 4 and Step 5"; "Create `PreFinalizeHeadShaRepollTests.cs`").
- **Decision:** `SubmitPipeline.SubmitAsync` already does the pre-Finalize re-poll (`if (_getCurrentHeadShaAsync is not null) { var fresh = …; if (fresh != currentHeadSha) return Failed(Finalize, "head_sha drifted before Finalize; Reload and re-submit") }`), the endpoint already wires `getCurrentHeadShaAsync` to `IPrReader.PollActivePrAsync` (R11), and `tests/PRism.Core.Tests/Submit/Pipeline/PreFinalizeHeadShaReprollTests.cs` already exists and passes — all landed with PR2's canonical `SubmitPipeline` + PR3's endpoint wiring. PR5 verified this and adds no `PRism.Core` / `PRism.Web` changes; it's entirely frontend.
- **Revisit when:** N/A.

### [Decision] `ForeignPendingReviewModal` swaps the parent `<Modal>` out while the destructive sub-modal is open, rather than nesting two `<Modal>`s

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Plan Task 53's component sketch (`<><Modal>…</Modal><DiscardConfirmationSubModal/></>` with the sub-modal also a `<Modal>`).
- **Decision:** The shared `<Modal>` registers its Esc + Tab-trap handlers at the `document` level; two live `<Modal>`s would both fire on every keydown and fight over focus. So the primary modal renders `<Modal open={!discardOpen} …>` — when "Discard…" opens the sub-modal, the primary steps aside and only `<DiscardConfirmationSubModal open …>` is live; cancelling the sub-modal flips `discardOpen` back and the primary re-mounts (re-focusing its Cancel). One backdrop, one focus trap, at all times. Behavior the user sees is identical to a stacked sub-modal for this flow.
- **Revisit when:** A future modal genuinely needs true stacking — then `<Modal>` should grow a z-index/stack-aware focus-trap mode.

### [Decision] `useMediaQuery` added as a small reusable hook (new file, not in the plan's "Files touched")

- **Source:** PR5 execution (2026-05-13)
- **Affects:** Plan Phase 6 "Files touched" list (lists `DiscardAllDraftsButton.tsx` but not a media-query hook; the plan's sketch used `useMediaQuery('(max-width: 599px)')` without saying where it comes from).
- **Decision:** The codebase had no `useMediaQuery` (only direct `matchMedia` calls in `HeaderControls.tsx`). The `<600px` label-shortening for `DiscardAllDraftsButton` (spec § 8.5) needs reactive `matchMedia` with proper `addEventListener('change')` cleanup + the legacy `addListener` fallback — worth a tested hook rather than inlining. Added `frontend/src/hooks/useMediaQuery.ts` (SSR-safe, returns `false` when `window`/`matchMedia` is unavailable).
- **Revisit when:** N/A — reusable utility.

### [Decision] `submit-duplicate-marker-detected.draftId` keeps its name even when it carries a reply-comment id

- **Source:** PR5 execution (2026-05-13) — flagged at handoff ("revisit the naming in PR5 when you wire the toast").
- **Affects:** `SubmitDuplicateMarkerDetectedEvent.draftId` (frontend `types.ts`), the backend `Submit*BusEvent` + `SseEventProjection` arm + `ExtractDraftId`, and `useSubmitToasts`' toast copy.
- **Decision:** When the duplicate marker is on a reply, the value in `draftId` is really a reply-comment id, so the name is slightly imprecise. PR5 keeps `draftId` — renaming touches the backend bus-event record, the SSE projection, and the wire type for a cosmetic gain, which is out of a frontend-only PR's scope. The `useSubmitToasts` copy says "Duplicate PRism marker detected for draft `{id}`" — generic enough that a reply-comment id reads fine. The duplicate-cleanup is best-effort server-side anyway; the toast is informational.
- **Revisit when:** A backend PR touches the `Submit*BusEvent` records — fold the rename in then.

---

## Implementation-time deferrals — S5 PR7 (DoD E2E test sweep, plan Phase 7 Tasks 61–70)

### [Decision] PR7 ships defensively (per-spec `/test/reset` + `--workers=1`) rather than landing PR0b first

- **Source:** PR7 execution (2026-05-13).
- **Affects:** Plan Phase 7 preamble ("the state-leak fix from PR0 ensures this PR can add 6+ new specs without re-introducing the leak"); the PR0b phase (1b) and its `[Defer] PR0a/PR0b split` entry above.
- **Decision:** The plan assumed PR0b lands first so PR7's new Playwright specs don't re-introduce the multi-spec state-leak. PR7 instead ships its 8 new specs defensively — each `test.beforeEach` calls `/test/reset` (which already existed; PR7 hardened it — see below) — and the suite is run with `--workers=1`. Reasons: (1) `/test/reset` was already the established per-spec isolation pattern (`frontend/e2e/helpers/s4-setup.ts`); (2) PR0b's plan premise (three `test.fixme`'d S4 PR7 specs) is partly stale and PR0b is an open-ended investigation (the plan itself has an "if multi-week, escalate" branch); (3) the `build-and-test` GitHub Action does not run Playwright, so CI stays green either way; (4) PR7's deliverable — 8 reliable new specs, in isolation and together — is achievable with airtight per-spec reset + `--workers=1` regardless of PR0b. The 8 pre-existing Playwright reds on `main` (`cold-start.spec.ts` ×3, `inbox.spec.ts` ×4, `s4-drafts-survive-restart.spec.ts` ×1 — the `[Known issue]` PR0b owns) persist; PR7 does not touch them. NB: those reds plus the `--workers=1` requirement now look like the same root family — the dev/test backend is one long-running process with global fake state (`FakeReviewSubmitter`'s mutation counters, `FakeReviewBackingStore`, the persisted `state.json`), so concurrent Playwright workers against it pollute each other; PR0b's eventual fix (a `workers: 1` config setting, or finer-grained per-spec isolation) would let the suite drop the manual `--workers=1`.
- **Revisit when:** PR0b.

### [Decision] The S5 e2e specs must run `--workers=1`

- **Source:** PR7 execution (2026-05-13).
- **Affects:** the project pre-push checklist's bare `npx playwright test` step (`.ai/docs/development-process.md`); the S5 spec suite.
- **Decision:** `npx playwright test` defaults to multiple workers and `playwright.config.ts` doesn't pin `workers`. With `fullyParallel: false` test *files* still distribute across workers, all hitting the one backend process — so a spec's `inspectPendingReview` `attachThreadCallCount` (a global counter on the `FakeReviewSubmitter` DI singleton) gets polluted by a concurrent spec's submit, and `/test/reset` in one worker's `beforeEach` can wipe another worker's in-flight state. Running `--workers=1` serializes everything → deterministic. PR7's specs were verified, and should be re-verified, with `npx playwright test e2e/s5-*.spec.ts --project=prod --workers=1` (`--project=prod` because the `dev` Vite-server project is broken in CI/local — pre-existing, PR0b-adjacent). The pre-push `npx playwright test` (no flags) still surfaces the pre-existing reds + the multi-worker flake; `--workers=1` is the clean-run invocation until PR0b changes the config.
- **Revisit when:** PR0b sets `workers: 1` (or equivalent isolation) in `playwright.config.ts`.

### [Decision] `/test/mark-pr-viewed` added; `/test/reset` hardened (PrDetailLoader cache + ActivePrCache poll snapshot)

- **Source:** PR7 execution (2026-05-13).
- **Affects:** `PRism.Web/TestHooks/TestEndpoints.cs`; plan Task 61's `/test/submit/*` sketch (which assumed a `/test/seed-session` helper that doesn't exist).
- **Decision:** The submit head-sha-drift gate (`PrSubmitEndpoints` rule (f)) refuses a submit when `session.LastViewedHeadSha` is empty, and the real frontend only ever sets it via the demo's "click Reload" step (`POST /reload`) — no frontend code calls `POST /mark-viewed`. So submit-pipeline E2E specs that don't exercise a reload set it via a new `POST /test/mark-pr-viewed` hook (stamps `LastViewedHeadSha` = the backing store's current head; creates the session if absent). Separately, `/test/reset` now also (a) `PrDetailLoader.InvalidateAll()` — otherwise a CLOSED/MERGED or advanced-head `PrDetailDto` cached by an earlier spec leaks into the next (the loader keys its cache on `prRef@headSha@generation`, and `store.Reset()` rolls the head back, so a later spec re-using a head sha hits the stale snapshot) — and (b) re-seeds `IActivePrCache` for the scenario PR to the just-reset head, so the submit gate sees the fresh head immediately rather than a stale advanced-head poll snapshot a prior spec left there until the ~1s `ActivePrPoller` cadence catches up. All test-only-endpoint changes; no production behaviour change.
- **Revisit when:** N/A — test infra. (A future `/test/seed-session` that materialises a full `ReviewSessionState` directly would subsume `/test/mark-pr-viewed` and let several PR7 specs skip the create-via-UI prelude.)

### [Decision] The retry-from-each-step E2E covers Begin / AttachThreads / Finalize, not AttachReplies

- **Source:** PR7 execution (2026-05-13).
- **Affects:** Plan Task 63 (whose sketch loops over all four mutation methods including `AttachReplyAsync`).
- **Decision:** `frontend/e2e/s5-submit-retry-from-each-step.spec.ts` injects a one-shot failure at `BeginPendingReviewAsync`, `AttachThreadAsync`, and `FinalizePendingReviewAsync` and asserts retry converges with no duplicate threads — but not `AttachReplyAsync`. A fresh draft *reply* has no reachable UI affordance in the E2E: the inline reply composer only renders on existing server review threads (`ExistingCommentWidget` over `GetPrDetailAsync.ReviewComments`), and `SubmitPipeline.StepAttachRepliesAsync` only attaches a reply whose parent thread is already on the viewer's pending review (one imported via Resume, or one a prior attempt created) — so reproducing "unstamped draft reply that gets attached on retry" purely through the UI would need both a seeded server thread and a Resume detour. The exhaustive 4-step matrix (incl. `AttachReplyAsync`) is the Core unit test `tests/PRism.Core.Tests/Submit/Pipeline/RetryFromEachStepTests.cs` (4 `InlineData` cases, asserts `AttachReplyCallCount == 1` on the reply case). DoD line "retry … without producing duplicate threads or replies" is thus covered: replies by the Core test, threads + the UI-surfaced failure/Retry/converge loop by the E2E.
- **Revisit when:** the foreign-pending-review Resume path grows a test fixture that imports a thread with an *unstamped* (un-replied) reply slot, or `GetPrDetailAsync` gains seedable `ReviewComments` — then the reply-attach retry case can be exercised end-to-end.

### [Observation] The marker-prefix-collision rejection lands the composer in `unsaved`, not `rejected`

- **Source:** PR7 execution (2026-05-13).
- **Affects:** Plan Task 69's sketch (which expected the rejected save to show a `rejected` composer badge).
- **Decision:** `PUT /api/pr/{ref}/draft` rejects a body containing the literal `<!-- prism:client-id:` substring (outside fenced code) with HTTP **400** (`{ code: "marker-prefix-collision" }`). `useComposerAutoSave.applyErrorBadge` only maps HTTP **422** (`invalid-body`) → the `rejected` badge; a 400 (`bad-request`) falls through to `unsaved` (keep-local-body, retry-on-next-edit). So `frontend/e2e/s5-marker-prefix-collision.spec.ts` asserts the composer settles `unsaved` and nothing was persisted server-side (a reload shows an empty Drafts tab) — the rejection is verified, the badge label is the cosmetic difference. The companion case (the same marker substring *inside* a ``` fence) still saves cleanly (`saved`, a draft appears). Whether the collision rejection should be a 422 so the composer shows `rejected` is a minor UX nit, out of PR7's test-only scope.
- **Revisit when:** a frontend/backend PR revisits the `PUT /draft` error contract (e.g. unifying it on `{code,message}` + status mapping).

### [Observation] The multi-tab submit-lock 409 surfaces no UI today; the E2E asserts the losing tab reverts to idle

- **Source:** PR7 execution (2026-05-13).
- **Affects:** `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts`; relates to the `[Defer] Discard-failure consolidated toast / inline-error system` entry above.
- **Decision:** When two tabs Confirm at once, the per-PR `SubmitLockRegistry` makes the loser's `POST /submit` return `409 submit-in-progress`. The frontend currently swallows it: `useSubmitToasts` only handles SSE events (not HTTP responses), and `useSubmit.fire()`'s catch resets the dialog to `idle` and re-throws into `submit.submit(verdict).catch(() => {})`. So the spec asserts the losing tab's dialog returns to idle (the "Confirm submit" button is visible again) and never reaches the success state — that's the observable behaviour today. A surfaced inline-error/toast for the 409 is the natural follow-up (same family as the deferred discard-failure toast system).
- **Revisit when:** the consolidated toast / inline-error system lands (see the discard-failure deferral above).

### [Decision] `/test/submit/*` endpoint names + superset vs the plan's Task 61 sketch

- **Source:** PR7 execution (2026-05-13).
- **Affects:** Plan Task 61's `MapTestSubmitEndpoints` sketch.
- **Decision:** Task 61's sketch named the seeding route `/test/submit/inject-foreign-pending-review`; PR7 ships it as `/test/submit/seed-pending-review` — the seeded review is "foreign" only relative to the session's `PendingReviewId` (which the pipeline compares against); the seed itself doesn't model viewer identity, so the generic name is more accurate. The shipped set is also a superset of the sketch: `inject-failure` (now with an `afterEffect` flag — the lost-response window), `set-begin-delay` (holds `BeginPendingReviewAsync` so the multi-tab lock test can race a 2nd tab, and so submit-progress events land after the `POST /submit` 200 — the dialog only acts on them once its POST returned), `set-find-own-null-from-call`, `seed-pending-review`, `GET /test/submit/inspect-pending-review` (returns the PR's pending review + global mutation counters), plus `/test/set-pr-state` and `/test/mark-pr-viewed` outside the `/submit/` namespace. `FakeReviewSubmitter` itself is a duplicated (not shared) mirror of the Core-Tests `InMemoryReviewSubmitter` per the plan's Task 61 step 1.
- **Revisit when:** N/A.

### [Decision] `FakeReviewSubmitter.FindOwnPendingReviewAsync` honours `afterEffect=true` injected failures too

- **Source:** PR7 execution (2026-05-13), Copilot review on PR #50.
- **Affects:** `PRism.Web/TestHooks/FakeReviewSubmitter.cs`.
- **Decision:** Initial PR7 version of `FindOwnPendingReviewAsync` only consumed an injected failure when `afterEffect=false` — an `afterEffect=true` injection for `FindOwnPendingReviewAsync` would have stayed armed forever, silently. Fixed: the method now builds its return value first, then calls a second `TryTakeFailure(..., afterEffectWanted: true, ...)` before returning — symmetric with the mutation methods (`BeginPendingReviewAsync` / `AttachThreadAsync` / `AttachReplyAsync` / `FinalizePendingReviewAsync` / `DeletePendingReviewAsync` / `DeletePendingReviewThreadAsync`). Semantically valid even though `FindOwn` is a read: it models the lost-response window for the list query (server computed the snapshot, client never got the response). No current spec uses this knob — it's preserved for symmetry / future use.
- **Revisit when:** N/A — test infra.

### [Resolved] PR1 "test-fake stubs" / PR3 "the shared E2E FakeReviewSubmitter stays NotImplementedException"

- **Source:** PR7 execution (2026-05-13) resolves the PR1 ("test-fake stubs") and PR3 ("[Decision] PR3's `SubmitEndpointsTestContext` test harness; the shared E2E `FakeReviewSubmitter` stays `NotImplementedException`") entries above.
- **Decision:** `PRism.Web/TestHooks/FakeReviewSubmitter.cs` is now a working in-memory `IReviewSubmitter` (per-PR pending review, `PRR_`/`PRRT_`/`PRRC_` ids, one-shot per-method failure injection with before/after-effect, a Begin delay, a FindOwn-null-from-call-N knob, pending-review seeding, an `Inspect()` snapshot) — fleshed out in PR7 Task 61 as the plan's PR1 deferral anticipated. The Core-Tests `InMemoryReviewSubmitter` stays separate (duplicated shape, no shared code).
- **Revisit when:** N/A.
