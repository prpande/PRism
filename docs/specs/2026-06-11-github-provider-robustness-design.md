---
title: GitHub provider robustness (inbox read-path hardening)
date: 2026-06-11
issues: ["#322", "#361"]
type: refactor
status: draft
origin: none
---

# GitHub provider robustness — design

## Problem

Five defects in the GitHub provider's inbox read-path, four from the #322 audit plus the
terminal-CI-TTL gap filed as #361 during #355's review. Each is independently shippable; they
cluster because they all live in `PRism.GitHub/Inbox/` (plus two single-comment write paths) and
share the same failure shape — a provider edge case that silently degrades the inbox rather than
surfacing or self-healing.

1. **Unbounded singleton caches never evict.** `GitHubPrEnricher`, `GitHubAwaitingAuthorFilter`,
   and `GitHubCiFailingDetector` each hold a process-lifetime `ConcurrentDictionary` keyed by
   `(PrReference, …)`. Entries are only ever added. A PR that leaves the inbox (merged, closed past
   the window, filter changed) leaves its entry resident forever. Over a long-running desktop
   session the maps grow without bound.

2. **Reviews pagination is wrong-shaped.** `GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync`
   requests `reviews?per_page=100`, reads only the first page, and takes the last viewer-authored
   entry as "most recent" (`// last in the array = most recent`). GitHub returns reviews in
   **ascending** chronological order, so page 1 of a PR with >100 reviews holds the *oldest* 100 —
   the genuinely-most-recent review is on a later page that is never fetched. The filter then
   compares a stale review SHA against the head and can mis-classify a PR's awaiting-author state.

3. **Malformed-2xx thrown as `HttpRequestException` with a 2xx status.** Four sites in the
   single-comment write paths (`CreateReviewCommentAsync`, `CreateIssueCommentAsync`) throw
   `new HttpRequestException(…, statusCode: HttpStatusCode.OK)` when a 2xx response body is missing
   `id`/`created_at`. An `HttpRequestException` carrying `HttpStatusCode.OK` is a category error: the
   transport succeeded; the *contract* was violated. Anything that branches on
   `HttpRequestException.StatusCode` (or reasons about it) sees a success code on a failure.

4. **One malformed item poisons the whole batch.** The inbox JSON readers access fields with
   throwing `GetProperty(...)` calls inside per-item / per-PR loops:
   `GitHubSectionQueryRunner.SearchAsync` (the `items[]` loop), `GitHubPrEnricher.FetchAsync:68`
   (`head.sha`), `GitHubAwaitingAuthorFilter:79` (`user.login`). A single search result or PR detail
   with an unexpected shape throws, and because the enricher/filter run their probes under one
   `Task.WhenAll`, that throw aborts the entire tick — the poller's tick-level catch then empties the
   whole snapshot. One poisoned PR blanks the inbox.

5. **[folded #361] Terminal CI status is cached with no TTL.** `GitHubCiFailingDetector` caches a
   terminal `Passing`/`Failing`/`None` by `(PrReference, headSha)` forever. After #355, `Pending` is
   re-probed each sweep and a manual Refresh self-heals a same-SHA re-run — but **fully-automatic**
   recovery does not happen: a GitHub "Re-run failed jobs" on an unchanged head SHA flips CI back to
   running, yet the inbox keeps showing the cached terminal dot until the user clicks Refresh or the
   head SHA moves. There is no clock-driven re-validation.

## Goals

- Bound all three inbox caches: entries for PRs absent from the current snapshot are evicted each tick.
- Make reviews pagination correct (Link-walk) with an explicit, logged page-cap signal — never
  silently wrong-shaped.
- Stop constructing `HttpRequestException` with a 2xx status anywhere in `PRism.GitHub`; use a typed
  contract exception that mirrors the existing `GitHubGraphQLException`.
- Isolate per-item JSON failures so one malformed item degrades that item, not the whole section/tick.
- Re-validate a cached terminal CI status after a TTL via an injected `IClock`, so a same-SHA CI
  re-run auto-recovers without a manual Refresh.

## Non-goals

- No change to the inbox wire contract, section taxonomy, or any frontend code. This is provider-internal.
- No change to the GraphQL **atomic-submit** pipeline (`GitHubReviewService.Submit.cs`). Finding #3
  touches only the #302 *decoupled single-comment* REST paths; submit ordering and `prism:client-id`
  stamping are untouched. (This keeps the work off the B2 reviewer-atomic risk surface — re-verified
  at the pre-PR gate.)
- No retroactive cap on `MaxCheckRunPages` semantics; the new reviews cap mirrors the existing one.
- No superseded-run filtering, `action_required` modelling, or other CI-classification changes
  (tracked separately in #305).

## Architecture

The change is additive and local. Two new small support types, one DI wiring addition, and edits to
the five implicated readers/writers. No new package dependencies.

```
PRism.GitHub/
  GitHubLinkHeader.cs            (NEW) shared Link-header "rel=next" parser
  GitHubRestContractException.cs (NEW) typed malformed-2xx exception
  Inbox/
    InboxCacheEviction.cs        (NEW) shared absent-PrReference prune helper
    GitHubCiFailingDetector.cs   (EDIT) IClock + per-entry timestamp + TTL; eviction; use GitHubLinkHeader
    GitHubPrEnricher.cs          (EDIT) eviction; per-PR JSON isolation
    GitHubAwaitingAuthorFilter.cs(EDIT) eviction; Link-walk reviews; per-item JSON isolation; ILogger
    GitHubSectionQueryRunner.cs  (EDIT) per-item JSON isolation in SearchAsync
  ServiceCollectionExtensions.cs (EDIT) register IClock→SystemClock; pass IClock + ILogger
  GitHubReviewService.ReviewComments.cs (EDIT) 2× throw → GitHubRestContractException
  GitHubReviewService.IssueComments.cs  (EDIT) 2× throw → GitHubRestContractException
```

---

## Unit U1 — Bound the three inbox caches (AC1)

**Decision:** prune **by absent `PrReference`**. At the end of each `EnrichAsync` / `FilterAsync` /
`DetectAsync` tick, drop every cache key whose `PrReference` is not in the current item set; on an
empty-items tick, clear the cache. This matches the issue's literal AC and is the simplest mental
model. The minor residual — a PR that re-pushes (new head SHA) *while still in the inbox* keeps its
old-SHA key until it leaves — is accepted; those keys are bounded by inbox size and cleaned on
departure. (The tighter "retain-only-current-tick-keys" alternative was considered and rejected as
over-bounding for no real-world benefit.)

**Shared helper** — `PRism.GitHub/Inbox/InboxCacheEviction.cs`:

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Per-tick cache pruning shared by the three inbox readers. Each reader holds a
/// process-lifetime cache keyed by (PrReference, T); after a tick we drop every key
/// whose PrReference is absent from the current snapshot so the map stays bounded by
/// live inbox size. The second key component (head SHA / UpdatedAt) is irrelevant to
/// eviction — a PR leaving the inbox removes all of its keys regardless. (#322)
/// </summary>
internal static class InboxCacheEviction
{
    public static void PruneAbsent<TKey2, TValue>(
        ConcurrentDictionary<(PrReference, TKey2), TValue> cache,
        IReadOnlyCollection<PrReference> live)
    {
        var liveSet = live as HashSet<PrReference> ?? new HashSet<PrReference>(live);
        foreach (var key in cache.Keys)
        {
            if (!liveSet.Contains(key.Item1))
                cache.TryRemove(key, out _);
        }
    }
}
```

`ConcurrentDictionary.Keys` returns a snapshot, so enumerating while `TryRemove`-ing is safe. The
prune runs on the calling thread after `Task.WhenAll` completes, so it never races the per-item writes.

**Call-site pattern** (each of the three classes):
- On the empty-items early return, replace `return …;` with `{ _cache.Clear(); return …; }`.
- After `Task.WhenAll(...)`, before building the result, compute the live set and prune:
  ```csharp
  InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
  ```
  (Filter uses `candidates`; detector uses `items`.)

**Files:** Create `Inbox/InboxCacheEviction.cs`. Edit `GitHubPrEnricher.cs`,
`GitHubAwaitingAuthorFilter.cs`, `GitHubCiFailingDetector.cs`.

**Tests** (one per class, in the respective `*Tests`):
- Tick 1 with PRs {A, B} populates 2 cache entries; tick 2 with {A} only leaves A's entry, B evicted.
- Empty-items tick clears a previously-populated cache.
- Asserting cache contents: the caches are `private`. Prefer a behavioural assertion — drive a second
  tick for a now-absent PR with a probe double that would *change* the answer, and assert the reader
  re-probes (cache miss) rather than returning the stale cached value. Where a behavioural assert is
  impractical, add an `internal` count accessor guarded by `InternalsVisibleTo` (the GitHub test
  project already has access) rather than reflection.

---

## Unit U2 — Correct reviews pagination (AC2)

**Decision:** Link-walk `FetchLastReviewShaAsync` exactly as `FetchChecksAsync` already does — follow
`rel="next"` to the last page, keeping the last viewer-authored `commit_id` seen across **all** pages
(ascending order means the last one overall is the most recent). Cap at `MaxReviewPages = 10`
(mirrors `MaxCheckRunPages`); if the cap is hit with more pages pending, **log a warning** so the
truncation is explicit, never silent. To reuse the existing Link parser instead of copy-pasting it,
extract it into a shared helper.

**Shared helper** — `PRism.GitHub/GitHubLinkHeader.cs` (extracted verbatim from the CI detector's
private `TryGetNextLink`, made `internal static`):

```csharp
using System.Net.Http;

namespace PRism.GitHub;

/// <summary>
/// Parses a GitHub <c>Link</c> response header and returns the absolute URL whose
/// attributes include <c>rel="next"</c>, or null if none. Format:
/// <c>&lt;url1&gt;; rel="next", &lt;url2&gt;; rel="last"</c>. Node IDs / URLs are opaque —
/// the absolute URL is handed straight back to HttpClient. (#322; extracted from
/// GitHubCiFailingDetector so the reviews walk can share it.)
/// </summary>
internal static class GitHubLinkHeader
{
    public static Uri? TryGetNext(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Link", out var values)) return null;
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;
                var hasNext = false;
                for (var i = 1; i < segments.Length; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals("rel=\"next\"", StringComparison.Ordinal)
                        || attr.Equals("rel=next", StringComparison.Ordinal))
                    {
                        hasNext = true;
                        break;
                    }
                }
                if (!hasNext) continue;
                var url = urlSegment[1..^1];
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri)) return uri;
            }
        }
        return null;
    }
}
```

`GitHubCiFailingDetector` deletes its private `TryGetNextLink` and calls `GitHubLinkHeader.TryGetNext(resp)`.

**Filter rewrite** — `FetchLastReviewShaAsync` becomes a paginated loop. One `HttpClient` for the
walk; `commit_id`-extraction per review is isolated per U4 (see below). Structure:

```csharp
private const int MaxReviewPages = 10;

private async Task<string?> FetchLastReviewShaAsync(
    PrReference pr, string viewerLogin, string? token, CancellationToken ct)
{
    string? best = null;
    Uri? nextUri = null;
    var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
    using var http = _httpFactory.CreateClient("github");

    var page = 0;
    for (; page < MaxReviewPages; page++)
    {
        using var req = nextUri is null
            ? new HttpRequestMessage(HttpMethod.Get, initialUrl)
            : new HttpRequestMessage(HttpMethod.Get, nextUri);
        if (!string.IsNullOrEmpty(token))
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        req.Headers.UserAgent.ParseAdd("PRism/0.1");
        req.Headers.Accept.ParseAdd("application/vnd.github+json");

        using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return best;
        if (resp.StatusCode == HttpStatusCode.TooManyRequests)
            throw new RateLimitExceededException(
                "GitHub rate-limited (429); orchestrator should skip this tick.",
                resp.Headers.RetryAfter?.Delta);
        resp.EnsureSuccessStatusCode();

        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(body);
        foreach (var review in doc.RootElement.EnumerateArray())
        {
            try
            {
                var login = review.GetProperty("user").GetProperty("login").GetString();
                if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
                var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
                if (sha != null) best = sha; // ascending order → last seen overall = most recent
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
            }
        }

        nextUri = GitHubLinkHeader.TryGetNext(resp);
        if (nextUri is null) break;
    }

    if (page >= MaxReviewPages && nextUri is not null)
        Log.ReviewPagesCapped(_log, pr.Owner, pr.Repo, pr.Number, MaxReviewPages);

    return best;
}
```

**ILogger:** mark the class `sealed partial` (required to host a source-gen `Log` class, as
`GitHubSectionQueryRunner` already does); add `ILogger<GitHubAwaitingAuthorFilter>? log = null` to the
ctor (defaulting to `NullLogger`, mirroring `GitHubSectionQueryRunner`), a `Log` `LoggerMessage`
partial class with `ReviewPagesCapped` (Warning) and `ReviewItemSkipped` (Debug), store
`_log = log ?? NullLogger<GitHubAwaitingAuthorFilter>.Instance`, and pass the logger from DI.

**Files:** Create `GitHubLinkHeader.cs`. Edit `GitHubAwaitingAuthorFilter.cs`,
`GitHubCiFailingDetector.cs` (swap to shared helper), `ServiceCollectionExtensions.cs` (pass logger).

**Tests:**
- Two-page reviews fixture where the most-recent viewer review is on page 2 with a different
  `commit_id`; assert the walk returns the page-2 SHA (the bug returns the page-1 SHA).
- `rel="next"` absent → single fetch, returns page-1 best.
- Cap hit: a fixture that always returns a `rel="next"` → loop stops at `MaxReviewPages`, returns best
  so far, and logs the capped warning (assert via a capturing `ILogger`).

---

## Unit U3 — Typed REST contract exception (AC3)

**Decision:** introduce `GitHubRestContractException : Exception` in `PRism.GitHub`, mirroring
`GitHubGraphQLException`, and replace the four `HttpRequestException(…, statusCode: HttpStatusCode.OK)`
throws (malformed 2xx missing `id`/`created_at`). Real non-2xx responses keep throwing
`HttpRequestException` with the genuine `resp.StatusCode`. This separates "transport failed" from
"the 2xx body broke its contract."

**New type** — `PRism.GitHub/GitHubRestContractException.cs`:

```csharp
namespace PRism.GitHub;

/// <summary>
/// Thrown when a GitHub REST endpoint returns a 2xx whose body violates the
/// expected contract (e.g. a created-comment response missing 'id' or 'created_at').
/// Distinguishes "transport succeeded but the payload is malformed" from a genuine
/// non-2xx transport failure (HttpRequestException). Mirrors GitHubGraphQLException,
/// which plays the same role for 200-with-errors GraphQL responses. (#322)
/// </summary>
public sealed class GitHubRestContractException : Exception
{
    public GitHubRestContractException()
        : base("GitHub REST response violated its expected contract.") { }

    public GitHubRestContractException(string message) : base(message) { }

    public GitHubRestContractException(string message, Exception innerException)
        : base(message, innerException) { }
}
```

**Replacements (4 sites):**
- `GitHubReviewService.ReviewComments.cs:52` — missing `'id'` → `throw new GitHubRestContractException("GitHub review comment response missing 'id'.");`
- `GitHubReviewService.ReviewComments.cs:55` — missing `'created_at'` → likewise.
- `GitHubReviewService.IssueComments.cs:73` — missing `'id' field` → likewise.
- `GitHubReviewService.IssueComments.cs:78` — missing `'created_at'` → likewise.

After the change `HttpStatusCode.OK` is no longer referenced in either file; remove the now-unused
`using System.Net;` from both. (`resp.StatusCode` on the genuine-error throws is a property value, not
a namespace reference.)

**Caller impact (verified, behaviour-equivalent):**
- `PrCommentEndpoints` wraps `CreateReviewCommentAsync` in `catch (HttpRequestException) → GitHubError`
  then a catch-all `catch (Exception) → GitHubError`. The new typed exception falls to the catch-all →
  same `GitHubError` response.
- `PrRootCommentEndpoints` wraps `CreateIssueCommentAsync` in `catch (HttpRequestException) → 502
  MapGithubError` then `catch (Exception) → 502 "github-network-error"`. The new typed exception falls
  to the catch-all → still a 502. (Arguably more correct: a malformed-2xx is genuinely not a mapped
  GitHub status error.)

No caller branches on `HttpRequestException.StatusCode == OK`, so nothing depended on the old shape.

**Files:** Create `GitHubRestContractException.cs`. Edit `GitHubReviewService.ReviewComments.cs`,
`GitHubReviewService.IssueComments.cs`.

**Tests:**
- A 2xx response missing `id` from `CreateReviewCommentAsync` throws `GitHubRestContractException`
  (not `HttpRequestException`). Same for missing `created_at`.
- Same two for `CreateIssueCommentAsync`.
- A genuine non-2xx (e.g. 422) still throws `HttpRequestException` with `StatusCode == 422` (regression
  guard that the real-error path is untouched).

---

## Unit U4 — Per-item JSON isolation (AC4)

**Decision:** wrap per-item / per-PR JSON mapping in a try/catch that skips the malformed item,
catching only the JSON-shape exception set (so transient HTTP errors and rate-limit/cancellation still
propagate and abort the tick as before). A shared guard keeps the predicate consistent across sites.

**Shared guard** — `PRism.GitHub/Inbox/InboxJsonGuard.cs`:

```csharp
using System.Text.Json;

namespace PRism.GitHub.Inbox;

/// <summary>
/// True for the exception set that signals a single malformed JSON item (a missing
/// property, a wrong value kind, an unparseable timestamp, or a non-JSON body) — as
/// opposed to a transport failure, cancellation, or rate-limit, which must still
/// propagate and abort the tick. Used to isolate one poisoned inbox item from the
/// rest of the batch. (#322)
/// </summary>
internal static class InboxJsonGuard
{
    public static bool IsMalformedItem(Exception ex) =>
        ex is KeyNotFoundException     // GetProperty on a missing key
           or InvalidOperationException // wrong JsonValueKind (GetString/GetInt32/EnumerateArray)
           or FormatException           // GetDateTimeOffset on a bad string
           or JsonException;            // JsonDocument.Parse on a non-JSON body
}
```

`OperationCanceledException` and `RateLimitExceededException` are deliberately absent → they propagate.

**Site 4a — `GitHubSectionQueryRunner.SearchAsync`** (the `items[]` foreach): wrap the per-item
mapping body in `try { … result.Add(…); } catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex)) { Log.ItemSkipped(_log, ex, …); continue; }`.
The section-level `JsonDocument.Parse(body)` stays outside the loop — a non-JSON *search* response is
a section-level failure already isolated by `QueryAllAsync`'s per-section catch. Add an `ItemSkipped`
(Debug) `LoggerMessage`.

**Site 4b — `GitHubPrEnricher.FetchAsync`:** the HTTP send + `EnsureSuccessStatusCode()` + body read
stay outside any new try (transient HTTP errors must still propagate to abort the tick). Wrap from
`JsonDocument.Parse(body)` through the `return raw with { … }` in
`try { … } catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex)) { return null; }` so a
malformed PR detail skips that PR (the enricher already drops nulls). Add a skip log.

**Site 4c — `GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync`:** per-review-item try/catch inside
the page loop (shown in U2). One malformed review is skipped; the scan continues.

**Files:** Create `Inbox/InboxJsonGuard.cs`. Edit `GitHubSectionQueryRunner.cs`, `GitHubPrEnricher.cs`,
`GitHubAwaitingAuthorFilter.cs`.

**Tests:**
- `SearchAsync`: a fixture whose `items[]` has one good entry and one missing `pull_request`/`title`
  → returns the one good item (not empty, not throw).
- `EnrichAsync`: a batch of two PRs where one PR-detail response is missing `head` → the other PR is
  still enriched and returned; the poisoned one is dropped.
- Regression: a 5xx from one PR-detail still propagates (does **not** get swallowed by the JSON guard).

---

## Unit U5 — Terminal CI TTL via injected clock (AC5, folded #361)

**Decision:** inject the existing (currently DI-unwired) `PRism.Core.Time.IClock`, stamp each cache
entry with `CachedAtUtc`, and treat a cached entry older than **`TerminalTtl = 2 minutes`** as a miss
on a non-forced read. So a same-SHA "Re-run failed jobs" auto-recovers within one TTL window without a
manual Refresh. `Pending` is already never cached (#355); the TTL governs the terminal
`Passing`/`Failing`/`None` entries uniformly. The 2-minute value was chosen as the user-approved
balance — short enough that auto-recovery feels prompt against the background sweep cadence, long
enough to avoid re-probing every terminal PR each tick.

**Cache shape change** in `GitHubCiFailingDetector`:

```csharp
private readonly record struct CacheEntry(CiStatus Status, DateTime CachedAtUtc);
private static readonly TimeSpan TerminalTtl = TimeSpan.FromMinutes(2);
private readonly ConcurrentDictionary<(PrReference, string), CacheEntry> _cache = new();
private readonly IClock _clock;
```

**Ctor:** `GitHubCiFailingDetector(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, IClock clock)` — store `_clock = clock`.

**Read path** (replaces the current `TryGetValue` hit):
```csharp
if (!forceReprobe
    && _cache.TryGetValue(key, out var entry)
    && _clock.UtcNow - entry.CachedAtUtc <= TerminalTtl)
    return (Item: c, Ci: entry.Status, Degraded: false);
```
An expired entry (or a forced reprobe) falls through to `ProbeAsync` exactly like a miss.

**Write path:** `_cache[key] = new CacheEntry(ci, _clock.UtcNow);` (the `!degraded && ci != Pending`
guard is unchanged). The forced-Pending eviction `_cache.TryRemove(key, out _)` is unchanged (value
type is irrelevant to removal).

**DI** — `ServiceCollectionExtensions.AddPrismGitHub`:
```csharp
services.TryAddSingleton<IClock, SystemClock>();   // PRism.Core.Time; Microsoft.Extensions.DependencyInjection.Extensions
...
services.AddSingleton<ICiFailingDetector>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubCiFailingDetector(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        sp.GetRequiredService<IClock>());
});
```
`TryAddSingleton` is used defensively so a future composition-root registration of `IClock` (e.g. for
the active-PR poller) does not collide.

**Interaction with U1:** U1's eviction prunes absent-`PrReference` keys regardless of the value type;
U5's per-entry timestamp lives in that value. One cache-shape change (`CiStatus` → `CacheEntry`) serves
U5, and U1's prune operates on keys — no conflict.

**Files:** Edit `GitHubCiFailingDetector.cs`, `ServiceCollectionExtensions.cs`.

**Test clock:** the existing `TestClock` lives in `tests/PRism.Core.Tests/TestHelpers`; the GitHub test
project should not take a cross-test-project dependency for it. Add a minimal mutable clock local to the
GitHub test project (or reuse one if it already exists — verify first):
```csharp
internal sealed class MutableClock : IClock { public DateTime UtcNow { get; set; } = new(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc); }
```

**Tests:**
- Cache a terminal `Failing`; a second non-forced `DetectAsync` within the TTL returns the cached value
  **without** re-probing (probe double asserts zero second call).
- Advance the clock past `TerminalTtl`; the next non-forced `DetectAsync` **re-probes** and reflects the
  fresh status (e.g. `Pending` after a same-SHA re-run) — the #361 auto-recovery.
- A forced reprobe still bypasses the cache regardless of TTL (regression guard for #355).

---

## Risks & dependencies

- **Behavioural change in the awaiting-author filter (U2).** Correcting pagination changes which PRs
  the filter keeps for PRs with >100 reviews. This is the intended fix; covered by the two-page test.
  PRs with ≤100 reviews are unaffected (single page, same result).
- **TTL probe-cost (U5).** A 2-minute TTL means each terminal PR re-probes at most once per 2 minutes
  per session — negligible against the existing per-tick check-runs/status calls, and bounded by inbox
  size. No rate-limit concern at realistic inbox sizes.
- **Exception-type change reaching an unknown catch (U3).** Mitigated: both call sites have a catch-all
  after the `HttpRequestException` catch; verified behaviour-equivalent. A repo-wide search for
  `catch (HttpRequestException` consumers of these methods is part of the plan's pre-PR check.
- **Shared `IClock` registration (U5).** `TryAddSingleton` avoids a double-registration collision if a
  later change wires `IClock` at the composition root.

## Testing strategy

- Unit tests per unit as listed, in `PRism.GitHub.Tests` (the GitHub test project already has
  `InternalsVisibleTo` for internal types). Use the project's existing `HttpClient` fake/handler
  pattern (capturing handler returning canned responses + Link headers) — verify the pattern before
  writing.
- No e2e/visual baselines: this is provider-internal with no UI surface.
- Full backend suite (`dotnet test`) green before PR; full pre-push checklist per
  `.ai/docs/development-process.md`.

## Out of scope (tracked elsewhere)

- CI classification refinements — superseded runs, `action_required` modelling (#305).
- Any change to the atomic-submit GraphQL pipeline (intentionally untouched; B2 surface).

## Proof (to be filled at PR time)

- Per-AC verification (test names + results).
- `ce-doc-review` dispositions for this spec (2×) and the plan (2×).
- Confirmation finding #3 stayed off the B2 atomic-submit surface.
- Full backend suite result.

**Closes #322 and #361.**
