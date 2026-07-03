# GitHub activity-reader pagination + cap signal — design

**Issues:** #628 Slice 1 (shared pagination helper — the first of the three #628 capabilities) and #604 Part E (P1 silent-truncation of single-page activity reads). Date: 2026-07-03.

## Problem

The three GitHub "activity readers" each issue a **single** `per_page=100` request and never follow `Link rel="next"`:

- `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs` — `users/{login}/received_events?per_page=100`
- `PRism.GitHub/Activity/GitHubNotificationsReader.cs` — `notifications?all=true&since=…&per_page=100`
- `PRism.GitHub/Activity/GitHubWatchedReposReader.cs` — `user/subscriptions?per_page=100`

All three delegate the fetch to the shared static `GitHubArrayReader.ReadAsync<T>(httpFactory, readToken, url, parse, ct)` (`PRism.GitHub/GitHubArrayReader.cs:24`), which makes exactly one request and returns `(IReadOnlyList<T> Items, bool Degraded)`. It does not read the `Link` header at all.

`user/subscriptions` routinely exceeds 100 entries for active users. The watched-repo set therefore **silently truncates past page 1**: `ActivityProvider.GetActivityAsync` (`PRism.Core/Activity/ActivityProvider.cs:111`) feeds `wt.Repos` into `ActivityFeedBuilder.BuildWatching` (`ActivityFeedBuilder.cs:263`), which emits a row per watched repo. A repo on page 2+ never enters the list, so it silently vanishes from the activity feed — a false "not watched" negative with **no** `Degraded`/`Capped` signal (`Degraded` is only set on transport/parse failure). This is #604 Part E, a P1 correctness defect deferred from #604 (closed via PR #641) to be fixed on top of #628's generalized pagination mechanism.

## Decision summary

Add pagination at the single choke point (`GitHubArrayReader.ReadAsync`) by following `Link rel="next"` via the existing `GitHubLinkHeader.TryGetRel` parser, bounded by a max-page budget. On hitting the budget while `rel="next"` is still advertised, emit a structured **log warning** (the "cap signal" #628 criterion 1 asks for). No change to the reader result records, `ActivityProvider`, or the `/api/activity` wire shape.

**Cap-signal surfacing: log-only in the helper.** Chosen over threading a `Capped` flag onto the result structs or the wire. Full pagination alone fixes the P1; the page-budget cap is a rare guard (fires only when a list exceeds the budget). A structured operator log is a proportionate signal. User-facing surfacing of a cap is filed as a follow-up if a real need appears.

## Design

### 1. `GitHubArrayReader.ReadAsync` — the pagination choke point

New optional trailing parameters (keep existing callers/tests source-compatible):

```csharp
public static async Task<(IReadOnlyList<T> Items, bool Degraded)> ReadAsync<T>(
    IHttpClientFactory httpFactory,
    Func<Task<string?>> readToken,
    string url,
    Func<JsonElement, T?> parse,
    CancellationToken ct,
    ILogger? logger = null,
    string? resource = null,
    int maxPages = DefaultMaxPages) where T : class
```

Restructure so the accumulator `list` is declared **outside** the `try` (so the catch can return partial results):

- Read token once; `using var http = httpFactory.CreateClient("github")`.
- `var currentUrl = url; var page = 0;`
- Loop:
  - `page++`; `using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, currentUrl, token, ct)`.
  - `if (!resp.IsSuccessStatusCode) return (list, true);` — degraded. (Page-1 failure ⇒ empty+degraded, unchanged contract; a later-page failure ⇒ **partial items + degraded**.)
  - Parse the stream/document; `if (root.ValueKind != JsonValueKind.Array) return (list, true);`.
  - Append parsed items to `list`.
  - `if (GitHubLinkHeader.TryGetRel(resp, "next", out var next))`:
    - `if (page >= maxPages)` → emit the cap-hit log warning (see below); **break** (stop following). Items are complete-to-budget; `degraded` stays `false`.
    - else `currentUrl = next; continue;` — `next` is the **absolute** URL from the Link header, passed **as-is** (never stripped to relative — stripping would double-prefix the GHES `…/api/v3` base; see the `github_link_pagination_ghes_double_prefix` learning).
  - else **break** (`rel="next"` absent ⇒ list exhausted).
- `return (list, false);`
- `catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }` — genuine cancellation propagates (unchanged).
- `catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException) { return (list, true); }` — now partial-aware (returns items accumulated before the fault).

**Egress-guard interaction (verified).** The absolute `rel="next"` URL flows through `GitHubHttp.SendAsync` → `ApplyHeaders` (`GitHubHttp.cs:28`), whose credential guard requires an absolute request URI to match the client `BaseAddress` on scheme + host + port, else throws `HttpRequestException`. GitHub's `next` URL is same-host and same-scheme (api.github.com, or the GHES `{host}/api/v3/` base resolved by `HostUrlResolver.ApiBase`), so the guard attaches the PAT normally. A hypothetical off-host `next` throws `HttpRequestException`, which the catch filter already degrades — fail-closed, no PAT leak.

**Budget.** `const int DefaultMaxPages = 10` ⇒ a 1000-item ceiling at `per_page=100`, bounding the worst case to 10 sequential requests per read. `received_events` is GitHub-capped at ~300 events, so it never reaches the budget; `notifications` and `user/subscriptions` above 1000 are rare, which is why the cap is a guard, not an expected path.

**Cap-hit log.** A `LoggerMessage.Define`-backed static delegate (allocation-free, mirroring the `Log.TimelineCapHit` precedent in `GitHubReviewService.cs:142`). `LogLevel.Warning`, structured fields `Resource` and `MaxPages`, message to the effect of: "GitHub list read for {Resource} hit the {MaxPages}-page pagination budget; results may be truncated." No-op when `logger` is null or the budget is not reached.

### 2. The three readers inject `ILogger` and pass `(logger, resource)`

Each reader gains a constructor `ILogger<TReader>` and forwards it plus a resource label to `ReadAsync`:

- `GitHubReceivedEventsReader` → `resource: "received_events"`
- `GitHubNotificationsReader` → `resource: "notifications"`
- `GitHubWatchedReposReader` → `resource: "user/subscriptions"`

DI construction lambdas in `PRism.GitHub/ServiceCollectionExtensions.cs` (currently lines ~183 / ~197 / ~206) add `sp.GetRequiredService<ILogger<…>>()`. The readers' public `ReadAsync` signatures and their result records (`ReceivedEventsResult`, `NotificationsResult`, `WatchedReposResult`) are **unchanged**.

### 3. Net effect

`user/subscriptions` is read to completion, so `ActivityFeedBuilder.BuildWatching` sees every watched repo and the P1 false-negative-past-page-1 truncation is eliminated. No change to result structs, `ActivityProvider`, `ActivityContracts`, `ActivityEndpoints`, `FakeActivityProvider`, or the `/api/activity` wire.

## Testing

New `GitHubArrayReader` multi-page tests (drive with the existing `tests/PRism.GitHub.Tests/TestHelpers/PaginatedFakeHandler.cs`, which auto-emits `Link rel="next"` for non-last pages and 500s on over-call, and `CapturingLogger.cs`):

1. **Follows `next` across pages and concatenates** — 3 scripted pages ⇒ all items returned, `CallCountFor` == 3, `degraded:false`.
2. **Stops at the max-page budget and logs** — handler always advertises `next`, small `maxPages` ⇒ exactly `maxPages` requests, `maxPages × pageSize` items, one `Warning` captured with the resource + budget fields, `degraded:false`.
3. **Later-page failure ⇒ partial + degraded** — page 1 succeeds, page 2 returns 500 ⇒ page-1 items returned, `degraded:true`.
4. **Off-host `next` ⇒ degraded** — a `Link` whose `next` points off-host ⇒ `ApplyHeaders` throws `HttpRequestException` ⇒ partial + `degraded:true` (locks the egress-guard interaction).
5. **Single page / no `next` ⇒ unchanged** — existing single-request behavior.

Preserve unchanged: existing `GitHubArrayReaderTests` degrade/cancel cases (`Faults_degrade`, `Malformed_json_degrades`, `Non_array_root_degrades`, `Genuine_cancellation_propagates`) — all page-1 paths.

Reader + integration level:
- One reader-level full-pagination test (e.g. `GitHubWatchedReposReader` across ≥2 pages via `PaginatedFakeHandler`) proving the #604 Part E fix end-to-end (all watched repos present).
- `GitHubActivityReadersAuthHeaderTests` continues to pass — assert the Bearer header is attached on **every** page request, not just the first.
- Existing reader tests updated only to pass a logger (`NullLogger<T>.Instance` or `CapturingLogger`) to the new constructor param.

## Out of scope (deferred)

- ETag / `If-None-Match` / `304` on the poll path — #628 Slice 2.
- Secondary rate-limit (`403` + `Retry-After`) handling distinct from 429/auth-fail — #628 Slice 3.
- `FetchPagedCountAsync` `rel="last"` generalization (`GitHubReviewService.cs:381`) — #604 Part D, already documented as `per_page==1`-asserted; not needed here.
- Any `Capped` flag on the result structs / `ActivityResponse` / the wire, and any frontend surfacing — filed as a follow-up if a user-facing need appears.

## Risks

- **Sequential request fan-out.** Pagination turns one request into up to `maxPages` sequential requests for large lists. Bounded by the budget; only triggered by genuinely large lists that were previously being silently truncated (i.e. the extra requests are the correctness fix, not waste).
- **Partial-on-later-failure semantics.** A mid-pagination fault now returns partial data flagged `degraded:true` rather than empty. This is strictly more information than the old single-page path and consistent with degrade-don't-throw; consumers already treat `degraded` as "trust this read less."
