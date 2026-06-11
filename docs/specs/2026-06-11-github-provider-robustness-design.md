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
    InboxJsonGuard.cs            (NEW) shared JSON-shape exception predicate (per-item isolation)
    GitHubCiFailingDetector.cs   (EDIT) IClock + per-entry timestamp + TTL; eviction; use GitHubLinkHeader
    GitHubPrEnricher.cs          (EDIT) eviction; per-PR JSON isolation
    GitHubAwaitingAuthorFilter.cs(EDIT) eviction; Link-walk reviews; per-item JSON isolation; ILogger
    GitHubSectionQueryRunner.cs  (EDIT) per-item JSON isolation in SearchAsync
  ServiceCollectionExtensions.cs (EDIT) register IClock→SystemClock; pass IClock + ILogger
  GitHubReviewService.ReviewComments.cs (EDIT) 2× throw → GitHubRestContractException
  GitHubReviewService.IssueComments.cs  (EDIT) 2× throw → GitHubRestContractException
```

**Multi-unit files.** Two files are touched by more than one unit — coordinate the edits into a single
change per file rather than two passes:
- `GitHubAwaitingAuthorFilter.cs` — U1 (eviction), U2 (Link-walk + ILogger), U4 (per-item JSON guard).
- `GitHubCiFailingDetector.cs` — U1 (eviction), U2 (swap to shared `GitHubLinkHeader`), U5 (IClock + TTL).
  The `IClock` ctor parameter is introduced by U5; U1's eviction call needs no ctor change.

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
- On the empty-items early return, replace `return …;` with `{ _cache.Clear(); return …; }`. The guard
  variable differs by class: `GitHubPrEnricher`/`GitHubCiFailingDetector` use `if (items.Count == 0)`;
  `GitHubAwaitingAuthorFilter` uses `if (candidates.Count == 0)` — patch *that* line in the filter, not
  an `items`-named one.
- After `Task.WhenAll(...)`, before building the result, compute the live set and prune:
  ```csharp
  InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
  ```
  (Filter uses `candidates`; detector uses `items`.)

**Files:** Create `Inbox/InboxCacheEviction.cs`. Edit `GitHubPrEnricher.cs`,
`GitHubAwaitingAuthorFilter.cs`, `GitHubCiFailingDetector.cs`.

**Tests** (one per class, in the respective `*Tests`):
- **Eviction is only observable on re-inclusion** — a PR absent from a tick is never entered into the
  reader's loop, so a 2-tick test cannot distinguish "evicted" from "never re-queried." Use a **3-tick**
  sequence with a request-counting probe double (the filter/detector tests already count requests via the
  fake handler):
  1. Tick 1 with PRs {A, B} → both probed once (2 requests), cache populated.
  2. Tick 2 with {A} only → A served from cache (0 new requests); the prune evicts B's key.
  3. Tick 3 with {A, B} again → A still cached (0 new request for A), **B re-probed** (1 new request).
     B's re-probe in tick 3 is the proof that tick 2 evicted it; without eviction B would still be cached.
  Hold each PR's second key component **constant across ticks** (`UpdatedAt` for the enricher, `HeadSha`
  for filter/detector) so a re-probe can only be explained by eviction, not by a changed cache key.
- Empty-items tick clears a previously-populated cache: populate via tick 1 {A}, then an empty tick, then
  tick {A} again → A re-probed (proving `Clear()` ran).
- If a behavioural assert is impractical for a given class, fall back to an `internal` count accessor
  guarded by `InternalsVisibleTo` (the GitHub test project already has access) rather than reflection.
- **For the CI detector specifically, the eviction test must use the default frozen clock — do NOT advance
  it.** With the clock frozen, tick-3's B re-probe is attributable to eviction alone; advancing past
  `TerminalTtl` (U5) would make the re-probe ambiguous (eviction vs TTL expiry) and could flip A's tick-2
  cache hit to a miss, silently weakening the eviction proof into a tautology.

---

## Unit U2 — Correct reviews pagination (AC2)

**Decision:** Link-walk `FetchLastReviewShaAsync` exactly as `FetchChecksAsync` already does — follow
`rel="next"` to the last page, keeping the last viewer-authored `commit_id` seen across **all** pages
(ascending order means the last one overall is the most recent). Cap at `MaxReviewPages = 10`
(mirrors `MaxCheckRunPages`); if the cap is hit with more pages pending, **log a warning** so the
truncation is explicit, never silent. To reuse the existing Link parser instead of copy-pasting it,
extract it into a shared helper.

**Scope of this fix — pagination only (known residual).** U2 corrects *which pages are read*; it does
**not** change *which review is selected* within the pages. The retained selection rule
(`if (sha != null) best = sha`) carries two pre-existing properties this unit deliberately does not
re-open:
- **Null `commit_id` on the latest review.** A viewer review with `commit_id: null` (e.g. a still-PENDING
  review) is skipped, so `best` falls back to the most recent *non-null* review SHA. This is the existing
  behavior and is arguably correct (an unsubmitted review has no head to compare against), but it means
  "last non-null viewer `commit_id`" is not strictly "the latest viewer review." Selection semantics are
  **out of scope** for AC2 (pagination) and are tracked as a follow-up issue; do not change them here.
- **Ordering is empirical.** "Last in the array = most recent" relies on GitHub returning reviews in
  ascending order, which the endpoint does not document as a contract (no `sort`/`direction` params). In
  practice the order is by monotonic review `id`; the page-cap warning is the safety net. The existing
  CI-detector walk relies on the same Link-following assumption, so this introduces no new risk.

So the AC2 claim is precisely "pagination is correct (Link-walk) — never silently wrong-shaped," not
"review selection is now provably correct." The Problem statement's "can mis-classify" is resolved *for
the >100-review case*; the null-`commit_id` selection edge is a separate, pre-existing concern.

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
- **Endpoint behavior-equivalence (locks the caller-impact claim).** Drive the endpoint handler, not just
  the service method: with a faked `IReviewSubmitter` whose `CreateReviewCommentAsync` throws
  `GitHubRestContractException`, assert `PrCommentEndpoints` returns the same response shape/status the old
  `HttpRequestException(OK)` produced (`github-network-error` / its mapped status). Repeat for
  `PrRootCommentEndpoints` + `CreateIssueCommentAsync` (502). This converts the "pre-PR grep" check into an
  executable regression so a future catch-block change can't silently break the contract. Also run the grep
  (`catch (HttpRequestException`) across the solution and record the consumer set in `## Proof`.

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
           or FormatException           // parse failures, e.g. GetDateTimeOffset on a bad string
           or JsonException;            // JsonDocument.Parse on a non-JSON body
}
```

`OperationCanceledException` and `RateLimitExceededException` are deliberately absent → they propagate.

**Body-level vs item-level failures (intentional boundary).** Only *item* mapping is wrapped. A
*body-level* shape failure — `JsonDocument.Parse` on a non-JSON body, or `EnumerateArray()` on a 2xx body
that is a JSON object rather than an array — stays **outside** the per-item try and propagates, isolated
one level up (the section's per-section catch, or the per-PR path). That is deliberate: a whole-response
shape failure is not "one poisoned item," and treating it as one would silently blank a response that is
genuinely malformed at the top level.

**Site 4a — `GitHubSectionQueryRunner.SearchAsync`** (the `items[]` foreach): wrap the per-item
mapping body in `try { … result.Add(…); } catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex)) { Log.ItemSkipped(_log, ex); continue; }`.
The section-level `JsonDocument.Parse(body)` and `items[]` `EnumerateArray()` stay outside the loop — a
non-JSON/non-array *search* response is a section-level failure already isolated by `QueryAllAsync`'s
per-section catch. Add an `ItemSkipped(ILogger, Exception)` (Debug) `LoggerMessage` (the exception
message carries the offending key/kind — no extra context needed for a Debug line; the runner already
has `_log`).

**Site 4b — `GitHubPrEnricher.FetchAsync`:** the HTTP send + `EnsureSuccessStatusCode()` + body read
stay outside any new try (transient HTTP errors must still propagate to abort the tick). Wrap from
`JsonDocument.Parse(body)` through the `return raw with { … }` in
`try { … } catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex)) { return null; }` so a
malformed PR detail skips that PR. **No log is added** — the enricher has no `ILogger` today, and adding
one (ctor + `partial` + DI) for a Debug line is out of scope; a silent `null`-drop matches the enricher's
existing behavior on a 404 (it already returns `null` and the caller drops it). Observability can be a
trivial follow-up if wanted.

**Site 4c — `GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync`:** per-review-item try/catch inside
the page loop (shown in U2, logging `Log.ReviewItemSkipped`). One malformed review is skipped; the scan
continues. The page-level `JsonDocument.Parse`/`EnumerateArray()` stay outside the per-item try per the
boundary above.

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

**Files:** Edit `GitHubCiFailingDetector.cs`, `ServiceCollectionExtensions.cs`, **and the detector test
file(s)** — making `IClock` a required ctor param breaks every existing 2-arg construction. The detector
tests build the SUT through a `BuildSut(handler)` helper referenced ~37×; update that **single** helper to
thread a clock (one edit fixes all call sites), e.g.:
```csharp
private static GitHubCiFailingDetector BuildSut(FakeHttpMessageHandler handler, IClock? clock = null) =>
    new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
        () => Task.FromResult<string?>("t"),
        clock ?? new MutableClock());
```
Keep the existing two-arg `FakeHttpClientFactory(handler, new Uri(...))` shape (the sibling
enricher/filter/section-runner `BuildSut` helpers all pass the same base address — a one-arg call does not
compile). TTL tests pass an explicit `MutableClock` they advance; all existing tests get the **frozen**
default `MutableClock` (fixed at `2026-06-11T12:00:00`, never advancing) and keep compiling. **The default
must be the frozen `MutableClock`, not `SystemClock`** — every existing cache-hit assertion (a second
`DetectAsync` on the same key serving from cache) holds only because `UtcNow − CachedAtUtc == 0 ≤ TerminalTtl`
under the frozen clock; a wall-clock `SystemClock` default would couple those tests to real time. (The
required-param ctor shape is kept deliberately over an `IClock? clock = null` default-to-`new SystemClock()`
ctor overload — a required param keeps the DI contract explicit and avoids a hidden production default; the
cost is the one-line `BuildSut` edit above.)

**Test clock:** the existing `TestClock` lives in `tests/PRism.Core.Tests/TestHelpers`; the GitHub test
project references `PRism.Core` but **not** `PRism.Core.Tests`, so `TestClock` is inaccessible without a new
cross-test-project reference (which we avoid). Add a minimal mutable clock local to the GitHub test project
(or reuse one if it already exists — verify first):
```csharp
namespace PRism.GitHub.Tests;

internal sealed class MutableClock : IClock
{
    public DateTime UtcNow { get; set; } = new(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc);
    public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);   // TTL tests advance past TerminalTtl
}
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
- **U2 selection residual (out of scope, tracked).** U2 fixes pagination, not review *selection*: a
  null-`commit_id` latest review still resolves to the prior non-null SHA, and the ascending-order
  assumption is empirical, not a documented contract (see U2 "Scope of this fix"). No new risk vs today's
  behavior; deferred to #367 rather than expanded into this slice.
- **TTL probe-cost (U5).** A 2-minute TTL means each terminal PR re-probes at most once per 2 minutes
  per session — negligible against the existing per-tick check-runs/status calls, and bounded by inbox
  size. No rate-limit concern at realistic inbox sizes.
- **Exception-type change reaching an unknown catch (U3).** Mitigated three ways: both call sites have a
  catch-all after the `HttpRequestException` catch (verified behaviour-equivalent); an endpoint-level
  behavior-equivalence test (U3 Tests) locks the response shape; and a repo-wide `catch (HttpRequestException`
  grep at pre-PR records the full consumer set in `## Proof`.
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
- **Reviews-selection semantics** (#367) — null-`commit_id` "latest review" handling and a
  sort-order-robust selection (max `submitted_at` instead of array position). U2 corrects pagination only.

## Proof (to be filled at PR time)

- Per-AC verification (test names + results).
- `ce-doc-review` dispositions for this spec (2×) and the plan (2×).
- Confirmation finding #3 stayed off the B2 atomic-submit surface.
- Full backend suite result.

**Closes #322 and #361.**
