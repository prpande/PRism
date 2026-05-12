---
source-doc: docs/specs/2026-05-11-s5-submit-pipeline-design.md
created: 2026-05-11
last-updated: 2026-05-12
status: open
revisions:
  - 2026-05-11: brainstorm + ce-doc-review pass — recorded brainstorm-time deferrals (12 items in spec § 1.2), doc-review-time deferrals routed to ce-plan, doc-review FYI observations, and forward-looking residual risks for the implementer
  - 2026-05-12: PR #43 review pass — marked Risk R1 (MigrateV3ToV4 signature mismatch) Resolved after spec § 6 was corrected to the JsonObject step shape
  - 2026-05-12: PR0a execution — added the "Implementation-time deferrals" section (IDraftReconciliator dead-code not deleted; IReviewSubmitter CA1040 suppression; GitHub-test concrete return type; PRismWebApplicationFactory override re-typed)
  - 2026-05-12: PR1 execution — R16 applied to spec § 4 (interface now 7 methods, adds DeletePendingReviewThreadAsync); added PR1 implementation-time decisions (GraphQL transport reuse; FindOwn single-query shape; DeletePendingReviewThreadAsync via comment-deletes since GitHub has no thread-delete mutation; CreatedAt → DateTimeOffset; test-fake stubs; Task 19 partial-split skipped). GraphQL input/field shapes confirmed via introspection — recorded in docs/spec/00-verification-notes.md.
  - 2026-05-12: PR2 execution — added PR2 implementation-time decisions (DraftComment.ThreadId trailing `= null` default; PipelineMarker line-state fence detection per R10, ≤3-space cap; PendingReviewThreadSnapshot.CreatedAt added for the multi-marker earliest-adopt; PR-root drafts fail loud in StepAttachThreads; body-cap left to the composer; CA1034/CA1064/CA1032 suppressions on the new union/exception types; no logging in SubmitPipeline so R9's scrub-audit is a no-op for PR2) and PR2 preflight-review fixes (FindOwnPendingReviewAsync widened to include threads we only replied to; Step 3/4 null-snapshot → retryable failure; all overlay UpdateAsync calls wrapped → SubmitFailedException, success-clear swallows; residuals: IsParentThreadGone is fake-only, lost-Begin → foreign-prompt, reply multi-match orders by id)
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
