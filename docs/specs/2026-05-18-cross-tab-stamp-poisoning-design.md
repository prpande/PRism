---
date: 2026-05-18
topic: cross-tab-stamp-poisoning
---

# Cross-tab stamp poisoning fix — design

**Status:** Design — pending human review.
**Branch:** `feat/cross-tab-stamp`.
**Source authority:** [S5 submit-pipeline deferrals § "[Defer] Cross-tab stamp poisoning (F3 from ce-code-review)"](2026-05-11-s5-submit-pipeline-deferrals.md#defer-cross-tab-stamp-poisoning-f3-from-ce-code-review) — the regression class is named there; this slice is the implementation.
**Schema baseline:** V5 (post-S6 PR0). This slice bumps to V6.

---

## Summary

`ReviewSessionState` keys session data on `owner/repo/number` only. Two tabs open on the same PR share a single `LastViewedHeadSha`. Tab A's `POST /mark-viewed` at `headSha=B` silently overwrites Tab B's stamp at `headSha=A`; the submit-gate rule (f) — *"most-recent active-PR poll observed no head-sha drift"* — then evaluates against the *other* tab's stamp. Tab B can submit at `headSha=B` without having reviewed B's diff. The failure is silent, the artifact (a GitHub review) is durable, and the verdict is publicly attributed to the reviewer.

The slice ships a V5→V6 schema migration, promotes `LastViewedHeadSha` (only) into a per-tab `TabStamp` map inside `ReviewSessionState`, wires the BE to read `X-PRism-Tab-Id` on mark-viewed and submit (which currently ignore the header on these two routes; the FE already sends it), threads the tab id into the reload + reconciliation pipeline + test-hook write sites, and pins the two-tab bypass scenario with a `PrSubmitEndpoints` test.

`LastSeenCommentId` stays session-flat as a monotone high-water across all tabs — the inbox unread badge depends on this semantic and per-tab partitioning would regress it (§ 2).

End-to-end behavior change: a user with two tabs open on the same PR cannot submit from a tab whose own diff they haven't viewed at the PR's current head sha. The single-tab path is byte-identical to today.

---

## Problem Frame

The bypass is silent, the artifact is durable, and the attribution is public. A reviewer with two tabs open on the same PR can submit a verdict against a head sha they have not actually inspected; the verdict lands on github.com under their name with no UI signal that the wrong stamp was consulted. The risk shape matches the S5 design's "silently-wrong, not loudly-broken" framing — nothing surfaces at submit time, the GitHub review is non-rollbackable, and a future reviewer reading the verdict has no way to know the author didn't read the diff.

The deferral entry called this "P1, confidence 75" at code-review time; the operational firing rate in single-user dogfooding is unknown. The case rests on the failure shape (silent + durable + publicly attributed), not on the workflow's prevalence. Even a single occurrence is undiscoverable to the user after the fact.

The deferral was carried forward because the fix needs a schema migration, and S6 PR0 (the multi-account storage-shape scaffold) was the natural carrier. PR0 shipped without taking on this work; V6 is the next discrete schema step and a clean home for it.

---

## 1. Goals & non-goals

### 1.1 Goals

1. Make the submit gate evaluate each tab's stamp independently. A stamp landed by Tab A never unblocks a submit from Tab B.
2. Preserve the single-tab user experience byte-identically — no extra prompts, no extra round-trips, no behavior change in the dominant case.
3. Migrate V5 → V6 cleanly, with idempotency and partial-rollback discrimination matching V4→V5's policy ([§ 4.1](#41-state-statejson-v5--v6)).
4. Cap per-session tab-id storage at N=8 with eviction-by-oldest-stamp so a long-running install doesn't accumulate unbounded dead entries from closed tabs ([§ 5.2 LRU note](#52-mark-viewed-write-site)).
5. Pin the two-tab bypass regression in `PrSubmitEndpoints` tests so future refactors can't silently regress it.

### 1.2 Non-goals

- **Tab-aware inbox** — the inbox lists PRs across all subscriptions; "have I viewed this from THIS tab" is not a useful per-row semantic, and the existing `pr.lastViewedHeadSha == null` "first visit" badge serves a different purpose (have I *ever* opened this PR). The wire projection ([§ 6](#6-inbox-wire-projection)) preserves the existing semantic.
- **Tab-aware SSE filtering** — already exists ([`SourceTabId` on `StateChanged` / `DraftSaved` / `DraftDiscarded`](../../PRism.Core/Events/)). This slice doesn't touch it.
- **Tab-id durability across browser launches** — `getTabId()` is in-memory only ([`frontend/src/api/draft.ts:9-12`](../../frontend/src/api/draft.ts)). After a launch, every tab is a new tab; their first PR-detail load fires `mark-viewed` and re-stamps. This is the right semantic — a fresh launch has no continuity with prior viewing context.
- **Removing the FE wire-up gate test** — the existing `head-sha-not-stamped` 400 (the symptom that PR #55 fixed) is preserved for the valid-tab-id-but-no-map-entry case. A new `tab-id-missing` 422 splits off the malformed/missing-header case ([§ 5.3](#53-submit-gate-read-site)).
- **Per-tab `LastSeenCommentId`** — kept session-flat as a monotone high-water. See § 2 for the rationale.

### 1.3 Alternatives considered

The deferral entry sketched three fix options. This slice picks (i) and rejects (ii) and (iii) below.

**(i) Per-tab `LastViewedHeadSha` map (chosen).** Each tab stamps its own slot; submit gate looks up the caller's slot only. Cost: V5→V6 schema migration + reconciliation/reload/test-hook semantics + LRU policy. Benefit: preserves every existing user workflow — two tabs at different head shas, side-by-side commit comparison, Slack-ping-reopens-in-second-window. The "what to view" model is unchanged; only the "what your tab personally stamped" dimension is added.

**(ii) Per-tab session keys** — rejected. Would multiply the session count by tab count (one `accounts.{key}.reviews.sessions.{owner/repo/n}/{tabId}` entry per tab); drafts would need to be per-tab too (loss of cross-tab draft sharing, which the existing `StateChanged` SSE event explicitly broadcasts to all subscribed tabs), and the LRU problem fans out across every session-keyed surface. A heavier reshape with worse cross-tab UX.

**(iii) Lock-on-first-view ("stamp on first PR-detail GET, then locked")** — rejected. The first tab to mark-viewed locks the session's head sha; subsequent tabs see a "this PR is being reviewed in another tab" state until the owner releases / TTL expires. Cheaper to implement (no schema change) and closes the bypass class, but breaks the legitimate side-by-side workflow this design preserves: a user comparing PR #100 at sha-A in Tab A vs the just-pushed sha-B in Tab B would be locked out of Tab B until they explicitly release Tab A. The PRism diff viewer's range parameter (`/diff?range=A..B`) was built for this workflow; foreclosing it at the session level to fix a silent gate is the wrong trade. Also: "lock release" is a new affordance the spec would have to invent (close-tab? TTL? explicit release button?), and each shape carries its own footguns.

---

## 2. Storage shape

Inside [`PRism.Core/State/AppState.cs`](../../PRism.Core/State/AppState.cs), `ReviewSessionState` reshapes:

```csharp
public sealed record ReviewSessionState(
    IReadOnlyDictionary<string, TabStamp> TabStamps,   // new; replaces LastViewedHeadSha
    string? LastSeenCommentId,                         // kept session-flat — monotone high-water
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    string? DraftSummaryMarkdown,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);

public sealed record TabStamp(
    string HeadSha,
    DateTime StampedAtUtc);
```

**Why only `LastViewedHeadSha` goes per-tab, not also `LastSeenCommentId`.** `LastSeenCommentId` is the inbox unread-badge's session-level high-water — every writer increases it monotonically. Today's writers are mark-viewed ([`PrDetailEndpoints.cs:115`](../../PRism.Web/Endpoints/PrDetailEndpoints.cs), stamps `body.MaxCommentId`) and markAllRead ([`PrDraftEndpoints.cs:355-373`](../../PRism.Web/Endpoints/PrDraftEndpoints.cs), stamps an explicit id). If `LastSeenCommentId` moved into `TabStamp` and the inbox projected "most-recent stamp's MaxCommentId" across tabs, Tab B re-stamping at sha-B with `MaxCommentId=50` (its own load-time max) would silently regress the inbox badge from Tab A's prior `999`. The first-pass ce-doc-review's adversarial agent flagged this; the right semantic is "session-flat monotone high-water." Both writers continue to write `LastSeenCommentId` directly; mark-viewed gains a `max(current, body.MaxCommentId)` guard to preserve monotonicity ([§ 5.2](#52-mark-viewed-write-site)).

The cross-tab "Tab A marked an old comment-id as seen, Tab B's banner now says 0 new" concern is mild compared to the inbox regression. The submit-gate bypass class is closed regardless because the submit gate reads `TabStamps[tabId].HeadSha` only — `LastSeenCommentId` is not on the rule (f) path.

**Why `DateTime StampedAtUtc`.** Provides a deterministic eviction order for bounding the map's size; `MinBy` picks a single entry on each cap-exceeding insert. The mechanism does *not* favor long-running tabs over short-lived ones — a long-running tab that rarely re-stamps has an older `StampedAtUtc` than churning tabs, so it sinks first under cap pressure. That's accepted: the cap exists to bound storage of dead entries from closed tabs, not to provide an "active tab survives" guarantee. The server cannot observe whether a tab is still alive ([§ 9.1 Eight-tab cap](#91-risks)). Clock skew under a backwards system-clock adjustment is acknowledged in the deferrals sidecar.

**Why nest inside `ReviewSessionState`, not at a higher level.** Sessions already live at `accounts.{key}.reviews.sessions.{owner/repo/n}` post-S6 PR0. A tab map at the account or top level would force a join key from `(account, prRef, tab)` back down to a session, recreating data the per-session map already encodes. The FE's `getTabId()` is cross-account by construction (one per browser launch) and that's correct — the same tab id will appear independently in each `(account, prRef)` session's tab map it touches, with no FE-side bookkeeping required.

**Non-null contract.** `TabStamps` is non-null by construction. `EnsureCurrentShape` ([`AppStateStore.cs:243-284`](../../PRism.Core/State/AppStateStore.cs)) backfills `tab-stamps: {}` on every load that reaches the deserializer, so deserialization always yields a `Dictionary<string, TabStamp>` (possibly empty), never `null`. Test factories MUST construct sessions with an empty dict for the `TabStamps` field; the positional constructor cannot accept null. Code-side reads can call `session.TabStamps.TryGetValue(...)` without null guards.

**JSON shape** (under `accounts.{key}.reviews.sessions.{owner/repo/n}`):

```jsonc
{
  "tab-stamps": {
    "0c1f4e8a-3b9d-4c2f-9e1a-2b3c4d5e6f70": {
      "head-sha": "abc123...",
      "stamped-at-utc": "2026-05-18T14:23:45.6789012Z"
    }
  },
  "last-seen-comment-id": "987654321",
  "pending-review-id": null,
  // ... rest unchanged
}
```

---

## 3. Tab-id validation

Header value must match `^[a-zA-Z0-9_-]{1,64}$` before being used as a JSON map key, a log field, or a dictionary lookup key.

Same allowlist as the [S6 PR0 § 7 binding constraint #2](2026-05-10-multi-account-scaffold-design.md#7-v2-user-facing-model--constraints-v1-places--advisory-observations) for `accountKey`, applied verbatim because the threat surface is identical: header value lands in JSON map keys (state.json), and may land in log lines if the implementation chooses to log it for diagnostics.

**Log-field discipline.** This slice does NOT add tab id to any log line. If a future change adds tab id to a structured log parameter (the natural next step when "granular log distinction" is un-deferred, [§ 9.2](#92-deferred)), the log line MUST use the *post-validation local variable*, never the raw `httpContext.Request.Headers["X-PRism-Tab-Id"]`. The allowlist pre-mitigates the log-injection vector only under that discipline; without it, the mitigation is decoupled from the logging path.

Implementation: inline `[GeneratedRegex]` at each call site for v1. If a third site appears beyond mark-viewed / submit / reload / test-hook (the four BE sites enumerated in § 5), factor to `PRism.Core/State/TabIds.cs` with a single `IsValid(string)` method.

`crypto.randomUUID()` produces canonical UUIDs (32 hex + 4 dashes, 36 chars total) which fit the allowlist cleanly. Non-FE callers (direct curl during local debugging, the Playwright test harness if it ever calls submit without the React client) must send a header that matches the allowlist or the call fails-closed.

---

## 4. Schema migration V5 → V6

### 4.1 State (`state.json`) V5 → V6

```csharp
public static JsonObject MigrateV5ToV6(JsonObject root)
{
    // Idempotency vs partial-rollback discrimination (mirrors MigrateV4ToV5's policy):
    //
    //   - V6 file passed in by mistake (every session already has `tab-stamps`, no legacy
    //     `last-viewed-head-sha` keys anywhere): just bump version. Idempotent.
    //
    //   - Partial-rollback / hand-edit (a session has BOTH a legacy `last-viewed-head-sha`
    //     key AND a pre-existing `tab-stamps` key): refuse to silently pick one set.
    //     Surface as JsonException so LoadCoreAsync's catch (JsonException) quarantines
    //     the whole file. Same all-or-nothing policy as V4→V5: one inconsistent session
    //     quarantines the file; the user lands at AppState.Default + re-Setup.
    //
    //   - `last-seen-comment-id` stays at the session level (not moved under tab-stamps),
    //     so it is NOT touched by this migration. Existing values pass through unchanged.
    if (root["accounts"] is not JsonObject accounts)
    {
        // V5 files always have `accounts` (V4→V5 ensures it). Missing means corrupt / hand-edited;
        // version-bump and let the deserializer or EnsureCurrentShape handle the downstream.
        root["version"] = 6;
        return root;
    }

    foreach (var (_, accountNode) in accounts)
    {
        var sessions = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
        if (sessions is null) continue;

        foreach (var (_, sessionNode) in sessions)
        {
            if (sessionNode is not JsonObject session) continue;

            var hasLegacy = session["last-viewed-head-sha"] is not null;
            var hasNew = session["tab-stamps"] is JsonObject;

            if (hasLegacy && hasNew)
                throw new System.Text.Json.JsonException(
                    "state.json session has both legacy last-viewed-head-sha AND a tab-stamps " +
                    "key. This indicates a partial rollback from a future version or a hand-edit " +
                    "gone wrong. Quarantining and re-Setup is safer than guessing which set wins.");

            // Drop pre-V6 LastViewedHeadSha. Cannot be attributed to any specific tab;
            // synthesizing under a sentinel key would either re-introduce the bypass or
            // be equivalent to drop. Cost: one mark-viewed round-trip on the next PR-detail
            // load before submit unblocks — that round-trip already fires unconditionally
            // from usePrDetail.ts:66-79.
            session.Remove("last-viewed-head-sha");
            if (!hasNew) session["tab-stamps"] = new JsonObject();

            // LastSeenCommentId is intentionally NOT removed — it stays session-flat (see § 2).
        }
    }

    root["version"] = 6;
    return root;
}
```

### 4.2 `AppStateStore` wiring

[`AppStateStore.cs`](../../PRism.Core/State/AppStateStore.cs):

- `CurrentVersion` bumps `5 → 6`.
- `MigrationSteps` gains `(6, AppStateMigrations.MigrateV5ToV6)` in the array initializer. The `.OrderBy(s => s.ToVersion)` already pins ascending order at type-init time.
- `EnsureCurrentShape` extends to backfill `session["tab-stamps"] = new JsonObject()` for sessions missing the key. Defends against a future-version (V7+) file dropping sessions through the deserializer with `TabStamps == null`, which would NRE on the first `session.TabStamps.TryGetValue(...)` in the submit endpoint.

```csharp
// Inside EnsureCurrentShape, after the existing reviews.sessions backfill:
if (defaultObj["reviews"] is JsonObject reviewsObj &&
    reviewsObj["sessions"] is JsonObject sessionsObj)
{
    foreach (var (_, sessionNode) in sessionsObj)
    {
        if (sessionNode is JsonObject session && session["tab-stamps"] is null)
            session["tab-stamps"] = new JsonObject();
    }
}
```

### 4.3 Migration policy: all-or-nothing quarantine

If 47 of 48 sessions are clean and one session has both `last-viewed-head-sha` AND `tab-stamps`, the whole load throws `JsonException` and quarantines via `LoadCoreAsync`'s catch ([`AppStateStore.cs:131-141`](../../PRism.Core/State/AppStateStore.cs)). User lands at `AppState.Default + re-Setup`. Same policy as V4→V5; per-session recovery is deliberately not attempted because the recovery path is identical to the quarantine path — re-stamp on next PR-detail load.

---

## 5. Endpoint and pipeline changes

V6's per-tab partitioning touches more surface than the deferral entry sketched. Audited via `grep -r "LastViewedHeadSha"` across the codebase — the live read/write sites are:

| Site | Role | V6 change |
|---|---|---|
| [`PrDetailEndpoints.cs:89-131`](../../PRism.Web/Endpoints/PrDetailEndpoints.cs) | mark-viewed (write) | § 5.2 — write `TabStamps[tabId]` + monotone `LastSeenCommentId` |
| [`PrSubmitEndpoints.cs:113-144`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) | submit rule (f) (read) | § 5.3 — read `TabStamps[tabId].HeadSha` |
| [`PrReloadEndpoints.cs:161`](../../PRism.Web/Endpoints/PrReloadEndpoints.cs) | reload (write) | § 5.4 — write `TabStamps[tabId]` |
| [`DraftReconciliationPipeline.cs:33`](../../PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs) | reconcile `headShifted` (read) | § 5.5 — read caller's tab stamp via new param |
| [`PrDraftEndpoints.cs:355-373`](../../PRism.Web/Endpoints/PrDraftEndpoints.cs) | markAllRead patch (write) | § 5.6 — no-op (stays session-flat under `LastSeenCommentId`) |
| [`TestEndpoints.cs:149-176`](../../PRism.Web/TestHooks/TestEndpoints.cs) | `/test/mark-pr-viewed` (write) | § 5.7 — accept `tabId` field |
| [`InboxRefreshOrchestrator.cs:244-247`](../../PRism.Core/Inbox/InboxRefreshOrchestrator.cs) | inbox projection (read) | § 6 — most-recent stamp's `HeadSha`; `LastSeenCommentId` unchanged |

### 5.1 `PrSubmitEndpoints` class-shape prerequisite

`[GeneratedRegex]` requires `partial`. [`PrSubmitEndpoints.cs:23`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) is currently `internal static class`; add the `partial` keyword. `PrDetailEndpoints` and `PrReloadEndpoints` need the same edit (the latter currently uses `static readonly Regex` for its sha-format regexes; either pattern works, but the new tab-id regex should land as `[GeneratedRegex]` for consistency with PrDraft's existing source-generated pattern).

### 5.2 Mark-viewed write site

[`PrDetailEndpoints.cs:89-131`](../../PRism.Web/Endpoints/PrDetailEndpoints.cs) reshapes:

```csharp
app.MapPost("/api/pr/{owner}/{repo}/{number:int}/mark-viewed",
    async (string owner, string repo, int number,
           MarkViewedRequest body,
           HttpContext httpContext,                                              // new
           PrDetailLoader loader, IAppStateStore stateStore, CancellationToken ct) =>
    {
        if (stateStore.IsReadOnlyMode)
            return Results.Problem(type: "/state/read-only", statusCode: 423);

        // Read the caller's tab id; required for per-tab stamp partitioning (spec § 2).
        var tabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();
        if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
            return Results.Problem(type: "/viewed/tab-id-missing", statusCode: 422);

        var prRef = new PrReference(owner, repo, number);
        var snapshot = loader.TryGetCachedSnapshot(prRef);
        if (snapshot is null)
            return Results.Problem(type: "/viewed/snapshot-evicted", statusCode: 422);
        if (!string.Equals(snapshot.Detail.Pr.HeadSha, body.HeadSha, StringComparison.Ordinal))
            return Results.Problem(type: "/viewed/stale-head-sha", statusCode: 409);

        var key = $"{owner}/{repo}/{number}";
        try
        {
            await stateStore.UpdateAsync(state =>
            {
                var session = state.Reviews.Sessions.GetValueOrDefault(key) ?? NewEmptySession();

                // Per-tab head sha (replaces LastViewedHeadSha assignment).
                var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
                tabStamps[tabId] = new TabStamp(body.HeadSha, DateTime.UtcNow);
                if (tabStamps.Count > 8)
                {
                    // Cap by evicting the entry with the oldest StampedAtUtc. The freshly-inserted
                    // entry is the newest by construction (DateTime.UtcNow > any prior entry).
                    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
                    tabStamps.Remove(oldest);
                }

                // Session-flat LastSeenCommentId — monotone high-water across all tabs.
                // Today's behavior was last-writer-wins; the max() guard preserves monotonicity
                // when V6's per-tab landscape means a freshly-loaded Tab B at a lower MaxCommentId
                // would otherwise rewind the badge under Tab A's previous higher mark.
                var newSeen = MonotonicMaxCommentId(session.LastSeenCommentId, body.MaxCommentId);

                var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = session with { TabStamps = tabStamps, LastSeenCommentId = newSeen };
                return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
            }, ct).ConfigureAwait(false);
        }
        catch (InvalidOperationException ex) when (ex.Message.Contains("read-only mode", StringComparison.Ordinal))
        {
            return Results.Problem(type: "/state/read-only", statusCode: 423);
        }

        return Results.NoContent();
    }).WithMetadata(new RequestSizeLimitAttribute(16384));

[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();

// Numeric monotone-max. Inputs are stringified longs (GitHub comment IDs).
// Semantics: returns the larger of the two numeric values, treating unparseable
// strings as "no signal" (current preserved when incoming is junk; incoming
// accepted when current is junk, since any parseable value beats no value).
// This preserves the inbox unread-badge's monotone high-water invariant when V6's
// per-tab landscape would otherwise let a freshly-loaded Tab B with a lower
// MaxCommentId rewind the high-water set by Tab A's prior higher mark-viewed.
private static string? MonotonicMaxCommentId(string? current, string? incoming)
{
    if (!long.TryParse(incoming, out var inc)) return current;
    if (!long.TryParse(current, out var cur)) return incoming;
    return inc > cur ? incoming : current;
}
```

`NewEmptySession()` is shared with `PrReloadEndpoints` and `PrDraftEndpoints` — see § 8.2 for the test-factory rewrite scope.

**Why 422 for missing/invalid tab id, not 400.** Consistent with the existing `MarkViewedRequest` validation surface — `/viewed/snapshot-evicted` and `/viewed/stale-head-sha` are 422 / 409 for input-shape problems; tab-id-missing is the same class. 400 is reserved for the submit endpoint's rule-(f) family.

**`/api/pr/{owner}/{repo}/{number:int}/files/viewed` is behaviorally unchanged** — it already stamps under a `(prRef, path, headSha)` triple and the cross-tab poisoning class doesn't extend to per-file viewed state (the file-viewed check isn't part of rule (f); it's a per-file UX affordance). **But its empty-session constructor at [`PrDetailEndpoints.cs:169`](../../PRism.Web/Endpoints/PrDetailEndpoints.cs) uses positional `new ReviewSessionState(null, null, …)` syntax and must be edited mechanically when `LastViewedHeadSha` is removed from the record's positional shape.** Counts as one of the test-factory-rewrite sites enumerated in § 8.4; surfacing here so the implementer doesn't treat `files/viewed` as untouchable.

### 5.3 Submit-gate read site

[`PrSubmitEndpoints.cs:113-144`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) rule (f) reshapes — and the two fail-closed branches now use **distinct error codes** so the FE can route them differently:

```csharp
private static async Task<IResult> SubmitAsync(
    string owner, string repo, int number,
    SubmitRequestDto? request,
    HttpContext httpContext,                                  // new
    IAppStateStore stateStore,
    IActivePrCache activePrCache,
    IReviewSubmitter submitter,
    IPrReader prReader,
    IReviewEventBus bus,
    SubmitLockRegistry lockRegistry,
    IHostApplicationLifetime appLifetime,
    ILoggerFactory loggerFactory,
    CancellationToken ct)
{
    // ... existing rule (a)-(e) checks unchanged ...

    // Authorization: `IsSubscribed(prRef)` already gates this endpoint at the top
    // (`PrSubmitEndpoints.cs:85-86`), so the rule (f) error-code differential is NOT
    // reachable by an unauthenticated probe. The 422/400 split only widens the diagnostic
    // surface for callers that have already passed the subscription gate.
    //
    // Rule (f) — per-tab. The tab-id validation branch (422 / `tab-id-missing`) is split
    // from the no-map-entry branch (400 / `head-sha-not-stamped`) because the recoveries
    // differ: a missing/malformed header is a FE wire-up regression (Reload doesn't fix
    // it; the user can't recover via UX) while a missing map entry is the standard
    // "Reload the PR" path.
    var tabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();
    if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
    {
        s_tabIdMissing(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
        return Results.Json(new SubmitErrorDto("tab-id-missing",
            "Internal error: missing tab identifier. Refresh the browser tab and retry."),
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }

    if (!session.TabStamps.TryGetValue(tabId, out var stamp))
    {
        s_headShaNotStamped(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
        return Results.Json(new SubmitErrorDto("head-sha-not-stamped",
            "PR detail has not been marked viewed yet. Reload the PR and try again."),
            statusCode: StatusCodes.Status400BadRequest);
    }

    var pollSnapshot = activePrCache.GetCurrent(prRef);
    if (pollSnapshot is not null && !string.Equals(pollSnapshot.HeadSha, stamp.HeadSha, StringComparison.Ordinal))
    {
        s_headShaDrift(loggerFactory.CreateLogger(LoggerCategory), sessionKey, stamp.HeadSha, pollSnapshot.HeadSha, null);
        return Results.Json(new SubmitErrorDto("head-sha-drift",
            "Reload the PR before submitting."),
            statusCode: StatusCodes.Status400BadRequest);
    }

    // ... lock acquisition unchanged ...

    var headSha = stamp.HeadSha;   // was: session.LastViewedHeadSha
    // ... rest unchanged ...
}

// New LoggerMessage delegate paralleling s_headShaNotStamped, distinguishing the
// FE-wire-up-regression case from the legitimate-no-entry case.
private static readonly Action<ILogger, string, Exception?> s_tabIdMissing =
    LoggerMessage.Define<string>(LogLevel.Warning, new EventId(4, "SubmitRejectedTabIdMissing"),
        "POST /submit rejected for {SessionKey}: X-PRism-Tab-Id header is missing or fails allowlist. " +
        "The frontend must always send this header; see frontend/src/api/draft.ts:TAB_ID_HEADER.");

// REWRITE the existing s_headShaNotStamped message string. The current text names
// `session.LastViewedHeadSha` — the field no longer exists post-V6. Updated text:
//   "POST /submit rejected for {SessionKey}: session.TabStamps has no entry for the
//    caller's tab. The frontend must call POST /api/pr/{ref}/mark-viewed when PR detail
//    loads; see PrDetailEndpoints.MarkViewed."

[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

**Frontend wire impact.** `KNOWN_SUBMIT_ERROR_CODES` in [`frontend/src/api/submit.ts`](../../frontend/src/api/submit.ts) gains `'tab-id-missing'`. `PrHeader.submitErrorMessage`'s exhaustive switch ([`PrHeader.tsx:159-204`](../../frontend/src/components/PrDetail/PrHeader.tsx)) gets a new arm that surfaces "Internal error: missing tab identifier. Refresh the browser tab." The toast `kind` is `error`. Auto-retry is NOT wired — refresh-tab is the user-side recovery.

**Pipeline `getCurrentHeadShaAsync` callback unchanged.** [`PrSubmitEndpoints.cs:150-154`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) calls `prReader.PollActivePrAsync` directly; it doesn't read the stamp. The pre-Finalize re-poll for stale-`commitOID` continues to work as before.

### 5.4 Reload write site

[`PrReloadEndpoints.cs:156-162`](../../PRism.Web/Endpoints/PrReloadEndpoints.cs) currently writes `LastViewedHeadSha = request.HeadSha` inside the apply-phase `with { ... }`. The endpoint already reads `X-PRism-Tab-Id` at line 63 (as `sourceTabId`, used for SSE filtering). V6 routes the same value into the stamp:

```csharp
// Tab-id validation. Reload is a writer endpoint; same allowlist as mark-viewed / submit.
if (string.IsNullOrEmpty(sourceTabId) || !TabIdAllowlistRegex().IsMatch(sourceTabId))
    return Results.UnprocessableEntity(new { error = "tab-id-missing" });

// ... existing Phase 1 reconcile (now passes sourceTabId — see § 5.5) ...

// Phase 2 apply — replace LastViewedHeadSha assignment with per-tab stamp:
var tabStamps = current.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
tabStamps[sourceTabId] = new TabStamp(request.HeadSha, DateTime.UtcNow);
if (tabStamps.Count > 8)
{
    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
    tabStamps.Remove(oldest);
}
var updated = current with
{
    DraftComments = updatedDrafts,
    DraftReplies = updatedReplies,
    DraftVerdictStatus = newVerdictStatus,
    TabStamps = tabStamps,                          // was: LastViewedHeadSha = request.HeadSha
};
```

The `partial` keyword + `[GeneratedRegex]` apply here too. The existing `Sha40` / `Sha64` static-readonly `Regex` instances stay — only the new tab-id regex uses source-generation.

**Why stamp on reload, not just on mark-viewed.** Today's behavior writes `LastViewedHeadSha = request.HeadSha` on every successful reload, on the model that "the user clicked Reload, they've now seen this head sha." Preserving that semantic in the per-tab world means stamping `TabStamps[sourceTabId]` for the caller's tab. Skipping the stamp would force the FE to re-fire `POST /mark-viewed` after every reload to unblock submit, which is wasted I/O and a regression-class-revival risk (forgetting the mark-viewed call after reload would silently re-introduce a `head-sha-not-stamped` symptom).

### 5.5 Reconciliation pipeline read site

[`DraftReconciliationPipeline.cs:12-18`](../../PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs) `ReconcileAsync` signature gains a **required** `string callerTabId` parameter:

```csharp
public async Task<ReconciliationResult> ReconcileAsync(
    ReviewSessionState session,
    string newHeadSha,
    string callerTabId,                                      // new — REQUIRED, non-nullable
    IFileContentSource fileSource,
    CancellationToken ct,
    IReadOnlyDictionary<string, string>? renames = null,
    IReadOnlySet<string>? deletedPaths = null)
{
    ArgumentException.ThrowIfNullOrEmpty(callerTabId);
    // ... unchanged ...

    // Override-on-head-shift clearing per spec § 3.2. Per-tab when possible; falls back
    // to session-level when the caller's tab has no prior stamp (LRU-evicted, post-V6
    // upgrade drop, or genuinely new tab). The fallback preserves today's V5 semantic
    // that any session-observed head sha differing from newHeadSha counts as a shift —
    // critical for the LRU-eviction case where Tab A's stamp was evicted by churn from
    // C-J; reloading from Tab A at a new head sha should still trigger override-clear
    // because the session has seen the old head from other tabs.
    bool headShifted;
    if (session.TabStamps.TryGetValue(callerTabId, out var priorStamp))
    {
        // Per-tab signal: caller's own prior stamp.
        headShifted = priorStamp.HeadSha != newHeadSha;
    }
    else if (session.TabStamps.Count == 0)
    {
        // First-reload semantic — empty map means "no prior view in this session"
        // (post-V6 upgrade drop, or genuinely fresh session). Don't clear overrides
        // the user may have just set; same as pre-V6 `LastViewedHeadSha is not null`
        // guard's first-reload behavior.
        headShifted = false;
    }
    else
    {
        // Session-level fallback: caller's tab was evicted (or this is its first reload
        // in a session that already had stamps from other tabs). If ANY stamp differs
        // from newHeadSha, the session has seen a different head sha and the user's
        // reload click is a real head transition. Matches V5's session-flat behavior.
        headShifted = session.TabStamps.Values.Any(s => s.HeadSha != newHeadSha);
    }
    if (headShifted) { /* same override-clear block as today */ }
```

**Verdict-reconcile site at line 216 is a SEPARATE rewrite.** [`DraftReconciliationPipeline.cs:208-220`](../../PRism.Core/Reconciliation/Pipeline/DraftReconciliationPipeline.cs) re-derives a `verdictHeadShifted` boolean from `session.LastViewedHeadSha` independently of the line-33 `headShifted` local — they aren't the same variable. The implementation must rewrite line 216 to compute `verdictHeadShifted` from the same `TabStamps.TryGetValue(callerTabId, …)`-plus-fallback shape (or refactor to reuse the line-33 `headShifted` local). Without this edit, the verdict-reconfirm branch won't compile (`session.LastViewedHeadSha` is gone). Compile error catches the omission; calling out so the plan task list enumerates it explicitly.

**Phase ordering note for reload's two-phase apply.** [`PrReloadEndpoints.PostReload`](../../PRism.Web/Endpoints/PrReloadEndpoints.cs) runs reconciliation (Phase 1) outside the state-store gate, then applies (Phase 2) inside the gate. Phase 1 reads `TabStamps[callerTabId]` against the prior stamp; Phase 2 then writes the new stamp. The ordering — read prior, then write new — is load-bearing for `headShifted` correctness, since reversed ordering would compare a freshly-written stamp against itself and always see `headShifted = false`. The existing two-phase shape preserves this naturally; no further code change beyond the field rename.

**Required-parameter rationale.** Making `callerTabId` required (vs. nullable-default) prevents a future `ReconcileAsync` caller from silently disabling override-clear by omitting the argument. The compiler enforces the discipline at every call site — a new caller's choice not to pass `callerTabId` becomes a build error, not a runtime regression. Today's single caller (`PrReloadEndpoints`) always has `sourceTabId` available (validated at the endpoint's 422 gate per § 5.4); future callers must adopt the same posture.

**Why per-caller-tab as the primary signal, with session-level fallback.** `headShifted` drives two consequential outcomes: clearing `IsOverriddenStale` flags and forcing verdict re-confirmation. Both are "the user has seen a new head sha and their prior overrides / verdicts may not apply." The relevant "user" is the one clicking Reload — the per-caller-tab signal answers that question precisely. The session-level fallback covers eviction and migration-drop without re-introducing the "any tab's stale view triggers reconfirm on a fresh tab" failure mode of a session-only-everywhere design: the fallback fires *only* when the caller has no per-tab signal, and the user's reload click is itself the consent that the session has experienced a head transition.

### 5.6 markAllRead patch — no V6 reshape

[`PrDraftEndpoints.cs:355-373`](../../PRism.Web/Endpoints/PrDraftEndpoints.cs) writes `session with { LastSeenCommentId = newId }` where `newId` is read from `cache.GetCurrent(prRef)?.HighestIssueCommentId` (server-side `IActivePrCache` value), **not** from the patch body. The cache value is updated only by `ActivePrPoller` polling github.com; comment IDs on github.com are append-only, so the cache value increases monotonically over time. Tab A and Tab B firing markAllRead within the same poll cycle read the same cache value; the write is therefore inherently monotone.

The "two tabs fire markAllRead with different ids" regression class the original draft of this section worried about does not exist — the value is server-derived, not tab-supplied. The mark-viewed write site DOES need a monotone guard (its `body.MaxCommentId` IS tab-supplied, per § 5.2); markAllRead does not.

`StateChanged` event field name (`"last-seen-comment-id"`) and FE consumer in [`useStateChangedSubscriber.ts:37`](../../frontend/src/hooks/useStateChangedSubscriber.ts) are unchanged.

### 5.7 Test hook `/test/mark-pr-viewed` + the eight mocked-mode submit specs

[`TestEndpoints.cs:149-176`](../../PRism.Web/TestHooks/TestEndpoints.cs) is the path that the **mocked-mode** Playwright submit specs use to seed `LastViewedHeadSha` without exercising the real mark-viewed wire-up. The real-flow specs at [`frontend/e2e/real/`](../../frontend/e2e/real/) drive the FE which fires `POST /mark-viewed` through `usePrDetail` (which already sends the header); they don't use this hook directly. The mocked-mode specs that DO use it:

- `frontend/e2e/s5-submit-stale-commit-oid.spec.ts`
- `frontend/e2e/s5-submit-retry-from-each-step.spec.ts`
- `frontend/e2e/s5-submit-lost-response-adoption.spec.ts`
- `frontend/e2e/s5-submit-happy-path.spec.ts`
- `frontend/e2e/s5-multi-tab-simultaneous-submit.spec.ts`
- `frontend/e2e/s5-submit-foreign-pending-review.spec.ts`
- `frontend/e2e/s5-submit-closed-merged-discard.spec.ts`
- `frontend/e2e/s5-marker-prefix-collision.spec.ts`

**The topology requires explicit coordination.** [`frontend/e2e/helpers/s5-submit.ts:14-25`](../../frontend/e2e/helpers/s5-submit.ts) defines `postTest` using Playwright's `APIRequestContext` (separate from the page's browser context). The `recordPrViewed` helper at [`s5-submit.ts:136-148`](../../frontend/e2e/helpers/s5-submit.ts) calls `postTest('/test/mark-pr-viewed', ...)` with **no tab-id header**. The subsequent UI-driven submit in each spec uses the **page's browser context**, which carries the page's own `getTabId()` value. Under V6, those two contexts have different tab ids by construction — the hook writes under one id (or none), the UI submit lands under another → 400 `head-sha-not-stamped` on every mocked-mode submit spec.

**Required changes:**

1. **Hook (`TestEndpoints.cs`):** accept `tabId` as a body field on the `MarkPrViewedRequest` record (alongside `Owner`, `Repo`, `Number`, `HeadSha`). Apply the same allowlist regex as mark-viewed (`^[a-zA-Z0-9_-]{1,64}$`). Write `TabStamps[tabId] = new TabStamp(headSha, DateTime.UtcNow)` with the same N=8 LRU eviction policy.
2. **Helper (`recordPrViewed`):** accept a `tabId: string` parameter and pass it in the request body. Add a sibling helper that extracts the page's tab id, e.g. `await page.evaluate(() => (window as any).__prism_test_getTabId?.() ?? null)` — this requires a small FE test-mode hook that exposes `getTabId()` on `window` when `aiPreview` / test mode is active. Alternative: pass the tab id explicitly via a fixture (e.g., set a cookie / localStorage value the FE reads on init). The plan picks the cleanest of the two.
3. **Specs:** each of the eight specs adds one line before `recordPrViewed` to capture the page's tab id, and passes it to the helper.

**Why a body field, not the header.** The `APIRequestContext` could send the header just as well, but the body-field shape makes the coordination explicit — the spec author has to *think* "which tab id am I seeding for?" rather than relying on context-implicit headers that might not match the UI's tab id. For test code, explicitness wins.

This is the largest non-spec test-surface change in the slice. Without it, the entire mocked-mode submit suite regresses on first run after V6. The plan must list each of the eight specs as a deliberate update task, not assume the helper change is transparent to them.

---

## 6. Inbox wire projection

[`PrInboxItem`](../../PRism.Core.Contracts/PrInboxItem.cs) keeps `LastViewedHeadSha: string?` and `LastSeenCommentId: long?` on the wire. The server-side projection from V6 storage:

```csharp
// In InboxRefreshOrchestrator (or its DTO mapper) — replaces lines 244-247:
var mostRecent = session.TabStamps
    .Values
    .OrderByDescending(s => s.StampedAtUtc)
    .FirstOrDefault();

inboxItem.LastViewedHeadSha = mostRecent?.HeadSha;
inboxItem.LastSeenCommentId = session.LastSeenCommentId is { } id ? long.Parse(id) : null;
```

**Why the most-recent stamp for `LastViewedHeadSha`.** The inbox UI uses `pr.lastViewedHeadSha == null` ([`InboxRow.tsx:31`](../../frontend/src/components/Inbox/InboxRow.tsx)) for the "first visit" badge. The most-recent projection answers "have I ever opened this PR from this install" correctly — null only when no tab has stamped.

**Why session-flat for `LastSeenCommentId`.** Already explained in § 2: session-flat preserves the monotone high-water across tabs, which the inbox unread badge requires.

---

## 7. Frontend

**Two FE edits, both small.**

### 7.1 New `tab-id-missing` error arm in `PrHeader.submitErrorMessage`

[`frontend/src/components/PrDetail/PrHeader.tsx:159-204`](../../frontend/src/components/PrDetail/PrHeader.tsx) — add the new known submit error code to the switch:

```ts
case 'tab-id-missing':
    return 'Internal error: missing tab identifier. Refresh the browser tab and retry.';
```

[`frontend/src/api/submit.ts`](../../frontend/src/api/submit.ts) — add `'tab-id-missing'` to `KNOWN_SUBMIT_ERROR_CODES`. TypeScript's exhaustive-switch over the narrowed `KnownSubmitErrorCode` enforces the PrHeader arm at compile time.

### 7.1a New `tab-id-missing` arm in `useReconcile` (reload path)

[`useReconcile.ts`](../../frontend/src/hooks/useReconcile.ts) today handles two 409 codes (`reload-stale-head`, `reload-in-progress`) and falls through to a generic banner for everything else. The new `/reload` 422 `tab-id-missing` would land on the generic-banner path with copy "Couldn't reload — please try again", which is **wrong** for this failure class — the next `postReload` call uses the same in-memory `_tabId` and will fail identically. The user has no recovery from the generic copy.

**Changes:**

1. [`frontend/src/api/draft.ts`](../../frontend/src/api/draft.ts) — `PostReloadResult` union gains `{ ok: false; status: 422; kind: 'tab-id-missing'; body: unknown }`. `postReload` maps `ApiError.status === 422` with the right body discriminator to the new variant.
2. `useReconcile` — add a state-machine arm for `kind: 'tab-id-missing'` that surfaces `BANNER_TAB_ID_MISSING` ("Couldn't reload — refresh the browser tab and retry") and does **NOT** auto-retry.
3. New banner constant alongside `BANNER_GENERIC` / `BANNER_RELOAD_STALE_HEAD`.

The submit-path equivalent (§ 7.1) already routes `tab-id-missing` to the right copy via `PrHeader.submitErrorMessage`. The reload path needs the same treatment.

### 7.2 Comment block update in `markViewed.ts`

[`markViewed.ts:21-22`](../../frontend/src/api/markViewed.ts):

> *"The tab-id header matches every other writer (PUT /draft, POST /submit, POST /reload) — the BE doesn't read it on /mark-viewed today, but consistency keeps the cross-tab presence signal aligned for future use."*

becomes:

> *"The tab-id header is consumed by the BE on /mark-viewed (per-tab `TabStamp` partitioning), /submit (rule (f) lookup), and /reload (per-tab stamp write). The BE rejects /mark-viewed and /reload with 422 `tab-id-missing` and /submit with 422 `tab-id-missing` if the header is missing or malformed."*

### 7.3 Tab-id mutability invariant

`getTabId()` ([`frontend/src/api/draft.ts:9-12`](../../frontend/src/api/draft.ts)) is set-once for the page lifetime of a tab. `__resetTabIdForTest()` exists only as a Vitest seam. The invariant the submit gate depends on:

> Production code MUST NOT mutate `_tabId` after `getTabId()` returns. The only legal mutator is `__resetTabIdForTest`, which is invoked from `__tests__/` and `e2e/` test setup only.

Add a comment block above `_tabId`'s declaration restating this:

```ts
// INVARIANT: _tabId is set-once for the page lifetime of a tab. The BE submit gate
// (PrSubmitEndpoints rule (f)) depends on each tab's _tabId being stable across the
// tab's lifetime — if production code resets it, a tab could re-stamp under a new id
// and then submit under the old id, re-introducing the cross-tab bypass class this
// slice exists to close.
//
// __resetTabIdForTest is the ONLY legal mutator, and is invoked from test setup only.
// Any production caller that needs a fresh tab id must open a new browser tab.
```

No analyzer or lint rule today; the invariant is enforced by code review. A grep for `_tabId =` in production code (excluding `__resetTabIdForTest`) returns one result (the assignment inside `getTabId` itself) and stays at one.

### 7.4 FE audit — header senders

Header is already sent on every writer:
- [`draft.ts:23`](../../frontend/src/api/draft.ts) — `TAB_ID_HEADER` exported as single source of truth.
- [`draft.ts:97, 112, 167`](../../frontend/src/api/draft.ts) — `getDraft`, `sendPatch`, `postReload` all use `tabIdHeader()`.
- [`markViewed.ts:32`](../../frontend/src/api/markViewed.ts) — sends header.
- [`submit.ts`](../../frontend/src/api/submit.ts) — sends header.

No additional FE code changes required beyond § 7.1 and § 7.2.

---

## 8. Testing

### 8.1 Migration tests

`tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs` (new):

- **Legacy session → empty tab map.** V5 fixture with `last-viewed-head-sha = "abc"`, `last-seen-comment-id = "123"` → V6: `tab-stamps: {}`, `last-viewed-head-sha` removed, `last-seen-comment-id = "123"` (preserved).
- **Idempotence.** V6 fixture (no legacy `last-viewed-head-sha`, `tab-stamps` present) → no-op.
- **Partial-rollback.** Fixture with BOTH `last-viewed-head-sha` AND `tab-stamps` populated → `JsonException`.
- **Empty `accounts`.** Fixture with `accounts: {}` → no-op.
- **Session with `tab-stamps` already populated, no legacy keys.** Preserves the map untouched.

`tests/PRism.Core.Tests/State/MigrationChainTests.cs` — extend so V1 → V6 chain still works end-to-end.

### 8.2 Endpoint tests

`tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`:

- **Happy path.** `POST /mark-viewed` with header → session gains `TabStamps[tabId] = (headSha, t)`; `LastSeenCommentId = max(prior, body.MaxCommentId)`.
- **Monotone `LastSeenCommentId`.** Two `POST /mark-viewed` calls with `MaxCommentId = 999` then `MaxCommentId = 50` → final `LastSeenCommentId = "999"` (no rewind).
- **Missing header.** No `X-PRism-Tab-Id` → 422 `/viewed/tab-id-missing`.
- **Invalid header.** Samples: `../../etc/passwd`, 65-char string, `tab id` (space), empty string → 422 `/viewed/tab-id-missing`.
- **Cap eviction.** Seed 8 stamps (ascending `StampedAtUtc`); 9th mark-viewed evicts the oldest; 9th's entry present.
- **Re-stamp existing tab.** Tab already in map; second mark-viewed → entry updated in place; count unchanged.

`tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`:

- **Two-tab bypass (the named regression).** Seed `TabStamps = { "tab-A": (sha-B, ...) }`. `POST /submit` with `X-PRism-Tab-Id: tab-B` → 400 `head-sha-not-stamped`. Without this test, the entire slice is unverified.
- **Single-tab happy path.** Stamp from `tab-X`, submit from `tab-X` → pipeline runs.
- **Missing header at submit.** No `X-PRism-Tab-Id` → 422 `tab-id-missing` (distinct from the no-map-entry 400 — this is the FE-wire-up-regression signal).
- **Invalid header at submit.** Same rejection samples as mark-viewed → 422 `tab-id-missing`.
- **Head-sha drift after per-tab stamp.** Tab stamps at sha-A, poll observes sha-B, submit → 400 `head-sha-drift`.
- **Cross-tab no-stamp parity.** Tab A stamps at sha-A; Tab B never stamps; B submits → 400 `head-sha-not-stamped` (absence-of-stamp precedes drift branch).

`tests/PRism.Web.Tests/Endpoints/PrReloadEndpointsTests.cs`:

- **Reload writes caller's tab stamp.** `POST /reload` from `tab-X` with `headSha=B` → session `TabStamps[tab-X] = (B, t)`. Other tabs' stamps untouched.
- **Reload missing tab id.** No `X-PRism-Tab-Id` → 422 `tab-id-missing`.

`tests/PRism.Core.Tests/Reconciliation/...` — extend an existing matrix test (or add a focused one) to cover:

- **`headShifted` per-caller-tab (primary branch).** Session has `TabStamps[tab-X] = sha-A`; `ReconcileAsync` with `callerTabId = "tab-X"` and `newHeadSha = "B"` → `headShifted = true`; overrides clear.
- **`headShifted` empty-map fallback.** Session has `TabStamps = {}`; `ReconcileAsync` with `callerTabId = "tab-Y"` → `headShifted = false`; overrides preserved (first-reload semantic).
- **`headShifted` session-level fallback (LRU-eviction case).** Session has `TabStamps = { "tab-A": sha-A, "tab-B": sha-A }` but `callerTabId = "tab-X"` (no entry); `newHeadSha = "B"` → `headShifted = true` because at least one stamp differs from newHeadSha. Pins the LRU-eviction regression-vs-V5 mitigation.
- **`headShifted` session-level fallback all-at-new-head.** Session has `TabStamps = { "tab-A": sha-B, "tab-B": sha-B }` but `callerTabId = "tab-X"`; `newHeadSha = "B"` → `headShifted = false`. Other tabs already at newHeadSha means the session has not seen a different head sha — correct.
- **Verdict-reconcile per-caller-tab.** Same matrix applied to the verdict-reconfirm second site at `DraftReconciliationPipeline.cs:208-220`.
- **Required-parameter compile-check.** Confirm a caller that omits `callerTabId` produces a compile error (positive evidence the parameter cannot regress to default-null).

### 8.3 Submit-success / submit-failed preservation tests

`tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs`:

- **`TabStamps` survives `SubmitOutcome.Success`.** Today's `LastViewedHeadSha` survives submit-success; pin that `TabStamps` does too.
- **`TabStamps` survives `SubmitOutcome.Failed`.** The endpoint's `SubmitOutcome.Failed` arm at [`PrSubmitEndpoints.cs:181`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) calls `WithSession(state, sessionKey, failed.NewSession)`. Confirm `failed.NewSession`'s record-`with` semantics preserve `TabStamps` through every pipeline step's mutations.

### 8.4 Test-factory rewrite surface

The reshape removes `LastViewedHeadSha` from `ReviewSessionState`'s positional constructor. Every test helper or production site that builds a session via positional record syntax fails to compile until rewritten. The grep-confirmed surface:

| File | Site |
|---|---|
| `PRism.Web/Endpoints/PrDetailEndpoints.cs:110, 169` | mark-viewed + files/viewed empty-session construction |
| `PRism.Web/Endpoints/PrDraftEndpoints.cs:571-578` | `internal static ReviewSessionState NewEmptySession()` |
| `PRism.Web/TestHooks/TestEndpoints.cs:160-170` | `/test/mark-pr-viewed` |
| `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTestHelpers.cs:25-49` | factory used by ~10 pipeline test files |
| `tests/PRism.Core.Tests/Submit/Pipeline/PipelineTypesTests.cs:22` | direct constructor |
| `tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs:53` | `Assert.Equal("head1", persisted.LastViewedHeadSha)` rewrites to `Assert.Equal("head1", persisted.TabStamps["tab-X"].HeadSha)` |
| Plus ~10 reconciliation test files | grep `LastViewedHeadSha\|LastSeenCommentId` |

The plan's task list must enumerate these so the implementation pass doesn't get stuck on "the test suite won't build" partway through.

### 8.5 Frontend tests

[`PrHeader.test.tsx`](../../frontend/__tests__/PrHeader.test.tsx) — add an arm asserting the new `tab-id-missing` error code surfaces the right toast copy.

[`useReconcile.test.tsx`](../../frontend/__tests__/useReconcile.test.tsx) (or sibling) — add a test for the new 422 `tab-id-missing` branch: assert `BANNER_TAB_ID_MISSING` surfaces with refresh-tab copy and that no auto-retry fires.

### 8.6 Playwright mocked-mode helper plumbing (the eight specs)

Tests in this slice's plan that MUST land before the Playwright suite is green:

- `frontend/e2e/helpers/s5-submit.ts` — `recordPrViewed` accepts a `tabId` parameter and passes it in the request body.
- FE test-mode hook to expose `getTabId()` to `page.evaluate` (or equivalent fixture-injection path; plan picks).
- Each of the eight mocked-mode submit specs adds the tab-id-extraction line before its `recordPrViewed` call.
- A targeted assertion in `frontend/e2e/s5-submit-happy-path.spec.ts` that the mock-mode submit POSTs with the same tab id the hook used (regression-net against the topology confusion this finding was caught on).

The real-flow Playwright suite ([`frontend/e2e/real/`](../../frontend/e2e/real/)) doesn't use the test hook, so it's unaffected — but a new real-flow spec that uses `/test/mark-pr-viewed` in the future would inherit the same constraint.

---

## 9. Risks & deferrals

### 9.1 Risks

- **Migration quarantine on hand-edited state.json.** A user who manually edited `state.json` to seed `tab-stamps` ahead of time AND left the legacy `last-viewed-head-sha` in place will quarantine on first V6 launch. Recovery: re-Setup; one mark-viewed round-trip per active PR session. Acceptable — manual state.json editing is an unsupported workflow.
- **Clock skew under backwards system-clock adjustment.** A backwards adjustment can make a "stale" `TabStamp.StampedAtUtc` look newer than a fresh stamp; eviction order is then briefly wrong. Single-machine single-process PoC; out of scope.
- **Eight-tab cap.** A user with 9+ tabs (or 9+ launches' worth of accumulated dead entries) on the same PR will see the oldest-stamped tab silently evicted. Next submit from that tab returns 400 `head-sha-not-stamped`, the standard "Reload the PR" copy. The cap exists to bound storage; it does not provide an "active tab survives" guarantee — a long-running tab that rarely re-stamps sinks under churn pressure just as it would under FIFO. Acceptable for a single-user PoC.
- **`TabStamp` shape commits v2's hand.** The V6 schema migration writes `tab-stamps: {<uuid>: {head-sha, stamped-at-utc}}` to disk for every user's state.json. v2's multi-account runtime inherits this shape. Four specific bets:
  - **Server-clock LRU** is fine for single-machine; v2 multi-device (different laptops on the same account) would want NTP-disciplined ordering or a monotonic counter.
  - **Flat-string tab-id keys** forecloses a future composite `(deviceId, tabId)` or `(accountKey, tabId)` key shape without another migration.
  - **Per-`(account, prRef)` session shape** with no cross-PR tab registry forecloses "evict all stamps for tab X across all PRs" (user closes tab → server cleans up) without a full state scan.
  - **Inbox wire contract** keeps a single `lastViewedHeadSha: string | null` per `PrInboxItem`. v2 multi-device that wants the inbox to render per-tab or per-device viewing state would need a wire reshape, not just a storage migration.

  None of these are bypass-class regressions; they are v2 ergonomic constraints. The bet: v2 multi-account will accept these constraints or pay a V6→V7 migration that the v2 brainstorm scopes. Calling out at the risk level rather than burying in § 10 so the v2 brainstorm reads this design before committing.

### 9.2 Deferred

Captured in the deferrals sidecar [`2026-05-18-cross-tab-stamp-poisoning-deferrals.md`](2026-05-18-cross-tab-stamp-poisoning-deferrals.md):

- **Tab-aware inbox.** PoC ships the most-recent-stamp projection for `LastViewedHeadSha`; `LastSeenCommentId` stays session-flat (§ 2).
- **LRU cap N=8 tuning.** Revisit when a user reports `head-sha-not-stamped` after closing a tab. (Previous revisit-when was "telemetry surfaces 9+ tab usage" — this PoC has no telemetry pipeline, so that trigger never fires.)
- **Server-clock LRU under skew.** Acknowledged, not mitigated.
- **Granular log distinction.** `s_headShaNotStamped` and `s_tabIdMissing` split the two fail-closed branches at the log level; further granularity (e.g., distinguishing "header missing" from "allowlist-failed") is deferrable.
- **Tab-id mutability lint guard.** `_tabId` invariant is enforced by code review (§ 7.3). A Roslyn-style analyzer or a TypeScript lint rule that flags any production assignment to `_tabId` outside `getTabId` / `__resetTabIdForTest` is the harder enforcement. Deferred until a regression actually fires.

---

## 10. Project standards updates

- [`docs/spec/02-architecture.md`](../spec/02-architecture.md) — Two amendments:
  - § "ReviewSessionState shape": `LastViewedHeadSha` is per-tab via `TabStamps` post-V6; `LastSeenCommentId` stays session-flat.
  - § "Multi-tab consistency" (or equivalent): note that this slice introduces *one* per-tab field (`TabStamps.HeadSha`) as a deliberate exception to the otherwise eventual-consistency-via-polling model. The exception is justified by the submit-gate's correctness need (each tab must be gated by its own viewing); all other session fields remain session-flat with `StateChanged`-broadcast convergence.
- [`.ai/docs/architectural-invariants.md`](../../.ai/docs/architectural-invariants.md) — No new invariant. The cross-tab partitioning is a localized fix; v2's multi-account runtime (which inherits this) may add a binding "submit-gate session state is per-tab AND per-account" invariant. This slice lays the groundwork without committing.
- [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) — No update; the demo flow is single-tab and unchanged.

---

## 11. Open questions

None at design time. All substantive choices — including the Q1 reversal that pulled `LastSeenCommentId` back to session-flat in response to the inbox-projection regression surfaced by the first-pass ce-doc-review — are settled and reflected in this revision.
