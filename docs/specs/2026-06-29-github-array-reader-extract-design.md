# Extract the degrade-don't-throw JSON-array reader (issue #665, sub-task 2)

- **Status:** approved (T2, hands-off; machine `ce-doc-review` substitutes for the human spec gate per the issue-resolution workflow)
- **Issue:** [#665](https://github.com/prpande/PRism/issues/665) — sub-task 2 of 3
- **Tier / Risk:** T2 / hands-off (pure read-path transport refactor; no B2 surface)
- **Date:** 2026-06-29

## Problem

Three sibling readers in `PRism.GitHub/Activity/` physically copy the same
"degrade-don't-throw" GitHub-array-fetch skeleton. Each was created 2026-06-19 and
each carries a "Mirrors `<sibling>`" comment (ReceivedEvents mirrors
`GitHubCiFailingDetector`; Notifications mirrors ReceivedEvents; WatchedRepos
mirrors Notifications) — a copy chain:

- `GitHubReceivedEventsReader.cs:30-66`
- `GitHubNotificationsReader.cs:28-51`
- `GitHubWatchedReposReader.cs:25-48`

The copied skeleton is, verbatim across all three:

1. `using var http = _httpFactory.CreateClient("github")`
2. `using var resp = await GitHubHttp.SendAsync(http, Get, url, token, ct)`
3. `if (!resp.IsSuccessStatusCode) return (empty, Degraded: true)`
4. `using var stream = await resp.Content.ReadAsStreamAsync(ct)`
5. `using var doc = await JsonDocument.ParseAsync(stream, ct)`
6. `if (RootElement.ValueKind != Array) return (empty, Degraded: true)`
7. `foreach element → parse → collect non-null`
8. `catch (OperationCanceledException) when (ct.IsCancellationRequested) throw` (genuine cancel propagates)
9. `catch (HttpRequestException or JsonException or TaskCanceledException) → (empty, Degraded: true)`

Only two things vary per reader: **the request URL** and **the per-element parse
delegate**. The duplication means the degrade contract (steps 3/6/8/9) is
maintained in triplicate and can silently drift on the next edit.

## Goal / acceptance criteria

- A single shared helper owns steps 1–9. Each `Activity/` reader collapses to
  "compute URL → call helper with a parse delegate → wrap the result".
- **No behavior change.** Every existing reader test stays green unchanged.
- Net LOC reduction; the degrade contract has exactly one home.
- The token-read continues to happen *inside* the guarded region (it is today —
  all three read the token inside the `try`), so a token-read fault still degrades
  rather than throwing.

## Design

New internal helper `PRism.GitHub/GitHubArrayReader.cs`:

```csharp
namespace PRism.GitHub;

internal static class GitHubArrayReader
{
    // Degrade-don't-throw GitHub JSON-array fetch shared by the Activity readers.
    // ANY non-success / transport fault / non-array root → (empty, Degraded: true);
    // genuine cancellation propagates. `parse` returns null to skip an element.
    public static async Task<(IReadOnlyList<T> Items, bool Degraded)> ReadAsync<T>(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string url,
        Func<JsonElement, T?> parse,
        CancellationToken ct) where T : class
    {
        try
        {
            var token = await readToken().ConfigureAwait(false);
            using var http = httpFactory.CreateClient("github");
            using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
            if (!resp.IsSuccessStatusCode) return ([], true);

            using var stream = await resp.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var doc = await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return ([], true);

            var list = new List<T>(doc.RootElement.GetArrayLength());
            foreach (var el in doc.RootElement.EnumerateArray())
                if (parse(el) is { } item) list.Add(item);
            return (list, false);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException)
        { return ([], true); }
    }
}
```

`where T : class` matches all three element types (`RawReceivedEvent`,
`RawNotification`, `string`) and makes the `is { } item` null-skip meaningful.

The `parse` delegate runs **inside** the helper's guarded region, so it must
never throw outside the catch filter (`HttpRequestException`, `JsonException`,
`TaskCanceledException`) — anything else (e.g. `OverflowException`) propagates and
breaks degrade-don't-throw. The helper's `parse` parameter carries a contract
comment naming that exact filter set, and each delegate keeps the discipline (the
Notifications delegate's `int.TryParse` is precisely this — see below). A pointer
comment in the Notifications delegate names the now-cross-file dependency so a
future editor doesn't switch to `int.Parse` without seeing the filter.

### Per-reader collapse

- **ReceivedEvents:** keeps its pre-flight `login` read + empty-login degrade
  *outside* the helper (unchanged), then `url = users/{login}/received_events?per_page=100`
  → helper with `Parse` → `new ReceivedEventsResult(items, degraded)`.
- **Notifications:** computes `sinceParam` + URL → helper with `Parse` →
  `new NotificationsResult(items, degraded)`. The `Parse` delegate keeps its
  `int.TryParse` (an `OverflowException` is deliberately **not** in the catch
  filter; `TryParse` avoids it — preserved verbatim).
- **WatchedRepos:** today inlines its element extraction; promote it to a private
  `static string? Parse(JsonElement)` → helper → `new WatchedReposResult(items, degraded)`.

## Why each variation is safe to leave outside the helper

- **`login` pre-flight (ReceivedEvents only):** an empty login is a caller concern,
  not a transport fault, and must short-circuit before any HTTP. Keeping it in the
  reader preserves exact behavior and keeps the helper single-purpose.
- **URL construction:** caller-specific (login / since / static path); passed in.
  This moves URL building from *inside* today's `try` to the caller, *outside* the
  helper's guarded region. Safe because the only exception it can raise
  (`ArgumentNullException` from `Uri.EscapeDataString`) was never in the catch
  filter — so even today it escapes uncaught; behavior is byte-identical.
- **Parse delegate:** caller-specific; the helper only enforces the array + skip-null
  contract.

## Testing

- **Regression guard:** the existing `GitHubReceivedEventsReaderTests`,
  `GitHubNotificationsReaderTests`, `GitHubWatchedReposReaderTests` run unchanged and
  must stay green — they prove the per-reader URL + parse behavior is preserved.
- **New `GitHubArrayReaderTests`** (the helper is now the single home of the degrade
  contract, so it gets a direct test) using the existing `FakeHttpClientFactory` /
  `FakeHttpMessageHandler.Returns` helpers:
  - parses a well-formed array (degraded:false, items projected via the delegate)
  - non-success status → (empty, degraded:true) — e.g. 403 and 429
  - malformed JSON body → (empty, degraded:true)
  - non-array root → (empty, degraded:true)
  - element where the parse delegate returns null → skipped, not degraded
  - cancelled token → `OperationCanceledException` propagates (no degrade)
  - **parse delegate throws an out-of-filter exception (`OverflowException`) →
    propagates (no degrade)** — pins the cross-file invariant the extraction
    introduces (the Notifications `int.TryParse` discipline)
  - **parse delegate throws an in-filter exception (`JsonException`) → degrades** —
    proves the filter still covers delegate-raised faults

## Out of scope / non-goals

- Sub-tasks #1 (aliased GraphQL batch) and #3 (check-runs/status pager) — separate PRs.
- No change to the readers' public interfaces, DI registration, URLs, or parse logic.
- No retry / pagination / ETag behavior added (that is #628's surface).
- Value-type element projections (e.g. an `int`-id array) are out of scope: the
  `where T : class` constraint would reject them and `is { }` would mean "always
  true" rather than "non-null". A future value-type reader adds a second `struct`
  overload (or a `(bool ok, T val)` parse shape) — a conscious deferral, not a gap.

## Rejected alternatives

- **Do nothing (keep the duplication):** rejected because the degrade contract is
  already live in three copies and proven to drift (all three were hand-copied from
  each other). The indirection the refactor adds (one delegate hop + the cross-file
  filter rationale noted above) is bounded and tested, and is outweighed by giving
  the contract a single maintained home. The rule-of-three is satisfied — this is
  dedup of existing duplication, not speculative generality.
- **A base class** (`abstract GitHubArrayReaderBase`): inheritance for a 9-line
  skeleton with two hooks is heavier than a static helper + delegate, and the three
  readers differ in constructor shape (ReceivedEvents takes a third `readLogin`
  delegate). A static helper composes without forcing a constructor contract.
- **Passing the `HttpResponseMessage` in / out:** would leak the `using` lifetime
  across the boundary and re-duplicate the status/stream handling at each call site.
  Keeping the whole guarded region in the helper is the point.
