---
date: 2026-05-18
topic: cross-tab-stamp-poisoning
kind: deferrals-sidecar
---

# Cross-tab stamp poisoning fix — deferrals

Companion to [`2026-05-18-cross-tab-stamp-poisoning-design.md`](2026-05-18-cross-tab-stamp-poisoning-design.md). Pre-implementation decisions / deferrals captured at brainstorm time; implementation-time decisions get appended below as a new section.

---

## Pre-implementation deferrals (brainstorm, 2026-05-18)

### [Decision] Only `LastViewedHeadSha` moves into `TabStamp`; `LastSeenCommentId` stays session-flat

- **Source:** Q1 of the brainstorm session — *reversed in light of first-pass ce-doc-review finding F2/A2*.
- **Affects:** `PRism.Core/State/AppState.cs` (ReviewSessionState shape); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (mark-viewed write); `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (rule (f) read); `PRism.Web/Endpoints/PrDraftEndpoints.cs` (markAllRead — no change); `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (inbox projection).
- **Decision:** `LastViewedHeadSha` is the per-tab field that the submit gate must partition; `LastSeenCommentId` is the session-level monotone high-water that the inbox unread badge depends on. The original Q1 framing ("both fields atomically per-tab") would have made the inbox project "most-recent stamp's MaxCommentId across all tabs," which silently regresses the unread badge when a freshly-loaded Tab B re-stamps at a lower `MaxCommentId` than Tab A's previous high-water 999. The asymmetric shape (one per-tab, one session-flat) trades a tiny residual UX overconfidence (Tab A marks-all-read at 999 → Tab B's banner reads "0 new") against a real correctness regression in the inbox badge. The trade is correct: the submit-gate bypass is closed regardless because rule (f) reads `TabStamps[tabId].HeadSha` only. mark-viewed updates `LastSeenCommentId = max(current, body.MaxCommentId)` to preserve monotonicity even when V6's per-tab landscape means a freshly-loaded Tab B at a lower MaxCommentId would otherwise rewind.
- **Revisit when:** A v2 use case wants per-tab "what was the highest comment-id I, this tab, had seen" semantics (e.g., a per-tab banner that resists Tab A's mark-all-read clearing Tab B's "new since I last viewed" indicator). At that point: add a per-tab `MaxCommentId` *alongside* the session-flat field, do not replace it.

### [Decision] Pre-V6 stamps dropped at V5→V6 migration, not synthesized under a sentinel key

- **Source:** Q3 of the brainstorm session.
- **Affects:** `PRism.Core/State/Migrations/AppStateMigrations.cs` (MigrateV5ToV6).
- **Decision:** Pre-V6 `last-viewed-head-sha` / `last-seen-comment-id` values can't be attributed to any specific tab. Synthesizing under a sentinel like `"__legacy"` would either match every tab's submit (re-introducing the bypass) or match no tab's submit (functionally equivalent to drop, plus extra storage + a confusing key name). Drop is the honest move. Cost: one extra `POST /mark-viewed` round-trip on the next PR-detail load before submit unblocks; that round-trip already fires unconditionally from `usePrDetail.ts:66-79`, so the user-visible cost is zero.
- **Revisit when:** N/A — landed.

### [Decision] LRU bookkeeping uses explicit `DateTime StampedAtUtc` per entry — caveat: not actually "active-tab-survives"

- **Source:** Q4 of the brainstorm session; rationale clarified after first-pass ce-doc-review finding A4.
- **Affects:** `PRism.Core/State/AppState.cs` (TabStamp record); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (eviction); `PRism.Web/Endpoints/PrReloadEndpoints.cs` (eviction on reload-write).
- **Decision:** `StampedAtUtc` provides a deterministic eviction order — `MinBy` picks a single entry on each cap-exceeding insert. The original framing ("long-running tab survives churn") was *wrong*: a long-running tab that rarely re-stamps has an older `StampedAtUtc` than churning tabs, so it sinks first under cap pressure, just as it would under FIFO. The corrected framing: the cap exists to bound storage of dead entries from closed browser tabs (per-launch `getTabId()` means each new launch creates a new uuid; old tab's entry lives until LRU eviction). The server cannot observe whether a tab is still alive — no signal beats no signal here, so "deterministic + simple" wins over an attempted heuristic.
- **Revisit when:** Either (a) a monotonic counter becomes preferable for testability (current clock-based ordering is hard to make deterministic in tests without time injection), or (b) v2 introduces a tab-close beacon that lets the server know which entries are genuinely dead, at which point eviction-by-stamped-at gets replaced by "evict-known-dead-first."

### [Decision] Server clock used for `StampedAtUtc`, not client-provided timestamp

- **Source:** Brainstorm session walkthrough § 3.
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs:107-118` (UpdateAsync transform).
- **Decision:** `DateTime.UtcNow` inside the transform. Single-machine PoC, single trust boundary. A client-provided timestamp would let a malicious caller pin eviction order arbitrarily; even in a single-user PoC, the principle "the BE owns the truth for security-relevant fields" applies. The only consumer of `StampedAtUtc` is "evict the oldest within a single session," not any user-visible ordering, so server clock is sufficient.
- **Revisit when:** PRism gains a multi-machine deployment (out of PoC scope by spec § 2 of `02-architecture.md`).

### [Decision] Tab-id allowlist `^[a-zA-Z0-9_-]{1,64}$` applied at both endpoint sites

- **Source:** Q5 of the brainstorm session; reuses [S6 PR0 § 7 binding constraint #2](2026-05-10-multi-account-scaffold-design.md#binding-constraints-v1-places-on-v2).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (mark-viewed); `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (submit).
- **Decision:** Header value validated before use as a JSON map key, dictionary lookup key, or log field. Same threat shape as `accountKey`: CRLF injection in logs, escape-character injection in JSON, path injection if v2 ever shards. Inline regex via `[GeneratedRegex]` at each call site. If a third call site appears, factor to `PRism.Core/State/TabIds.cs` with a single `IsValid(string)` method.
- **Revisit when:** A third call site appears. v1 has two (mark-viewed + submit), so the shared helper is premature.

### [Decision] `MarkViewedRequest` and `SubmitRequestDto` bodies unchanged

- **Source:** Brainstorm closeout question 1.
- **Affects:** `PRism.Web/Endpoints/PrDetailDtos.cs`, `PRism.Web/Endpoints/PrSubmitDtos.cs`.
- **Decision:** Tab id stays header-only. Same precedent as `PrDraftEndpoints` and `PrReloadEndpoints` already in the codebase. Duplicating into the body would invite header / body drift on the same identity.
- **Revisit when:** N/A — landed.

### [Decision] All-or-nothing migration quarantine for V5→V6 partial-rollback

- **Source:** Brainstorm closeout question 2.
- **Affects:** `PRism.Core/State/Migrations/AppStateMigrations.cs` (MigrateV5ToV6 throws JsonException on any session that has both legacy keys AND tab-stamps).
- **Decision:** One inconsistent session quarantines the whole file. Same all-or-nothing policy as V4→V5 (which throws when both root-level and accounts-level keys coexist). Per-session partial recovery is deliberately not attempted — the recovery path is identical to the quarantine path (re-stamp on next PR-detail load), so adding per-session branching is complexity without recovery benefit.
- **Revisit when:** A migration step appears whose recovery path is materially different from the quarantine path (e.g., partial loss of irreplaceable user content). Then per-step recovery becomes worth designing.

### [Defer] Tab-aware inbox surface

- **Source:** Brainstorm § 6 (inbox wire projection discussion).
- **Affects:** `PRism.Core.Contracts/PrInboxItem.cs`; `frontend/src/components/Inbox/InboxRow.tsx`.
- **Decision:** Inbox keeps the existing wire shape (`LastViewedHeadSha: string?`); BE projects "most-recent stamp across all tabs" from V6 storage. The inbox UI's only consumer is the `pr.lastViewedHeadSha == null` "first visit" badge, which the most-recent projection answers correctly. A "viewed from THIS tab" inbox semantic isn't useful at PoC scope — the user has one inbox per launch, navigates to PRs from there, and the per-tab dimension only matters at the per-PR submit gate.
- **Revisit when:** v2's multi-account runtime surfaces multiple side-by-side inboxes (e.g., one inbox per account in a split view), at which point a per-tab inbox stamp might match real workflows.

### [Defer] LRU cap N=8 tuning

- **Source:** Brainstorm § 2 (storage shape); pre-committed in the original deferral entry's pre-decision sketch.
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (the literal `8`); `PRism.Web/Endpoints/PrReloadEndpoints.cs` (same literal).
- **Decision:** N=8 is the deferral entry's pre-committed value. Eight tabs on a single PR covers any plausible "comparing two views side by side" workflow with headroom. Larger N raises the per-session storage cost linearly; smaller N risks legitimate evictions.
- **Revisit when:** A user reports `head-sha-not-stamped` after closing a tab (the failure mode that fires when a still-active tab's stamp was evicted by churn pressure). The original revisit-when ("telemetry surfaces 9+ tab usage") never triggers in a no-telemetry single-user PoC — user-reported `head-sha-not-stamped`-after-close is the diagnostic signal that actually fires.

### [Decision] Distinct error codes for missing-header (`tab-id-missing`, 422) vs. no-map-entry (`head-sha-not-stamped`, 400)

- **Source:** First-pass ce-doc-review finding A7 — reversed the brainstorm's original "collapse to one log event" position.
- **Affects:** `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (`s_tabIdMissing` LoggerMessage, new `SubmitErrorDto` code); `frontend/src/api/submit.ts` (`KNOWN_SUBMIT_ERROR_CODES`); `frontend/src/components/PrDetail/PrHeader.tsx` (`submitErrorMessage` switch arm).
- **Decision:** Missing/malformed header → 422 `tab-id-missing` ("Internal error: missing tab identifier. Refresh the browser tab and retry."). Valid header, no entry in map → 400 `head-sha-not-stamped` ("Reload the PR and try again."). The user recoveries are different: a missing header is a FE wire-up regression that Reload cannot fix; the user has to refresh the browser tab itself. Collapsing both to one code/message would lie to the user in the wire-up-regression case. Two LoggerMessage delegates (`s_tabIdMissing`, `s_headShaNotStamped`) distinguish the cases at the log level too.
- **Revisit when:** N/A — landed.

### [Acknowledge] Server-clock LRU under backwards clock adjustment

- **Source:** Brainstorm § 2 (storage shape rationale).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (eviction uses `DateTime.UtcNow`).
- **Decision:** A backwards system-clock adjustment can make a "stale" entry's `StampedAtUtc` look newer than a fresh stamp; eviction order is then briefly wrong. Single-machine single-process PoC; the user would have to manually move their system clock backwards by more than a few seconds for this to matter. Acknowledged, not mitigated.
- **Revisit when:** PRism gains a multi-machine deployment or NTP-disciplined-clock-required behavior (out of PoC scope).

### [Acknowledge] Eight-tab cap silently evicts the oldest stamp

- **Source:** Brainstorm § 2 (LRU eviction semantics).
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (cap-eviction branch).
- **Decision:** A user with 9+ tabs open on the same PR sees the oldest-stamped tab silently evicted from the map. The next submit attempt from that evicted tab returns 400 `head-sha-not-stamped` with the standard "Reload the PR" copy — the user re-loads, mark-viewed re-stamps under their tab id, and submit unblocks. The eviction is silent (no SSE event, no toast); the recovery is one Reload. Cost is bounded.
- **Revisit when:** The deferral above ("LRU cap N=8 tuning") fires.

---

## Implementation-time deferrals

*(Empty — to be populated during plan execution.)*
