---
source-doc: docs/specs/2026-05-09-s4-drafts-and-composer-design.md
created: 2026-05-10
last-updated: 2026-05-10
status: open
revisions:
  - 2026-05-10: initial cut — captures Defer/Skip items from spec ce-doc-review (7-persona pass, 2026-05-09), spec PR-review pass (Copilot inline + claude-bot, 2026-05-09), plan ce-doc-review (6-persona pass, 2026-05-10), and plan PR-review pass (Copilot inline + claude-bot round 2, 2026-05-10). Also captures rigor-survived design decisions worth preserving outside the spec.
  - 2026-05-10: append two PR1-implementation-time decisions — (a) rename `PRism.Core.Contracts.DraftComment`/`DraftReply` → `DraftCommentInput`/`DraftReplyInput` to resolve a three-way name collision against the new state types and the planned wire DTOs; (b) pull minimum compile-fix into Task 2's commit because Task 6's broader fixture work was downstream of a non-compiling test project.
  - 2026-05-10: append four PR2-implementation-time decisions — (a) defer `ReviewServiceFileContentSource` adapter and `IReviewService.GetCommitAsync` to PR3 (no consumer in PR2; cleaner scope split); (b) plan-described commit boundaries don't survive the repo's strict analyzers (CA1812 on unused fakes, CS8625 in MemberData arrays) — Task 10's fake and Task 12's red-test commit are merged into Task 17's orchestrator commit; (c) Task 19 Test 1 (`...AnchoredShaReachable_ClassifierShortCircuits`) had to be re-anchored at `LastViewedHeadSha = NewSha` to avoid the head-shift override-clear that Test 4 asserts (the plan's hardcoded `SessionWith` helper made Tests 1 and 4 mutually unsatisfiable); (d) Task 12 Row 6 expected `ResolvedLineNumber` reduced from 3 to 1 to keep tie-breaker semantics consistent with Row 4 (both have equidistant candidates [1, 3] vs originalLine=2 — lower-line wins).
---

# Deferrals — S4 drafts + composer spec

Tradeoffs surfaced during the brainstorming-skill rigor passes on the S4 spec and plan. Sources:
- `superpowers:brainstorming` clarifying-question pushback (2026-05-09)
- `compound-engineering:ce-doc-review` 7-persona pass on the spec (2026-05-09)
- PR #34 round-1 review — Copilot inline (4 comments) + claude-bot summary review (9 findings) on the spec (2026-05-09)
- `compound-engineering:ce-doc-review` 6-persona pass on the plan (2026-05-10) — skipped product-lens since strategic decisions live in the spec
- PR #34 round-2 review — Copilot inline (3 comments) + claude-bot summary review (9 findings) on spec + plan (2026-05-10)

Items the user already approved as in-scope or that were applied in commits land in the spec/plan; items that survived a counter-pressure round but were ultimately not pursued (or were postponed with a known revisit trigger) live here. The doc also captures **rigor-survived design decisions** (`## [Decision]`) so the rationale outlives the implementation pass.

---

## [Defer] Multi-line / range comments

- **Source:** `superpowers:brainstorming` clarifying question pass (2026-05-09)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** S4 design pushed me to defer multi-line per cost analysis: reconciliation matrix doubles in dimensionality (start + end anchor coherence; range-stretched / range-compressed / range-partially-deleted variants); diff renderer needs range-highlighting (currently single-line only); composer click-to-select becomes click-and-drag with keyboard equivalents. Estimated 30–50% larger slice. Spec/03 § 4 already mandated single-line-only for v1; S4 honors that. Product-lens persona pushed back ("dogfooders will try multi-line and bounce"), but the cost analysis held and the user explicitly chose to keep deferred after pushback.
- **Revisit when:** Dogfooding shows reviewers asking for multi-line on real PRs (multi-line is GitHub's secondary affordance via shift-click; PRism could ship single-line-only and gather signal). Best landing point: a focused multi-line slice between S5 and S6, OR P4 backlog; reconciliation algorithm extension is the load-bearing chunk.
- **Original finding evidence (product-lens, conf 0.75):** *"Multi-line comments deferred with one sentence — cost analysis is not honest about user impact."*

## [Defer] Bulk-discard + `deletePullRequestReview` cleanup on closed/merged PR

- **Source:** Spec brainstorming pass (2026-05-09)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** Spec § 6 explicitly defers this to S5 because the cleanup calls `deletePullRequestReview` on `pendingReviewId`, which is S5's idempotency key for the submit pipeline. Local-only bulk discard would be straightforward but pairing it with the orphan cleanup is the spec-described UX. S4 ships read-only banner + composer suppression for the closed/merged case; full cleanup defers.
- **Revisit when:** S5 starts (the submit pipeline lands `pendingReviewId` plumbing, at which point the bulk-discard + cleanup pair becomes a natural follow-up).
- **Original finding evidence:** Spec § 1.2 non-goals table.

## [Defer] PR-reopen reconciliation + foreign-pending-review prompt

- **Source:** Spec brainstorming pass (2026-05-09)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** Same coupling as above — the foreign-pending-review prompt depends on `pendingReviewId` being populated by S5. S4 detects PR-reopen via the active-PR poller and lifts the read-only banner; reconciliation against the new head runs at the next user-clicked Reload (standard path).
- **Revisit when:** S5 ships submit pipeline.
- **Original finding evidence:** Spec § 1.2 non-goals table.

## [Defer] Multi-tab conflict notification UI

- **Source:** `ce-doc-review` 7-persona pass — product-lens (confidence 0.75)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** PoC accepts last-writer-wins silently per spec/02 § Multi-tab consistency. The product-lens reviewer surfaced this as a "drafts silently dropped" principle violation and pushed for a soft-lease + banner approach. Counter-applied: cross-tab presence banner via `BroadcastChannel` (frontend-only, no backend lease) + out-of-band-update toast. Full conflict UI defers to v2 backlog `P4-F9`.
- **Revisit when:** Reviewers report losing comments after multi-tab editing, OR after a real-world dogfooding session shows that two-tab editing happens often enough that the soft mitigation isn't sufficient.
- **Original finding evidence (product-lens, conf 0.75):** *"Multi-tab last-writer-wins silently *deletes* drafts — the user's refined comment silently disappears, replaced by their own earlier draft they had no intent to re-save."*

## [Defer] Rich HTML allowlist in markdown rendering (`details/summary`/`kbd`/`sub`/`sup`)

- **Source:** Spec § 4 (existing precedent from spec/03)
- **Severity:** P3
- **Date:** 2026-05-09
- **Reason:** Spec/03 § 4 line 318 documents the gap explicitly — GitHub permits a broader HTML allowlist than `react-markdown`'s defaults. PRism's strict no-HTML stance renders all of these as escaped text. PoC trade-off: security over fidelity. Acceptable until reviewers report missing it.
- **Revisit when:** P4 backlog item; or reviewer feedback that PR descriptions / comments using these tags look broken in PRism vs github.com.
- **Original finding evidence:** Spec § 4 non-goals row.

## [Defer] AI-assisted reconciliation suggestions (`IDraftReconciliationAssistant`)

- **Source:** Spec § 5 (PoC AI seam pattern)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** PoC ships the `Noop*` and `Placeholder*` impls; the AI badge slot in `StaleDraftRow` exists in the component tree (spec § 5.5b) and renders `null` when `ai.draftReconciliationAssist === false` (which is the PoC default). v2 wires a real provider.
- **Revisit when:** P0+ AI-feature work begins.
- **Original finding evidence:** Spec § 1.2 non-goals table.

## [Defer] `<AiComposerAssistant>` "Refine with AI ✨" visible behavior

- **Source:** Spec § 5.8 (AI placeholder slots)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** Slot exists in the component tree (PR4 wires it per addendum A1); `ai.composerAssist` capability flag stays `false` in PoC; renders `null`. Same pattern as `IDraftReconciliationAssistant`.
- **Revisit when:** P0+ AI-feature work begins; v2 ships a real composer-assistant impl.
- **Original finding evidence:** Spec § 1.2 non-goals table.

## [Defer] `IReviewService` capability split

- **Source:** ADR-S5-1 (architectural-readiness doc)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** S4 uses `IReviewService.GetFileContentAsync` directly (and adds `GetCommitAsync` if absent). Splitting `IReviewService` into `IReviewAuth` / `IPrDiscovery` / `IPrReader` / `IReviewSubmitter` is gated to S5 per ADR-S5-1; that split makes S5's tests faketable on `IReviewSubmitter` alone without dragging the whole 10-method interface.
- **Revisit when:** S5 starts.
- **Original finding evidence:** Spec § 1.2 non-goals table; ADR-S5-1.

## [Defer] Frontend types codegen (NSwag / openapi-typescript)

- **Source:** ADR-P0-1 (architectural-readiness doc)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** S4 hand-mirrors new types in `frontend/src/api/types.ts` per S2/S3 precedent. Codegen lands when frontend-drift bugs surface in production OR when P0+ AI features add ~14 new wire shapes.
- **Revisit when:** P0+ work begins, or first frontend-drift bug, whichever comes first.
- **Original finding evidence:** Spec § 1.2 non-goals table; ADR-P0-1.

## [Defer] File-fetch concurrency cap (8 concurrent + bounded `SemaphoreSlim` + 10s per-fetch timeout)

- **Source:** Plan PR-review round-2 — claude-bot finding #4 (2026-05-10)
- **Severity:** P2
- **Date:** 2026-05-10
- **Reason:** Earlier draft of spec § 3.3 promised "File fetches happen in parallel (cap: 8 concurrent — bounded `SemaphoreSlim` inside the pipeline) with a per-fetch timeout (10 s)." Plan implementation in Task 17 was sequential; the test `Reload_FileFetchConcurrencyCappedAt8` listed in spec § 4.9 was unimplementable against the sequential loop. Marked MVP-deferred in spec § 3.3 + § 4.9 (`~~Reload_FileFetchTimeout~~` and `~~Reload_FileFetchConcurrencyCappedAt8~~` struck through). Typical PRs have few anchored drafts; reload IS the user-perceived "wait moment" anyway.
- **Revisit when:** Dogfooding hits a 50+ drafts × 20+ files PR and reload time becomes user-noticeable (>5s sustained), OR P0+ scale considerations introduce per-PR throughput requirements.
- **Original finding evidence (claude-bot, conf high):** *"Task 17's pipeline implementation loops through `session.DraftComments` sequentially. Spec § 3.3 says 'File fetches happen in parallel (cap: 8 concurrent — bounded `SemaphoreSlim` inside the pipeline)'. Spec § 4.9 lists `Reload_FileFetchConcurrencyCappedAt8` as a required test … without a note, the PR3 implementer will spend time writing a test that can't exercise the stated constraint."*

## [Defer] E2E coverage for rename + file-deleted matrix rows

- **Source:** Plan PR-review round-2 — claude-bot finding #5 (2026-05-10)
- **Severity:** P2
- **Date:** 2026-05-10
- **Reason:** Task 29's reload endpoint passes empty `renames` / `deletedPaths` maps to the pipeline (the wiring to derive these from the PR's file-changes list lands in a follow-up that wires `IPrDetailLoader.GetFiles()` into the reload handler). Unit tests in `RenameTests.cs` and `DeleteTests.cs` cover the pipeline behavior with explicit maps; the end-to-end flow (GitHub API → PR file diff → build maps → pipeline) defers. Plan Task 48 Step 2 now explicitly notes the MVP scope: rows 1-7 + force-push + verdict-reconfirm covered in S4; rename + file-deleted defer.
- **Revisit when:** A small follow-up PR (post-S4, pre-S5) wires `IPrDetailLoader.GetFiles()` into the reload handler. ETA: should land alongside or just after S5 to unblock the full reconciliation matrix on real PRs.
- **Original finding evidence (claude-bot):** *"Task 29 explicitly defers the integration: 'For MVP: pass empty maps; extension lands when iterating against real PRs.' This means the E2E test `s4-reconciliation-fires.spec.ts` cannot cover Rename or Delete rows."*

## [Defer] Generic merger walker for future array fields in `useDraftSession`

- **Source:** Plan ce-doc-review — adversarial finding F9 (2026-05-10)
- **Severity:** P3
- **Date:** 2026-05-10
- **Reason:** The diff-and-prefer merger in Task 36 hard-codes `draftComments` and `draftReplies` as the two arrays it walks. If `ReviewSessionDto` grows a third array field in a future slice (S5's `IterationOverrideDto[]` becomes populated, or AI metadata arrays), the merger needs a parallel pass. For S4, hardcoded is fine. The adversarial reviewer's "make it generic" alternative is over-engineering for current scope. The merger's code comment names the brittleness.
- **Revisit when:** A future slice adds a third user-edited array on `ReviewSessionDto` that needs open-composer protection (i.e., something the user is actively editing, not display-only data).
- **Original finding evidence (adversarial, conf 0.50):** *"if a server adds a 13th-kind effect (out-of-band reply update), is the merger ready? — this is really about the merger being generic enough to walk arbitrary array fields, vs. hard-coded to draftComments / draftReplies."*

## [Defer] `PerPrSemaphores` shrink / eviction in `PrReloadEndpoints`

- **Source:** Plan PR-review round-2 — claude-bot finding #8 (2026-05-10)
- **Severity:** P3
- **Date:** 2026-05-10
- **Reason:** The static `ConcurrentDictionary<string, SemaphoreSlim>` accumulates one entry per distinct `prRef` seen during the server lifetime, never cleaned up. For the single-user local PoC this is negligible (handful of unique PRs in a session). Future hosted scenarios need a periodic eviction pass keyed on last-acquired timestamp. Comment added to the field declaration in Task 29.
- **Revisit when:** PRism transitions from local-only PoC to hosted multi-user scenario (out of current roadmap), OR if a long-running local session somehow hits hundreds of unique PRs.
- **Original finding evidence (claude-bot):** *"static readonly ConcurrentDictionary<string, SemaphoreSlim> PerPrSemaphores accumulates one entry per distinct prRef seen during the server lifetime, never cleaned up. For the PoC, this is negligible."*

---

## [Skip] Strict ADR-S4-1 wrap shape (Inbox placeholder + Identity wrapper)

- **Source:** `superpowers:brainstorming` clarifying-question pushback (2026-05-09)
- **Severity:** P2
- **Date:** 2026-05-09
- **Reason:** ADR-S4-1 sketched `AppState { InboxState Inbox; PrSessionsState Reviews; AiState Ai; }` with empty `InboxState` placeholder. I pushed back during brainstorm: the ADR's premise ("by P0+ AppState becomes a 30+ property record") was already partly addressed by pre-S4 refactors that pulled `AiState` and `UiPreferences` into their own sub-records. Pollution growth happens *inside* `ReviewSessionState`, not at AppState top level. The user picked the minimal-wrap option (Reviews-only rename, no `InboxState` placeholder, no `Identity` wrapper).
- **Revisit when:** N/A unless P0+ work introduces persisted inbox state or identity bookkeeping that warrants its own sub-record. The minimal-wrap decision can be revisited when an actual consumer for `InboxState` exists.
- **Original finding evidence:** ADR-S4-1 verbatim sketch.

## [Skip] SSE `draftId` leak to all subscribed tabs

- **Source:** Spec ce-doc-review — security-lens finding 5 (2026-05-09)
- **Severity:** P3
- **Date:** 2026-05-09
- **Reason:** The `draft-saved` / `draft-discarded` SSE payloads include `draftId` and fan out to all subscribed tabs regardless of which PR they're viewing. In the local-only single-user threat model, UUIDs are not access keys: `update`/`delete` operations still require the session token. The frontend filters by `prRef` so cross-PR tabs ignore the event. Worth re-examining only if a future slice makes `draftId` access-conferring.
- **Revisit when:** A future capability lets a known `draftId` shortcut auth (e.g., a direct-link to a draft, deep-linking from a notification system).
- **Original finding evidence (security-lens, conf 0.50):** *"the `draftId` (a server-assigned UUIDv4) is visible in the raw SSE stream to any tab that receives the event, including tabs viewing different PRs. In the current single-user, local-only threat model, this is low-consequence."*

## [Skip] `IFileContentSource` rename to `ICommitFileReader` / `IFileAtShaSource`

- **Source:** Spec ce-doc-review — scope-guardian finding 3 (2026-05-09)
- **Severity:** P4
- **Date:** 2026-05-09
- **Reason:** Advisory only. `IFileContentSource` is slightly over-general; `IFileAtShaSource` would narrow the contract to "file content at a specific SHA," preventing accidental re-use for unrelated file-reading scenarios. The cost of renaming is non-zero and the rename has no functional benefit. Defer to implementation taste.
- **Revisit when:** N/A unless an unrelated file-reading need accidentally extends `IFileContentSource` and the over-general name causes confusion.
- **Original finding evidence (scope-guardian, conf 0.50):** *"the name `IFileContentSource` is slightly over-general — `IFileAtShaSource` or `ICommitFileReader` would narrow the contract."*

## [Skip] Removing `pendingReviewId` / `pendingReviewCommitOid` from v3 schema

- **Source:** Plan ce-doc-review — adversarial finding F14 (2026-05-10)
- **Severity:** P3
- **Date:** 2026-05-10
- **Reason:** S4 has zero producers and zero consumers of these two fields — they were defined in S3 anticipatorily for S5. The adversarial reviewer surfaced them as "speculative complexity tax." Counter-evaluation: cost-to-keep is trivial (already in v2; kept by the v3 migration unchanged); S5 is the next slice and lands them as producers within weeks. Removing and re-adding adds churn without benefit.
- **Revisit when:** N/A unless S5 slips materially (>1 month) and the unused fields accumulate maintenance interest.
- **Original finding evidence (adversarial, conf 0.50):** *"S4 has zero producers and zero consumers of these two fields. They were defined in S3 anticipatorily for S5."*

## [Skip] `IReviewEvent` interface-level `SourceTabId` field

- **Source:** Plan ce-doc-review — feasibility finding F8 (2026-05-10)
- **Severity:** P3
- **Date:** 2026-05-10
- **Reason:** Spec § 4.5 said *"a new field on `IReviewEvent` carriers"* — implying the field belongs at the interface. Plan put it on per-record carriers (the four S4 events) only; pre-existing `InboxUpdated` / `ActivePrUpdated` events don't get the field. The adversarial reviewer flagged the deviation. Counter-evaluation: per-record placement works for S4 usage (the SSE projection switch already type-tests before reading); reload events fire from HTTP handlers and naturally carry the field. Future events that need the field add it per-record. The interface-level change would force a parameter on every existing event record without consumer benefit.
- **Revisit when:** N/A unless a future cross-cutting concern needs to read `SourceTabId` polymorphically across all event types.
- **Original finding evidence (feasibility, conf 0.75):** *"The spec wants `SourceTabId` on the `IReviewEvent` interface (or the carrier base) so every event has it uniformly. The plan instead adds `SourceTabId` only to the four new records."*

## [Skip] `_gate` global serialization across all PRs

- **Source:** Plan ce-doc-review — adversarial finding F3 (2026-05-10)
- **Severity:** P3
- **Date:** 2026-05-10
- **Reason:** `AppStateStore._gate` serializes ALL `state.json` writes globally — not per-PR. With multiple composers across multiple PRs auto-saving on debounce, throughput is bounded. The reviewer raised it as a scaling concern. Counter-evaluation: PoC is single-user, single-PR-mostly. Documented as known boundary in spec § 4.6. Per-PR sharding is a v2 backlog item if dogfooding shows lag.
- **Revisit when:** Composer auto-save shows visible lag (>200ms between keystroke and "saved" badge) on real-world multi-PR / multi-composer scenarios.
- **Original finding evidence (adversarial, conf 0.75):** *"With multiple PR detail tabs open, both with active composers, generates 8 PUTs/sec sustained. … This may be fine in PoC scale, but the plan does not analyze it."*

## [Skip] `IFileContentSource` per-call cache memory unbounded

- **Source:** Plan ce-doc-review — adversarial finding F8 (2026-05-10)
- **Severity:** P4
- **Date:** 2026-05-10
- **Reason:** The per-`Reconcile()` cache holds entire file contents in memory; no eviction or size cap. For 100 drafts across 50 files at ~2 SHAs, memory could spike to tens of MB transiently. The reviewer flagged it as advisory. Counter-evaluation: PoC scope. If a 100MB-file PR shows up, the implementer can add a per-file size cap then. Adding it speculatively is over-engineering.
- **Revisit when:** Memory profiling shows reload spikes hurting other operations, OR a real PR with very large generated files shows up.
- **Original finding evidence (adversarial, conf 0.50):** *"100 drafts across 50 distinct files at 2 SHAs (anchored + new head) could hold 100 file contents in memory simultaneously. Average file size unbounded."*

## [Skip] PR3 split into PR3a/PR3b

- **Source:** Plan ce-doc-review — adversarial finding F10 (2026-05-10)
- **Severity:** P3 (advisory)
- **Date:** 2026-05-10
- **Reason:** PR3 lands ~18 files across six review concerns. The reviewer suggested splitting into PR3a (events + SSE projection + IActivePrCache + IReviewService.GetCommitAsync + ReviewServiceFileContentSource) and PR3b (PUT/GET /draft + POST /reload + middleware + spec/02 doc edit + tests). Counter-evaluation: split is offered as advisory in the plan's Phase 3 header, not forced. PR1 is similarly sized (11 files) and is a pure refactor with no concerns. Whether to split is a reviewer-attention call at PR-creation time, not a plan-mandated decision.
- **Revisit when:** During PR3 creation, if the reviewer feels the load is too high, split per the documented PR3a/PR3b cut.
- **Original finding evidence (adversarial, conf 0.75):** *"PR3 lands a LOT in one PR — endpoint, events, SSE projection, IReviewService addition, body-cap middleware extension, spec doc edit. Could it deadlock review?"*

## [Skip] Matrix tier priority — exact-elsewhere wins over whitespace-equiv-at-original

- **Source:** PR2 preflight adversarial review (2026-05-10)
- **Severity:** P2 (UX consequence)
- **Date:** 2026-05-10
- **Reason:** Spec/03 § 5's seven-row matrix orders the matcher tiers strictly: exact-tier wins over whitespace-equiv-tier. Rows 5–6 are gated on "no exact match." This means a draft anchored on a line that gets auto-formatted (so the original line is whitespace-equivalent at originalLine) but whose exact bytes happen to appear elsewhere in the file lands in Row 3 (single exact elsewhere → Moved) instead of staying at the user's anchor. The implementation is faithful to the spec; the question is whether the spec's tier-priority is the right design choice for the "auto-formatter ran on an otherwise stable file" case. Spec § 5 does add a "subtle badge" on Row 3 ("moved to line M") so the user has visual feedback, which softens the silent move. The user explicitly chose to keep this as-is for PR2 after pushback during preflight.
- **Revisit when:** Dogfooding shows reviewers losing comments after auto-format runs, OR a follow-up product-lens pass on spec/03 § 5 decides whitespace-equiv-at-original should override exact-elsewhere. The fix would be a Row 5b in the classifier and a corresponding spec edit.
- **Original finding evidence (adversarial, conf 0.75):** *"Matrix gap — when the anchored line is whitespace-equivalent at originalLine AND exact elsewhere... classifier returns Moved to line elsewhere, ignoring the at-original whitespace-equiv match. Repro: anchored='line B', originalLine=2, file='line B\\n  line B  \\nline C\\n' → ExactElsewhere=[1], WhitespaceEquivAll=[2] → Moved to line 1."*

## ~~[Skip] Verdict reconcile with null `LastViewedHeadSha` returns NeedsReconfirm~~ → Applied (2026-05-10, post-open review)

- **Source:** PR2 preflight adversarial review (2026-05-10); re-surfaced as Finding A in claude[bot]'s post-open review (2026-05-10).
- **Severity:** P3 (originally) / pattern-asymmetry latent trap (claude[bot])
- **Date:** 2026-05-10 (skipped); 2026-05-10 (applied after re-review)
- **Original reason for skip:** Currently unreachable through normal user flow — verdict requires viewing the PR which sets `LastViewedHeadSha` first.
- **Why applied after all:** claude[bot]'s post-open review surfaced a different angle: even if the case is unreachable, the verdict head-shift check (no null guard) is asymmetric with the override head-shift check at the top of `ReconcileAsync` (which DOES guard null). The asymmetric pattern is a latent trap for whoever wires PR3's endpoint. Aligning the check costs one boolean variable, restores symmetry, and adds a `VerdictSetButLastViewedHeadShaNull_Unchanged` test pinning the behavior.
- **Resolution:** `verdictHeadShifted` boolean now mirrors the override pattern (`session.LastViewedHeadSha is not null && session.LastViewedHeadSha != newHeadSha`).
- **Original finding evidence (adversarial, conf 0.40):** *"Verdict reconcile uses `session.LastViewedHeadSha != newHeadSha` directly. If LastViewedHeadSha is null... the comparison evaluates to NeedsReconfirm... Currently unreachable through normal user flow."*

## [Skip] PR1 line-number annotation off (8 numbers for "6 hits")

- **Source:** Plan ce-doc-review — feasibility finding F6 (2026-05-10)
- **Severity:** P5 (cosmetic)
- **Date:** 2026-05-10
- **Reason:** Plan Task 5 Step 1 said "Expected: 6 hits at approximately lines 104, 109, 111, 117, 162, 168, 186, 188" — 8 numbers for "6 hits" (lines 104 and 162 are `var key = $"{owner}/...` lines, not `ReviewSessions` references). The count is right; the line list overspecifies. An implementer running the grep gets the truth. Not worth a plan edit.
- **Revisit when:** N/A.
- **Original finding evidence (feasibility, conf 1.00):** *"Plan Task 5 Step 1 says: `Expected: 6 hits at approximately lines 104, 109, 111, 117, 162, 168, 186, 188.` That's eight numbers for "6 hits.""*

---

## [Decision] `IsOverriddenStale` cleared on head shift (single-use override per anchor state)

- **Source:** Spec ce-doc-review (2026-05-09); plan PR-review round-2 elevation to a critical fix (2026-05-10)
- **Date:** 2026-05-09 (decision); 2026-05-10 (mechanism implemented)
- **Decision:** When the user clicks "Keep anyway" on a stale draft, the backend sets `IsOverriddenStale = true` (new field on `DraftComment` and `DraftReply`, default `false`). The reconciliation pipeline's classifier respects the flag: a draft that would otherwise classify as `Stale` is reclassified as `Draft` (with `IsOverriddenStale` preserved) so submit is unblocked. **On head shift (any `headSha` change since the override was set), `IsOverriddenStale` is cleared by the apply-result step (Phase 2 of § 3.3) before the matrix runs.**
- **Why:** Earlier S4 draft narrowed "Keep anyway" to a UI dismissal that suppressed the panel row until the next Reload. Product-lens + design-lens + scope-guardian + adversarial all surfaced this as a UX contradiction (user clicks Keep anyway → row reappears on next reload → user clicks again → loop). The corrected approach faithfully implements `spec/03-poc-features.md` § 5's *"Keep anyway moves draft from `stale` to `draft` status — user accepts it might land on the wrong line; rare but allowed"* — but with the constraint that the override is single-use per anchor state. Once the code changes again (next teammate push), the user must re-judge. This prevents accumulating stale overrides that silently survive code changes — exactly the failure mode the spec intent guards against.
- **Trade-off considered and rejected:** Persisting the override across head shifts (the behavior the user might naively expect from "Keep anyway"). Rejected because it would let stale overrides land on lines the reviewer hasn't seen in the new context — exactly the wrong outcome under "the reviewer's text is sacred."
- **Tested by:** `OverrideStaleTests.HeadShiftBetweenReloads_ClearsOverride` (added 2026-05-10).

## [Decision] Diff-and-prefer merge replaces `OpenComposerRegistry` context

- **Source:** Spec ce-doc-review — scope-guardian + adversarial findings (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** `useDraftSession` owns a refcount-based registry (`Map<draftId, number>`) inside the hook; the cache-merge logic consults the refcount and keeps local body for `count > 0` ids. Replaces the earlier `OpenComposerRegistry` React context.
- **Why:** Original design used a separate React context for the open-composer set. Two reviewers independently surfaced concerns: (a) lifecycle is per-composer mount/unmount, easy to forget; (b) deletion case (Tab A holds a draft id that Tab B deleted) wasn't handled — the registry correctly preserves Tab A's body but Tab A's next `updateDraftComment` 404s with no recovery path. The diff-and-prefer approach folds the registry into `useDraftSession` (one place, one lifecycle) AND surfaces deletion explicitly via the 404 recovery modal (Re-create / Discard).
- **Trade-off considered and rejected:** Keeping `OpenComposerRegistry` context with explicit deletion handling. Rejected because the registry is a parallel lifecycle outside the cache, and the deletion failure mode would still need to be wired separately. Diff-and-prefer is less infrastructure with better failure surface.
- **Tested by:** `useDraftSession.test.ts` (5 tests covering merge protection, server-acceptance, deletion-elsewhere, out-of-band-toast, own-tab filtering).

## [Decision] 3-char auto-save threshold in UTF-16 code units

- **Source:** Spec ce-doc-review — product-lens + adversarial findings (2026-05-09); plan PR-review round-1 emoji-edge clarification (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** Composer auto-save creation gates on `body.trim().length >= 3` measured in UTF-16 code units. Below threshold, keystrokes accumulate locally only (no PUT). Once `draftId` exists, subsequent updates fire regardless of body length (1-char and 2-char edits update; 0-char auto-deletes the draft).
- **Why:** First-keystroke-creates-draft (the original simpler design) accumulates orphan drafts from accidental keystrokes ("user opens composer, hits `f` while reaching for `j`, walks away → on return, finds a draft they don't recognize"). 3-char threshold filters typos without compromising auto-save protection on real text. Code-unit choice is deliberate: a single emoji like `👍` is 2 UTF-16 code units (1 code point) → does NOT cross the threshold on its own, but `👍!` (3 code units) does. PoC accepts that two-character responses ("No", "OK") don't auto-save until a third character — short responses are uncommon in code review.
- **Trade-off considered and rejected:** (a) Code-point counting (`[...str].length`) — would let `👍` save alone but adds Unicode complexity for marginal benefit. (b) No threshold — original simpler design; rejected per orphan-accumulation concern. (c) Higher threshold (e.g., 5 chars) — would filter even more typos but lose responses like "fix?" (4 chars) which are legitimate.
- **Override path:** `Cmd/Ctrl+Enter` force-flushes auto-save bypassing the threshold (per § 5.3a). User who wants to save a 1-char comment can.
- **Tested by:** `useComposerAutoSave.test.ts` cases `BodyBelow3Chars_NoPut_NoDraftCreated` + `BodyAt3Chars_FiresNewDraftComment`.

## [Decision] Cross-tab presence banner via `BroadcastChannel` (frontend-only mitigation)

- **Source:** Spec ce-doc-review — product-lens finding (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** `useCrossTabPrPresence` uses the browser `BroadcastChannel` API. When two tabs open the same PR, both surface a non-dismissable (per-session-dismissable) banner with three actions: Switch to other tab / Take over / Dismiss for this session. Backend has no knowledge of tab identity; the mitigation is frontend-only.
- **Why:** Spec/02 § Multi-tab consistency accepts last-writer-wins silently. Product-lens reviewer escalated this to a "drafts silently dropped" principle violation. Counter-applied: a frontend-only banner surfaces the risk and offers one-click resolution without inventing a new backend coordination primitive (which would be conflict-detection UI proper, the v2 P4-F9 backlog item).
- **Trade-off considered and rejected:** Backend soft-lease (per-PR active editor lease via SSE). Rejected for S4 because it requires backend changes (lease acquire/release/revoke/expire) and SSE write-paths to other tabs. The frontend-only `BroadcastChannel` mitigation is < 100 lines of code and addresses 80% of the risk for ~10% of the engineering cost.
- **Acknowledged limitation:** Banner does not *prevent* the underlying race — two tabs CAN still write concurrently if the user dismisses or ignores the banner. The session-storage dismissal acts as an escape hatch for "I have this PR pinned in a background window deliberately" use cases. Full prevention defers to v2/P4-F9.

## [Decision] First-keystroke creates draft (collapses spec/03 § 4 in-flight composer concept)

- **Source:** Spec brainstorming pass (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** First non-whitespace keystroke (gated by 3-char threshold) creates the draft on disk via `newDraftComment`. There is no separate "in-flight composer" sidecar — the persisted draft IS the in-flight composer.
- **Why:** Original spec/03 § 4 contemplated an in-flight composer as a distinct concept (typed text not yet a draft). The collapsed model is simpler: one persistence path, one wire shape, one merger rule. The 3-char threshold is the boundary between "transient text" and "real draft."
- **Trade-off considered and rejected:** Separate in-flight buffer keyed by anchor, promoted to a real draft on explicit Save / `Cmd+Enter` / Reload. Rejected because it doubles the storage shape and the merger logic without a corresponding user-visible benefit (auto-save protects against accidental tab close in either model).

## [Decision] `useDraftSession` plain-React-state, NOT TanStack Query

- **Source:** Plan ce-doc-review — feasibility finding F4 (2026-05-10)
- **Date:** 2026-05-10
- **Decision:** `useDraftSession` uses `useState` + `useEffect` + manual reload counter (matches S3's `usePrDetail` precedent). NOT TanStack Query.
- **Why:** Earlier plan draft assumed TanStack Query was already in use from S3. Verified absent: `frontend/package.json` has no `@tanstack/react-query` dependency. Adding it would scope-creep S3-refactor work into S4. The diff-and-prefer merge logic works as well in plain React (one small merge function in the hook) as in TanStack Query (cache-replacement override).
- **Trade-off considered and rejected:** Adding TanStack Query as a new dependency in S4 + refactoring S3's `usePrDetail` to use it. Rejected because (a) it's S3-touching scope creep; (b) the merge logic is no more complex in plain React; (c) the `excludeIds` mechanism originally specified for TanStack-style cache override doesn't even need to exist in the simpler plain-state model.

## [Decision] `PrSessionsState` minimal wrap (no `InboxState` placeholder)

- **Source:** Spec brainstorming pass (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** `AppState.ReviewSessions` → `AppState.Reviews: PrSessionsState` (where `PrSessionsState { Sessions: Dictionary<string, ReviewSessionState> }`). No `InboxState` placeholder; no `Identity` wrapper.
- **Why:** ADR-S4-1 sketched a fuller wrap with `InboxState` placeholder pre-allocated. Pushback during brainstorm: there's no persisted inbox state today (inbox is computed live), so the empty placeholder is YAGNI. Migration locality benefit comes from `PrSessionsState` owning the per-version migration helpers, not from speculative wrapping.
- **Trade-off considered and rejected:** Strict-ADR shape with `InboxState` (empty) + `Identity` wrapper. Rejected because empty placeholders accrue maintenance overhead (every `with` expression has to thread them) without consumer benefit.

## [Decision] Migration framework as ordered chain `(toVersion, transform)[]`

- **Source:** Spec brainstorming pass (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** `AppStateStore` carries a `static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] Steps`. `MigrateIfNeeded` finds steps with `stored < ToVersion <= CurrentVersion` and applies in order. Each step is a static method.
- **Why:** Of the four shapes considered (ordered chain / visitor pattern / per-domain dispatch / inline if-else), ordered chain has minimal ceremony and obvious extension point. Visitor adds DI scaffolding for nothing. Per-domain dispatch over-structures for the current cadence. Inline if-else doesn't scale past 3-4 versions.
- **Trade-off considered and rejected:** Visitor pattern with `IMigration` interface — chosen against because of unnecessary DI complexity for a pure JSON transform.

## [Decision] Two-phase reload (Phase 1 outside `_gate`, Phase 2 inside)

- **Source:** Spec ce-doc-review — adversarial finding (2026-05-09); plan refinement during round-2 review
- **Date:** 2026-05-09
- **Decision:** `POST /reload` runs in two phases. Phase 1 (no gate held): build `IFileContentSource`, call `pipeline.ReconcileAsync(...)` with PoC's sequential file fetches. Phase 2 (gate held briefly): `appStateStore.UpdateAsync` writes the result atomically. Head-shift detection between phases compares against `IActivePrCache.GetCurrent()` and returns `409 reload-stale-head` if divergent.
- **Why:** `_gate` is the global `state.json` serialization point. Holding it across multi-second GitHub fetches blocks every other write (composer auto-saves in other tabs, viewed-files writes, etc.). Two-phase keeps the gate hold to milliseconds.
- **Trade-off considered and rejected:** Single-phase with the entire pipeline running under `_gate`. Rejected because of the cascade-blocking concern (sustained file fetches could mute auto-saves system-wide).

## [Decision] `409 reload-stale-head` frontend auto-retries once

- **Source:** Spec PR-review round-1 — claude-bot Architectural #4 (2026-05-09)
- **Date:** 2026-05-09
- **Decision:** `useReconcile` auto-retries once with the `currentHeadSha` from the `409 reload-stale-head` response body (transparent to the user). Banner only on second consecutive 409 ("Head shifted while reloading; please click Reload again.").
- **Why:** First 409 means the poller advanced head between Phase 1 and Phase 2 — rare but possible. The user's intent ("reload to current head") is unchanged, so silently retrying with the now-current head is correct. Second 409 in a row means the head is moving faster than reload can complete (extremely rare; warrants surfacing).
- **Trade-off considered and rejected:** (a) Always surface the banner on 409 — would force the user to click Reload twice for a momentary race they didn't cause. (b) Indefinite retry loop — could mask a degenerate case where the head shifts repeatedly.

## [Decision] Rename `Contracts.DraftComment`/`DraftReply` → `DraftCommentInput`/`DraftReplyInput`

- **Source:** PR1 implementation — surfaced when the new `PRism.Core.State.DraftComment`/`DraftReply` records collided with the existing `PRism.Core.Contracts.DraftComment`/`DraftReply` skeletons added in S0+S1 (commit `0982284`).
- **Date:** 2026-05-10
- **Decision:** Rename the *existing* Contracts skeleton types to `DraftCommentInput` and `DraftReplyInput`. The new state-layer types in `PRism.Core.State` keep the bare names `DraftComment`/`DraftReply` per spec § 2.4. The Contracts versions retain their AI-seam-input role (consumed by `IDraftReconciliator`) — the suffix clarifies the intent.
- **Why renamed Contracts (not State):** Three logical "DraftComment" shapes exist or are planned:
  1. `PRism.Core.State.DraftComment` (this PR) — persistent record with `Status` / `IsOverriddenStale` / nullable file/line for PR-root drafts.
  2. `PRism.Core.Contracts.DraftComment*` (existing seam input) — required file/line/sha/anchor + `ThreadId`; consumed only by `IDraftReconciliator` (currently Noop/Placeholder; real consumer is post-PoC).
  3. `DraftCommentDto` (planned PR3, spec § 4.2 line 407) — wire DTO for the GET `/draft` response.

  Renaming State to `PersistedDraftComment` would force spec/plan rewrites across ~40 named references. Renaming the planned wire DTO leaves the seam name colliding with State. Renaming the existing seam type touches 6 files (no spec edits) and aligns with its actual role.
- **Why `Input` (not `Dto`):** `Dto` is already claimed by the planned wire DTOs in PR3. `Input` distinguishes seam-input shapes from network/persistence-boundary DTOs.
- **Trade-off considered and rejected:** Per-file `using` aliases at every conflict point. Worked locally for one test file, but the collision recurs in any code that touches both layers (PR2 reconciliation tests, PR3 endpoint code). One-time rename is cheaper than per-file alias discipline.
- **Surface of change:** `PRism.Core.Contracts/DraftComment.cs` (record + filename), `PRism.Core.Contracts/DraftReply.cs` (record + filename), `PRism.Core.Contracts/DraftReview.cs` (consumer), `PRism.AI.Contracts/Seams/IDraftReconciliator.cs` (consumer), `PRism.AI.Contracts/Noop/NoopDraftReconciliator.cs` (consumer), `PRism.AI.Placeholder/PlaceholderDraftReconciliator.cs` (consumer), `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs` (consumer). No spec/plan edits required.

## [Decision] PR2 file-list correction: defer `ReviewServiceFileContentSource` + `IReviewService.GetCommitAsync` to PR3

- **Source:** PR2 implementation — the plan's "Files touched" header for Phase 2 lists `Create: PRism.Core/Reconciliation/Pipeline/ReviewServiceFileContentSource.cs` and `Modify: PRism.Core/IReviewService.cs (add GetCommitAsync if absent)`, but no task in 10–21 implements either. The kickoff brief states "no consumers wired in this PR; that's PR3."
- **Date:** 2026-05-10
- **Decision:** Both deferred to PR3, where they become load-bearing (the reload endpoint constructs `ReviewServiceFileContentSource` and the reachability probe calls `IReviewService.GetCommitAsync`). PR2 ships with the `IFileContentSource` interface + test fake + orchestrator + 27 tests; production wiring is PR3's job.
- **Why:** Adding the adapter in PR2 with no caller would land dead code (CA1812-adjacent: any analyzer flagging unused production types would trip; even without analyzer fail, the unused class is review noise). Adding `GetCommitAsync` to `IReviewService` requires `PRism.GitHub` to ship an implementation, which expands PR2 surface beyond its title's scope ("DraftReconciliationPipeline + matrix tests + override semantics").
- **Trade-off considered and rejected:** Land both in PR2 as scaffolding so PR3 only adds endpoint code. Rejected because (a) dead production code until PR3 lands; (b) PR3's scope is already explicit; (c) keeping PR2 strictly to "no consumers" matches the kickoff brief.
- **Surface of change in PR3:** Two file additions + one one-method addition to the existing `IReviewService` + one implementation in `GitHubReviewService`.

## [Decision] PR2 commit-boundary deviation — strict analyzers force test+orchestrator commit merge

- **Source:** PR2 implementation — the repo enforces `CA1812` (unused-internal-class → error) and `CS8625` (null-in-non-nullable-context → error). Plan Task 10 commits `FakeFileContentSource` standalone (no consumer yet) and Task 12 commits `MatrixTests.cs` red (referencing `DraftReconciliationPipeline` before Task 17 creates it).
- **Date:** 2026-05-10
- **Decision:** Tasks 10 (fake), 12 (matrix tests), and 17 (orchestrator) are merged into a single commit (`feat(s4-pr2): DraftReconciliationPipeline + seven-row matrix tests`). The interface from Task 10 still ships standalone (no analyzer trip on a public interface), and the four step files (Tasks 13–16) and DTOs (Task 11) ship in their own commits.
- **Why:** Each commit must leave the build green per global rules. The plan's red-commit pattern relies on "test runs and fails," but in C# with strict analyzers the only achievable red is a compile error — which violates the green-commit rule. Merging the test fixture, fake, and implementation preserves observable TDD red→green in the dev workflow (the matrix tests fail in-memory before the orchestrator file exists; pass after) while keeping every committed tree green.
- **Trade-off considered and rejected:** (a) Suppress CA1812 on the fake until consumers exist — works but requires the suppression to be removed later. (b) Stub the orchestrator with `throw new NotImplementedException()` to satisfy compile, then implement in a later commit — adds two extra commits, hides the actual TDD sequence. The merged commit is the cleanest representation.
- **Tested by:** All 27 reconciliation tests pass against the merged commit.

## [Decision] PR2 Task 19 Test 1 re-anchored to NewSha — `LastViewedHeadSha = NewSha` to prevent head-shift override-clear

- **Source:** PR2 implementation — plan Task 19 lists 4 tests (`OverrideStaleTests`). Test 1 (`IsOverriddenStaleTrueAndAnchoredShaReachable_ClassifierShortCircuitsToDraft`) uses the same `SessionWith(params DraftComment[])` helper as Test 4 (`HeadShiftBetweenReloads_ClearsOverride`), which hardcodes `LastViewedHeadSha = OldSha`. Both tests reload to `NewSha`, so both have head-shift = TRUE. Test 1 expects override short-circuit (Status=Draft, IsOverriddenStale=true); Test 4 expects override-cleared (Status=Stale, IsOverriddenStale=false). With the plan's pipeline implementation (head-shift clears override at top of `ReconcileAsync`), Tests 1 and 4 are mutually unsatisfiable.
- **Date:** 2026-05-10
- **Decision:** Test 1 reconstructs its session with `LastViewedHeadSha = NewSha` (no head shift) so the override persists into the classifier; the matrix says Stale → override gate fires → result is Status=Draft, IsOverriddenStale=true. Test 4 keeps the helper's `OldSha → NewSha` shift to assert the head-shift-clears contract. Tests 2 and 3 work with either setup; left on the helper.
- **Why:** The override semantics from spec § 3.2 are: (a) head shift always clears override (single-use per anchor state); (b) override-then-stale-content short-circuits to Draft. These are two distinct paths. The plan author wrote both tests with head-shift fixtures, which collapses the cases. Re-anchoring Test 1 separates them.
- **Trade-off considered and rejected:** Move head-shift clearing from the top of `ReconcileAsync` to the apply-result step (Phase 2 of § 3.3 — the spec's literal wording). Rejected because (a) larger deviation from the plan's pipeline implementation; (b) requires the reconciliation result DTO to round-trip the un-cleared `IsOverriddenStale` value back to the apply step (which it already does, but for a different reason: surviving the override-still-set short-circuit); (c) Test 4 would also need rewriting.
- **Tested by:** All 4 OverrideStaleTests pass against the corrected setup.

## [Decision] PR2 Task 12 Row 6 `ResolvedLineNumber` reduced from 3 to 1 — single tie-break for the matrix

- **Source:** PR2 implementation — plan Task 12's seven-row matrix has Row 4 (multiple exact-elsewhere) and Row 6 (multiple whitespace-equiv) with the same candidate shape `[1, 3]` and `originalLine = 2`. Both candidates are mathematically equidistant (|1-2| = |3-2| = 1). Plan expects Row 4 → ResolvedLine=1 and Row 6 → ResolvedLine=3 — contradictory tie-break semantics for one classifier algorithm.
- **Date:** 2026-05-10
- **Decision:** `Classifier.ClosestTo` uses strict less-than (`dist < bestDist`), so the first candidate wins on tie (lower line number). Row 4's expectation matches; Row 6's expected `ResolvedLineNumber` adjusted from 3 to 1.
- **Why:** Spec/03 § 5 says only "closest line number wins" without specifying tie-break. The plan author's Row 4 comment (`// line 1 closer to original (2) than line 3`) suggests they intended lower-line-wins (line 1 isn't actually closer than line 3 to 2 — they're tied — but the comment's preference is for line 1). Applying the same rule to Row 6 yields ResolvedLine=1.
- **Trade-off considered and rejected:** (a) Pick higher-line-wins (`<=`) — would break Row 4's expectation. (b) Different tie-breaks per matcher tier (exact: lower wins, whitespace-equiv: higher wins) — undocumented in spec, hard to defend, ad hoc. (c) Re-craft Row 6 content to break the tie (e.g., shift `originalLine` to 4) — preserves the plan's literal expected value but obscures the matrix-row intent.
- **Tested by:** Row 6 now passes with ResolvedLineNumber=1 alongside Row 4's ResolvedLineNumber=1.

## [Decision] Task 5 + Task 6 scope-pull-forward — minimum compile fix lives in PR1's early commits

- **Source:** PR1 implementation — Task 2 of the plan adds five required parameters to `ReviewSessionState`; six pre-existing call sites construct `ReviewSessionState` directly and stop compiling: four in tests (Task 6 scope: `AppStateStoreUpdateAsyncTests`, `AppStateStoreMigrationTests` ×2, `InboxRefreshOrchestratorTests`), one in production (Task 5 scope: `PRism.Web/Endpoints/PrDetailEndpoints.cs` ×2 occurrences via `replace_all`), and one in tests (Task 5 scope: `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`).
- **Date:** 2026-05-10
- **Decision:** The minimum compile fix for all six sites lands in PR1's early commits (Task 2's commit covers the four PRism.Core.Tests sites; Task 2.5's commit — the Contracts rename — covers `PrDetailEndpoints.cs` and `PrDetailEndpointsTests.cs`). Each pulled-forward site passes empty `List<DraftComment>()`/`List<DraftReply>()` and `DraftVerdictStatus.Draft` defaults. Task 5's broader work (consume `state.Reviews.Sessions`, slash-key normalization at endpoint sites) and Task 6's fixture cleanup (helper extraction, consolidation) still apply in their own commits.
- **Why:** Each commit must leave the build green. Holding consumer fixes for Tasks 5/6 (per the plan's literal commit boundary) would require committing a non-compiling tree at Task 2 and Task 2.5.
- **Trade-off considered and rejected:** Committing a non-compiling tree at intermediate task boundaries and verifying green only after Task 6. Rejected — never commit code that doesn't build.

---

## How this doc evolves

When a spec or plan revision causes a previously-Applied item to be reversed, undeferred, or otherwise reclassified, append a `## [Superseded]` entry below citing the cause and update `last-updated` in frontmatter. New deferrals go under `## [Defer]`; new skips under `## [Skip]`; new design decisions worth preserving go under `## [Decision]`.

When an item is implemented (Defer → Done) or proven obsolete (Skip → N/A), strike the heading through and add a closing rationale. Don't delete entries — the temporal record is the value.
