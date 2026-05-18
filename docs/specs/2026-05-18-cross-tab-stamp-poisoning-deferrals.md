---
date: 2026-05-18
topic: cross-tab-stamp-poisoning
kind: deferrals-sidecar
---

# Cross-tab stamp poisoning fix — deferrals

Companion to [`2026-05-18-cross-tab-stamp-poisoning-design.md`](2026-05-18-cross-tab-stamp-poisoning-design.md). Pre-implementation decisions / deferrals captured at brainstorm time; implementation-time decisions get appended below as a new section.

---

## Pre-implementation deferrals (brainstorm, 2026-05-18)

### [Decision] Both `LastViewedHeadSha` AND `LastSeenCommentId` move into the per-tab `TabStamp` record

- **Source:** Q1 of the brainstorm session.
- **Affects:** `PRism.Core/State/AppState.cs` (ReviewSessionState shape); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (mark-viewed write); `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (rule (f) read).
- **Decision:** Both fields go per-tab. Asymmetric partitioning (per-tab head sha, session-flat seen-comment-id) leaves a residual poisoning surface in the unread-comment count math used by `BannerRefresh`, at no storage saving worth the irregular shape. The two fields are already stamped atomically by a single `POST /mark-viewed`; the per-tab move keeps that atomicity.
- **Revisit when:** A v2 use case wants a session-level "max comment-id ever seen across any tab" (e.g., for an inbox-side unread badge that should never regress when a different tab views older comments). At that point either add a separate session-flat aggregate alongside per-tab, or pick which semantic the inbox actually wants and project from `TabStamps`.

### [Decision] Pre-V6 stamps dropped at V5→V6 migration, not synthesized under a sentinel key

- **Source:** Q3 of the brainstorm session.
- **Affects:** `PRism.Core/State/Migrations/AppStateMigrations.cs` (MigrateV5ToV6).
- **Decision:** Pre-V6 `last-viewed-head-sha` / `last-seen-comment-id` values can't be attributed to any specific tab. Synthesizing under a sentinel like `"__legacy"` would either match every tab's submit (re-introducing the bypass) or match no tab's submit (functionally equivalent to drop, plus extra storage + a confusing key name). Drop is the honest move. Cost: one extra `POST /mark-viewed` round-trip on the next PR-detail load before submit unblocks; that round-trip already fires unconditionally from `usePrDetail.ts:66-79`, so the user-visible cost is zero.
- **Revisit when:** N/A — landed.

### [Decision] LRU bookkeeping uses explicit `DateTime StampedAtUtc` per entry, not FIFO insertion order

- **Source:** Q4 of the brainstorm session.
- **Affects:** `PRism.Core/State/AppState.cs` (TabStamp record); `PRism.Web/Endpoints/PrDetailEndpoints.cs` (eviction logic).
- **Decision:** `StampedAtUtc` makes "LRU" match the deferral entry's framing literally. FIFO insertion order would silently penalize a long-running tab that rarely re-stamps — its entry sinks because *other* tabs touched the map more recently, even though the long-running tab is still actively viewing. ~8-byte cost per entry; trivial.
- **Revisit when:** A monotonic counter becomes preferable for testability (current clock-based ordering is hard to make deterministic in tests without time injection). The `SuccessClearsSessionTests` style of fake-clock pattern would slot in cleanly.

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
- **Affects:** `PRism.Web/Endpoints/PrDetailEndpoints.cs` (the literal `8`).
- **Decision:** N=8 is the deferral entry's pre-committed value. Eight tabs on a single PR covers any plausible "comparing two views side by side" workflow with headroom. Larger N raises the per-session storage cost linearly; smaller N risks legitimate evictions.
- **Revisit when:** Real usage telemetry (or a user report) surfaces 9+ tab workflows.

### [Defer] Granular log distinction at submit-gate fail-closed branches

- **Source:** Brainstorm § 5.2 (submit-gate read site).
- **Affects:** `PRism.Web/Endpoints/PrSubmitEndpoints.cs` (`s_headShaNotStamped` LoggerMessage).
- **Decision:** Both "header missing/invalid" and "no entry for this tab in the map" emit the existing `s_headShaNotStamped` event. The two cases are observationally identical from the user's POV (Reload the PR and try again), and the existing log message already points operators at the FE wire-up. Distinct event-ids would be useful if a regression class ever divides them (e.g., FE bug that always strips the header vs. FE bug that fires submit before mark-viewed completes).
- **Revisit when:** A diagnostic need surfaces that the single-event log can't disambiguate.

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
