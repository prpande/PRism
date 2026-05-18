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

`ReviewSessionState` keys session data on `owner/repo/number` only. Two tabs open on the same PR share a single `LastViewedHeadSha`. Tab A's `POST /mark-viewed` at `headSha=B` silently overwrites Tab B's stamp at `headSha=A`; the submit-gate rule (f) — *"most-recent active-PR poll observed no head-sha drift"* — then evaluates against the *other* tab's stamp. Tab B can submit at `headSha=B` without having reviewed B's diff. The pre-decision sketch in the deferral entry — *"store LastViewedHeadSha as `Dictionary<string, string>` keyed by `X-PRism-Tab-Id`, eviction LRU at N=8"* — is the right shape; this design fills in the storage detail, migration, header plumbing, inbox wire projection, and test matrix.

The slice ships a V5→V6 schema migration, promotes `LastViewedHeadSha` + `LastSeenCommentId` into a per-tab `TabStamp` map inside `ReviewSessionState`, plumbs `X-PRism-Tab-Id` into the mark-viewed and submit endpoints (which currently ignore the header on these two routes), and pins the two-tab bypass scenario with a `PrSubmitEndpoints` test.

End-to-end behavior change: a user with two tabs open on the same PR cannot submit from a tab whose own diff they haven't viewed at the PR's current head sha. The single-tab path is byte-identical to today.

---

## Problem Frame

The bypass is silent and architectural. Today's single stamp is a single value; the FE has no model of which tab "owns" the stamp. The submit endpoint reads the value with no caller-tab context. A reviewer with two tabs open on the same PR — common when comparing two commits side-by-side, or when a Slack ping reopened a PR in a second window — can submit a verdict against a head sha they have not actually inspected. The risk shape matches the S5 design's "silently-wrong, not loudly-broken" framing: nothing in the UI surfaces that the wrong stamp was used; the verdict lands on github.com and is attributed to the reviewer.

The deferral was carried forward because the fix needs a schema migration, and S6 PR0 (the multi-account storage-shape scaffold) was the natural carrier. PR0 shipped without taking on this work; V6 is the next discrete schema step and a clean home for it.

---

## 1. Goals & non-goals

### 1.1 Goals

1. Make the submit gate evaluate each tab's stamp independently. A stamp landed by Tab A never unblocks a submit from Tab B.
2. Preserve the single-tab user experience byte-identically — no extra prompts, no extra round-trips, no behavior change in the dominant case.
3. Migrate V5 → V6 cleanly, with idempotency and partial-rollback discrimination matching V4→V5's policy ([§ 4.1](#41-state-statejson-v5--v6)).
4. Cap per-session tab-id storage at N=8 with LRU eviction so a long-running install doesn't accumulate unbounded entries.
5. Pin the two-tab bypass regression in `PrSubmitEndpoints` tests so future refactors can't silently regress it.

### 1.2 Non-goals

- **Tab-aware inbox** — the inbox lists PRs across all subscriptions; "have I viewed this from THIS tab" is not a useful per-row semantic, and the existing `pr.lastViewedHeadSha == null` "first visit" badge serves a different purpose (have I *ever* opened this PR). The wire projection ([§ 6](#6-inbox-wire-projection)) preserves the existing semantic.
- **Tab-aware SSE filtering** — already exists ([`SourceTabId` on `StateChanged` / `DraftSaved` / `DraftDiscarded`](../../PRism.Core/Events/)). This slice doesn't touch it.
- **Tab-id durability across browser launches** — `getTabId()` is in-memory only ([`frontend/src/api/draft.ts:9-12`](../../frontend/src/api/draft.ts)). After a launch, every tab is a new tab; their first PR-detail load fires `mark-viewed` and re-stamps. This is the right semantic — a fresh launch has no continuity with prior viewing context.
- **Removing the FE wire-up gate test** — the existing `head-sha-not-stamped` 400 (the symptom that PR #55 fixed) is preserved verbatim. Per-tab partitioning narrows *when* the 400 fires; it doesn't change the error code or the FE recovery path.

---

## 2. Storage shape

Inside [`PRism.Core/State/AppState.cs`](../../PRism.Core/State/AppState.cs), `ReviewSessionState` reshapes:

```csharp
public sealed record ReviewSessionState(
    IReadOnlyDictionary<string, TabStamp> TabStamps,   // new; replaces LastViewedHeadSha + LastSeenCommentId
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
    string? MaxCommentId,
    DateTime StampedAtUtc);
```

**Why both fields, not just `HeadSha`.** `LastViewedHeadSha` and `LastSeenCommentId` are stamped atomically by a single `POST /mark-viewed` ([`PrDetailEndpoints.cs:112-116`](../../PRism.Web/Endpoints/PrDetailEndpoints.cs)). Asymmetric partitioning (per-tab head sha, session-flat seen-comment-id) leaves a residual cross-tab poisoning surface in the unread-comment count math used by [`BannerRefresh`](../../frontend/src/components/PrDetail/BannerRefresh.tsx), at no storage saving worth the irregular shape. Moving both into `TabStamp` keeps the atomicity that the existing mark-viewed call already promises.

**Why `DateTime StampedAtUtc`, not insertion order.** LRU eviction on a long-running tab that rarely re-stamps would silently penalize that tab under insertion-order semantics — its entry sinks because *other* tabs touched the map more recently. `StampedAtUtc` makes eviction order match the deferral entry's "LRU" framing literally. The server clock is fine here: the consumer is "evict the oldest entry within a single (account, PR) session," not any user-visible ordering. Clock skew under a backwards system-clock adjustment is acknowledged in the deferrals sidecar.

**Why nest inside `ReviewSessionState`, not at a higher level.** Sessions already live at `accounts.{key}.reviews.sessions.{owner/repo/n}` post-S6 PR0. A tab map at the account or top level would force a join key from `(account, prRef, tab)` back down to a session, recreating data the per-session map already encodes. The FE's `getTabId()` is cross-account by construction (one per browser launch) and that's correct — the same tab id will appear independently in each `(account, prRef)` session's tab map it touches, with no FE-side bookkeeping required.

**JSON shape** (under `accounts.{key}.reviews.sessions.{owner/repo/n}`):

```jsonc
{
  "tab-stamps": {
    "0c1f4e8a-3b9d-4c2f-9e1a-2b3c4d5e6f70": {
      "head-sha": "abc123...",
      "max-comment-id": "987654321",
      "stamped-at-utc": "2026-05-18T14:23:45.6789012Z"
    }
  },
  "pending-review-id": null,
  // ... rest unchanged
}
```

---

## 3. Tab-id validation

Header value must match `^[a-zA-Z0-9_-]{1,64}$` before being used as a JSON map key, a log field, or a dictionary lookup key.

Same allowlist as the [S6 PR0 § 7 binding constraint #2](2026-05-10-multi-account-scaffold-design.md#7-v2-user-facing-model--constraints-v1-places--advisory-observations) for `accountKey`, applied verbatim because the threat surface is identical: header value lands in JSON map keys (state.json), log lines (`s_headShaNotStamped` would log it for cross-tab debugging), and would land in file paths if v2 ever shards per-tab.

Implementation: inline regex at each call site initially. If a third site appears, factor to `PRism.Core/State/TabIds.cs` with a single `IsValid(string)` method. v1 has two sites — `PrDetailEndpoints.MapPost("/mark-viewed", ...)` and `PrSubmitEndpoints.SubmitAsync` — so inline keeps the seam from being premature.

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
    //     `last-viewed-head-sha` / `last-seen-comment-id` keys anywhere): just bump version.
    //     Idempotent.
    //
    //   - Partial-rollback / hand-edit (a session has BOTH legacy keys AND a pre-existing
    //     `tab-stamps` key): refuse to silently pick one set. Surface as JsonException so
    //     LoadCoreAsync's catch (JsonException) quarantines the whole file. Same all-or-
    //     nothing policy as V4→V5: one inconsistent session quarantines the file; the
    //     user lands at AppState.Default + re-Setup. Per-session partial recovery is
    //     deliberately not attempted — quarantine is the safer default for a single-user
    //     local PoC where the right recovery is "re-stamp on next PR detail load."
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

            var hasLegacy = session["last-viewed-head-sha"] is not null
                         || session["last-seen-comment-id"] is not null;
            var hasNew = session["tab-stamps"] is JsonObject;

            if (hasLegacy && hasNew)
                throw new System.Text.Json.JsonException(
                    "state.json session has both legacy last-viewed-head-sha/last-seen-comment-id AND " +
                    "a tab-stamps key. This indicates a partial rollback from a future version or a " +
                    "hand-edit gone wrong. Quarantining and re-Setup is safer than guessing which set wins.");

            // Drop pre-V6 stamps. Cannot be attributed to any specific tab; synthesizing under a
            // sentinel key (e.g. "__legacy") would either match every tab's submit (re-introducing
            // the bypass) or match no tab's submit (functionally equivalent to drop, plus extra
            // storage + a confusing key). Drop is the honest move.
            //
            // Cost: every active session needs one mark-viewed round-trip on the next PR-detail
            // load before submit unblocks. That round-trip already fires unconditionally from
            // usePrDetail.ts:66-79 on every PR-detail load, so the cost is invisible to the user.
            session.Remove("last-viewed-head-sha");
            session.Remove("last-seen-comment-id");
            if (!hasNew) session["tab-stamps"] = new JsonObject();
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
- `EnsureCurrentShape` extends to backfill `session["tab-stamps"] = new JsonObject()` for sessions missing the key. This defends against a future-version file (V7+) that drops sessions through the deserializer with `TabStamps == null`, which would NRE on the first `session.TabStamps.TryGetValue(...)` in the submit endpoint.

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

## 5. Endpoint changes

### 5.1 Mark-viewed write site

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
                var session = state.Reviews.Sessions.GetValueOrDefault(key) ??
                              new ReviewSessionState(
                                  TabStamps: new Dictionary<string, TabStamp>(),
                                  PendingReviewId: null,
                                  PendingReviewCommitOid: null,
                                  ViewedFiles: new Dictionary<string, string>(),
                                  DraftComments: new List<DraftComment>(),
                                  DraftReplies: new List<DraftReply>(),
                                  DraftSummaryMarkdown: null,
                                  DraftVerdict: null,
                                  DraftVerdictStatus: DraftVerdictStatus.Draft);

                var tabStamps = session.TabStamps.ToDictionary(kv => kv.Key, kv => kv.Value);
                tabStamps[tabId] = new TabStamp(body.HeadSha, body.MaxCommentId, DateTime.UtcNow);

                // LRU eviction at N=8. The newly-inserted entry is the newest by construction
                // (DateTime.UtcNow > any prior entry's StampedAtUtc), so it can never be the
                // eviction target unless N=1.
                if (tabStamps.Count > 8)
                {
                    var oldest = tabStamps.MinBy(kv => kv.Value.StampedAtUtc).Key;
                    tabStamps.Remove(oldest);
                }

                var sessions = state.Reviews.Sessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions[key] = session with { TabStamps = tabStamps };
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
```

**Why 422 for missing/invalid tab id, not 400.** Consistent with the existing `MarkViewedRequest` validation surface — `/viewed/snapshot-evicted` and `/viewed/stale-head-sha` are 422 / 409 for input-shape problems; tab-id-missing is the same class. 400 is reserved for the submit endpoint's rule-(f) family.

**`/api/pr/{owner}/{repo}/{number:int}/files/viewed` is unchanged.** It already stamps under a `(prRef, path, headSha)` triple. The cross-tab poisoning class doesn't extend to per-file viewed state because the file-viewed check isn't part of rule (f) — it's a per-file UX affordance, not a submit gate. Out of scope.

### 5.2 Submit-gate read site

[`PrSubmitEndpoints.cs:113-144`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) rule (f) reshapes:

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

    // Rule (f) — per-tab. Caller's tab id is required; missing/invalid is treated as
    // "head-sha-not-stamped" (fail-closed). A regressed FE that forgot the header would
    // present exactly this shape, and the existing `s_headShaNotStamped` log already
    // points operators at the FE wire-up.
    var tabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();
    if (string.IsNullOrEmpty(tabId) || !TabIdAllowlistRegex().IsMatch(tabId))
    {
        s_headShaNotStamped(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
        return Results.Json(new SubmitErrorDto("head-sha-not-stamped",
            "PR detail has not been marked viewed yet. Reload the PR and try again."),
            statusCode: StatusCodes.Status400BadRequest);
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

[GeneratedRegex(@"^[a-zA-Z0-9_-]{1,64}$")]
private static partial Regex TabIdAllowlistRegex();
```

**`PrSubmitEndpoints` becomes `partial`.** It's currently `internal static class` ([`PrSubmitEndpoints.cs:23`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs)); `[GeneratedRegex]` requires `partial`. Add the keyword. `PrDetailEndpoints` is already `internal static partial class` so the mark-viewed site needs no class-level edit.

**Two distinct null branches collapsed to one log.** Both "header missing/invalid" and "no entry for this tab in the map" emit `s_headShaNotStamped`. The two cases are observationally identical from the user's POV — Reload the PR and try again — and the log message points at the FE wire-up either way. A more granular log distinction is deferrable to v2 if it ever becomes diagnostic-load-bearing.

**Pipeline `getCurrentHeadShaAsync` callback unchanged.** [`PrSubmitEndpoints.cs:150-154`](../../PRism.Web/Endpoints/PrSubmitEndpoints.cs) calls `prReader.PollActivePrAsync` directly; it doesn't read the stamp. The pre-Finalize re-poll for stale-`commitOID` continues to work as before.

### 5.3 `SubmitRequestDto` body unchanged

Tab id stays header-only. Same precedent as `PrDraftEndpoints` ([line 82](../../PRism.Web/Endpoints/PrDraftEndpoints.cs)) and `PrReloadEndpoints`. Single source of truth on the wire; duplicating into the body invites drift.

### 5.4 `MarkViewedRequest` body unchanged

Same rationale.

---

## 6. Inbox wire projection

[`PrInboxItem`](../../PRism.Core.Contracts/PrInboxItem.cs) keeps `LastViewedHeadSha: string?` and `LastSeenCommentId: long?` on the wire. The server-side projection from V6 storage:

```csharp
// In the inbox query / mapper that turns session state into PrInboxItem rows:
var mostRecent = session.TabStamps
    .Values
    .OrderByDescending(s => s.StampedAtUtc)
    .FirstOrDefault();

inboxItem.LastViewedHeadSha = mostRecent?.HeadSha;
inboxItem.LastSeenCommentId = mostRecent?.MaxCommentId is { } id ? long.Parse(id) : null;
```

**Why the most-recent stamp across all tabs.** The inbox UI uses `pr.lastViewedHeadSha == null` ([`InboxRow.tsx:31`](../../frontend/src/components/Inbox/InboxRow.tsx)) for the "first visit" badge, and uses the comment-id for unread-comment math. Both questions are session-level, not tab-level — "have I ever opened this PR from this install" and "what's the highest comment id I've seen on this PR across all my tabs." The most-recent-stamp projection answers both correctly without a wire shape change. A tab-aware inbox is a deferred v2 surface ([§ 9.2](#92-deferred)).

**Why not aggregate over all stamps.** Aggregating (e.g., min, max, set of head shas) doesn't have a useful inbox semantic. "Which head sha have you viewed" is a per-tab question; "have you viewed this PR at all" is the session question, and "most recent" is a stable representative for that question.

---

## 7. Frontend

**No FE code changes required.**

Audit:
- [`draft.ts:23`](../../frontend/src/api/draft.ts) — `TAB_ID_HEADER` exported as single source of truth.
- [`draft.ts:9-12`](../../frontend/src/api/draft.ts) — `getTabId()` is per-launch, in-memory only.
- [`markViewed.ts:32`](../../frontend/src/api/markViewed.ts) — sends `X-PRism-Tab-Id` on every POST.
- [`submit.ts`](../../frontend/src/api/submit.ts) — sends `X-PRism-Tab-Id` on every POST (consolidated to import from `draft.ts` in PR #55 round 2).
- [`__resetTabIdForTest()`](../../frontend/src/api/draft.ts) — exists for unit-test isolation.

The only FE-facing edit is the comment block in [`markViewed.ts:21-22`](../../frontend/src/api/markViewed.ts):

> *"The tab-id header matches every other writer (PUT /draft, POST /submit, POST /reload) — the BE doesn't read it on /mark-viewed today, but consistency keeps the cross-tab presence signal aligned for future use."*

becomes:

> *"The tab-id header is consumed by the BE on /mark-viewed (per-tab `TabStamp` partitioning) and on /submit (rule (f) lookup). The BE rejects /mark-viewed with 422 `/viewed/tab-id-missing` and /submit with 400 `head-sha-not-stamped` if the header is missing or malformed."*

---

## 8. Testing

### 8.1 Migration tests

`tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV5ToV6Tests.cs` (new):

- **Legacy session → empty tab map.** Load V5 fixture with `last-viewed-head-sha = "abc"`, `last-seen-comment-id = "123"`; assert V6 shape: `tab-stamps: {}`, both legacy keys removed.
- **Idempotence.** Load V6 fixture (no legacy keys, `tab-stamps: {}`) → no-op, version stays 6 (after the bump from V5 it's 6; re-running MigrateV5ToV6 leaves it untouched).
- **Partial-rollback.** Load fixture with BOTH legacy keys AND `tab-stamps` populated → `JsonException` thrown.
- **Empty `accounts`.** Load fixture with `accounts: {}` → no-op.
- **Session with `tab-stamps` already populated, no legacy keys.** Load → preserves the existing map untouched (e.g., a hand-edited V5 file that anticipated V6).

`tests/PRism.Core.Tests/State/MigrationChainTests.cs` — extend so V1 → V6 chain still works end-to-end.

### 8.2 Endpoint tests

`tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs`:

- **Happy path.** `POST /mark-viewed` with header → session gains `TabStamps[tabId] = (headSha, maxCommentId, t)`.
- **Missing header.** `POST /mark-viewed` without `X-PRism-Tab-Id` → 422 `/viewed/tab-id-missing`.
- **Invalid header.** `POST /mark-viewed` with `X-PRism-Tab-Id: ../../etc/passwd` → 422 `/viewed/tab-id-missing`. Other rejection samples: `X-PRism-Tab-Id: a` × 65 (too long), `X-PRism-Tab-Id: tab id` (space), empty string.
- **Cap eviction.** Seed session with 8 stamps (each `StampedAtUtc` ascending); `POST /mark-viewed` from a 9th tab → tab with the earliest `StampedAtUtc` is evicted; the 9th's entry is present.
- **Re-stamp from existing tab.** Tab already in the map; `POST /mark-viewed` again → entry updated in place; map count unchanged.
- **Sequence with same `StampedAtUtc`** (tight loop, clock granularity tie) — the test asserts only the *post-condition*: count stays ≤ N, the freshly-inserted entry is present, and exactly one tied entry was evicted. `MinBy`'s tiebreaker over `Dictionary` enumeration is implementation-defined and not pinned. Either tied pick is correct behavior; ties are vanishingly rare in practice (`DateTime.UtcNow` resolution is sub-millisecond on Windows).

`tests/PRism.Web.Tests/Endpoints/PrSubmitEndpointsTests.cs`:

- **Two-tab bypass scenario (the named regression).** Seed session with `TabStamps = { "tab-A": (sha-B, ...) }`. `POST /submit` with `X-PRism-Tab-Id: tab-B` → 400 `head-sha-not-stamped`. Without this test, the entire slice is unverified.
- **Multi-account × tab-id matrix.** Two accounts with sessions on the same `owner/repo/number`. Stamp under `accounts.A` with `tab-X`; submit from `accounts.B` with `tab-X` → 400 `head-sha-not-stamped`. Sessions are per-account by V5 shape, so this is structurally enforced; the test pins it so a future flattening can't regress.
- **Single-tab happy path.** Stamp from `tab-X`, submit from `tab-X` → pipeline runs (no rule-(f) rejection). Unchanged behavior.
- **Header missing at submit.** `POST /submit` without `X-PRism-Tab-Id` → 400 `head-sha-not-stamped` (fail-closed; matches the submit endpoint's existing failure-mode shape).
- **Header invalid at submit.** Same shape as `mark-viewed` invalid-header rejection samples → 400 `head-sha-not-stamped`.
- **Head-sha drift after per-tab stamp.** Tab stamps at `sha-A`, poll observes `sha-B`, submit → 400 `head-sha-drift` (unchanged behavior).
- **Cross-tab head-sha-drift parity.** Tab A stamps at `sha-A`; tab B never stamps; tab B submits → 400 `head-sha-not-stamped` (not `head-sha-drift`). Pins that the absence-of-stamp branch precedes the drift branch.

`tests/PRism.Core.Tests/Submit/Pipeline/SuccessClearsSessionTests.cs`:

- **`TabStamps` survives `SubmitOutcome.Success`.** Today's `LastViewedHeadSha` survives submit-success (no clear in the pipeline's success path); the test pins that `TabStamps` also survives. Future change is then a deliberate spec edit, not a silent regression.

### 8.3 Frontend tests

No FE behavior change → no FE test additions. Existing [`usePrDetail.test.tsx`](../../frontend/__tests__/usePrDetail.test.tsx) continues to assert `mark-viewed` POST fires on PR-detail load.

The real-flow Playwright suite ([`frontend/e2e/real/`](../../frontend/e2e/real/)) already exercises one tab's mark-viewed → submit chain on a real GitHub PR. Per-tab partitioning is a backend-only change for a single tab; the existing happy-path spec covers it.

---

## 9. Risks & deferrals

### 9.1 Risks

- **Migration quarantine on hand-edited state.json.** A user who has manually edited `state.json` to seed `tab-stamps` ahead of time AND left the legacy `last-viewed-head-sha` in place will quarantine on first V6 launch. Recovery: re-Setup; one mark-viewed round-trip per active PR session. Acceptable — manual state.json editing is an unsupported workflow.
- **Clock skew under backwards system-clock adjustment.** A backwards adjustment can make a "stale" `TabStamp.StampedAtUtc` look newer than a fresh stamp; eviction order is then briefly wrong. Single-machine single-process PoC; out of scope.
- **Eight-tab cap.** A user with 9+ tabs open on the same PR will see the oldest-stamped tab silently evicted from the map. Their next submit attempt from that tab returns 400 `head-sha-not-stamped`, the standard "Reload the PR" copy. Acceptable — 9+ tabs on one PR is an unusual workflow; the recovery is one Reload.

### 9.2 Deferred

Captured in the deferrals sidecar [`2026-05-18-cross-tab-stamp-poisoning-deferrals.md`](2026-05-18-cross-tab-stamp-poisoning-deferrals.md):

- **Tab-aware inbox.** PoC ships the most-recent-stamp projection.
- **LRU cap N=8 tuning.** Revisit if telemetry surfaces real 9+ tab usage.
- **Server-clock LRU under skew.** Acknowledged, not mitigated.
- **Granular log distinction** between "header missing/invalid" and "no map entry" at the submit gate — both currently emit `s_headShaNotStamped`. Distinct event-ids would be useful if a regression class ever divides them.

---

## 10. Project standards updates

- [`docs/spec/02-architecture.md`](../spec/02-architecture.md) — Where the spec discusses session state shape (`ReviewSessionState`), update to note that `LastViewedHeadSha` / `LastSeenCommentId` are per-tab post-V6.
- [`.ai/docs/architectural-invariants.md`](../../.ai/docs/architectural-invariants.md) — No new invariant. The cross-tab partitioning is a localized fix to one regression class; it doesn't graduate to invariant status. v2's multi-account runtime (which inherits this work) may add a binding "all submit-affecting session state is per-tab AND per-account" invariant; this slice lays the groundwork without committing to that abstraction.
- [`docs/spec/01-vision-and-acceptance.md`](../spec/01-vision-and-acceptance.md) — No update; the demo flow is single-tab and unchanged.

---

## 11. Open questions

None at design time. All five substantive questions raised during brainstorm ([`TabStamp` field set, inbox wire shape, V5→V6 migration policy for pre-existing stamps, LRU bookkeeping, tab-id allowlist](#summary)) settled to defaults the user reviewed.
