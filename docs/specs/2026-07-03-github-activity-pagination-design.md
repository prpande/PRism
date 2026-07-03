# GitHub activity-reader pagination + cap signal — design

**Issues:** #628 Slice 1 (shared pagination helper — the first of the three #628 capabilities) and #604 Part E (P1 silent-truncation of single-page activity reads). Date: 2026-07-03.

## Problem

The three GitHub "activity readers" each issue a **single** `per_page=100` request and never follow `Link rel="next"`:

- `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs` — `users/{login}/received_events?per_page=100`
- `PRism.GitHub/Activity/GitHubNotificationsReader.cs` — `notifications?all=true&since=…&per_page=100`
- `PRism.GitHub/Activity/GitHubWatchedReposReader.cs` — `user/subscriptions?per_page=100`

All three delegate the fetch to the shared static `GitHubArrayReader.ReadAsync<T>(httpFactory, readToken, url, parse, ct)` (`PRism.GitHub/GitHubArrayReader.cs:24`), which makes exactly one request and returns `(IReadOnlyList<T> Items, bool Degraded)`. It does not read the `Link` header at all.

`user/subscriptions` routinely exceeds 100 entries for active users. The watched-repo set therefore **silently truncates past page 1**: `ActivityProvider.GetActivityAsync` (`PRism.Core/Activity/ActivityProvider.cs:111`) feeds `wt.Repos` into `ActivityFeedBuilder.BuildWatching` (`ActivityFeedBuilder.cs:263`), which emits a row per watched repo. A repo on page 2+ never enters the list, so it silently vanishes from the activity feed — a false "not watched" negative with **no** `Degraded` signal (`Degraded` is only set on transport/parse failure). This is #604 Part E, a P1 correctness defect deferred from #604 (closed via PR #641) to be fixed on top of #628's generalized pagination mechanism.

## Consumer semantics (load-bearing — drives the degraded rule below)

There is no server-side DTO layer: `ActivityResponse` is serialized verbatim as the `/api/activity` body (`ActivityEndpoints.cs:15`), and the frontend `ActivityRail.tsx` consumes the three `Degraded` bools **asymmetrically**:

- **`degraded.receivedEvents || degraded.notifications` is an all-or-nothing gate** (`ActivityRail.tsx:180-184, 216-219`): when either is true the entire activity list is replaced with "Activity unavailable" — items are **not** rendered.
- **`degraded.watching` is a split gate** (`ActivityRail.tsx:252-257`): it renders the partial watched rows **plus** a "may be incomplete" note.

Consequence for this change: introducing pagination adds later-page requests that can fault where before there was only one request. If a later-page fault set `degraded:true`, a transient page-2 500 on notifications/received_events would flip the rail from a complete feed to a **blank** "Activity unavailable" — a regression, on the two readers that don't even need pagination. The degraded rule below is designed around this: **a coherent non-empty prefix is never flagged degraded.**

## Decision summary

Add pagination at the single choke point (`GitHubArrayReader.ReadAsync`) by following `Link rel="next"` via the existing `GitHubLinkHeader.TryGetRel` parser, bounded by a max-page budget and a visited-URL guard. Degraded is set **only** when the read produced no usable data (page-1 failure); a coherent prefix from a later-page fault or a budget cap returns `degraded:false`. On hitting the budget while `rel="next"` is still advertised, emit a structured **log warning** (the "cap signal" #628 criterion 1 asks for). No change to the reader result records, `ActivityProvider`, `ActivityContracts`, `FakeActivityProvider`, or the `/api/activity` wire shape.

**Cap-signal surfacing: log-only in the helper.** Chosen over threading a `Capped` flag onto the result structs or the wire. Full pagination alone fixes the P1 for the overwhelming majority (lists between 100 and the budget ceiling); the page-budget cap is a rare guard. A structured operator log is the proportionate signal. The accepted residual (a >1000-item list still truncates silently to the user) and its follow-up are recorded under Risks.

## Design

### 1. `GitHubArrayReader.ReadAsync` — the pagination choke point

Make the class `static partial` (to host the source-generated log — see below). New optional trailing parameters keep existing callers/tests source-compatible:

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

Restructure so the accumulator `list` and a `visited` set are declared **outside** the `try` (so the catch can return the partial prefix):

- `var list = new List<T>(); var visited = new HashSet<string>(StringComparer.Ordinal);`
- Read token once (reused across all page requests — unchanged from today); `using var http = httpFactory.CreateClient("github")`.
- `var currentUrl = url; var page = 0;`
- Loop:
  - `page++`; `using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, currentUrl, token, ct)`.
  - `if (!resp.IsSuccessStatusCode) return (list, list.Count == 0);` — degraded **only if nothing was collected** (page-1 failure ⇒ empty+`degraded:true`; a later-page failure ⇒ partial prefix + `degraded:false`).
  - Parse the stream/document; `if (root.ValueKind != JsonValueKind.Array) return (list, list.Count == 0);` — same rule.
  - Append parsed items to `list`.
  - `if (GitHubLinkHeader.TryGetRel(resp, "next", out var next))`:
    - `if (page >= maxPages)` → emit the cap-hit log warning (see below); **break** (stop following; items are complete-to-budget, `degraded:false`).
    - `else if (!visited.Add(next))` → the `next` URL was already fetched this call (cycle / proxy / GHES quirk) → **break** (treat as exhausted, `degraded:false`; prevents duplicate items and a misleading cap log — see Risks).
    - else `currentUrl = next; continue;` — `next` is the **absolute** URL from the Link header, passed **as-is** (never stripped/re-derived to relative — stripping would double-prefix the GHES `…/api/v3` base *and* bypass the absolute-URI branch of the egress guard; see the `github_link_pagination_ghes_double_prefix` learning and the maintainer note under Risks).
  - else **break** (`rel="next"` absent ⇒ list exhausted).
- `return (list, false);`
- `catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }` — genuine cancellation propagates (unchanged).
- `catch (Exception ex) when (ex is HttpRequestException or JsonException or TaskCanceledException) { return (list, list.Count == 0); }` — partial-aware: returns the prefix collected before the fault, flagged degraded only if the prefix is empty (i.e. the fault was on page 1).

Seed `visited` with the initial `url` before the loop is unnecessary (the initial `url` is relative and GitHub's `next` URLs are absolute, so they never collide); the guard exists to catch a `next` that repeats a previously-seen **absolute** `next`.

**Degraded rule, stated plainly.** `degraded:true` ⇔ "the read produced no usable items" (page-1 failure/non-array/empty-after-fault). A non-empty prefix is always `degraded:false`, whether it is complete, truncated by the budget, or truncated by a later-page fault. This keeps the wire/consumer untouched and, per the Consumer-semantics section, never blanks the rail on a transient later-page fault. The trade-off (a rare later-page fault or a >budget list silently drops the tail for subscriptions) is analysed under Risks.

**Egress-guard interaction (verified).** The absolute `rel="next"` URL flows through `GitHubHttp.SendAsync` → `ApplyHeaders` (`GitHubHttp.cs:37-54`), whose credential guard requires an absolute request URI to match the client `BaseAddress` on scheme + host + port, throwing `HttpRequestException` **before** the `Authorization` header is set (`GitHubHttp.cs:56` is unreached on mismatch). GitHub's `next` URL is same-host/same-scheme (api.github.com, or the GHES `{host}/api/v3/` base from `HostUrlResolver.ApiBase`), so the guard credentials it normally. A hypothetical off-host `next` throws `HttpRequestException`, which the catch filter degrades — fail-closed, no PAT leak. Two layers actually apply: `GitHubLinkHeader.TryGetRel` first validates the value with `Uri.TryCreate(…, UriKind.Absolute)` (`GitHubLinkHeader.cs:45`), so a malformed `next` is a clean miss (pagination stops), never reaching the guard; a well-formed off-host `next` reaches the guard and is thrown. (Security review confirmed .NET `Uri` parsing defeats userinfo-`@` host confusion and the scheme check blocks a same-host http downgrade.)

**Budget.** `const int DefaultMaxPages = 10` ⇒ a 1000-item ceiling at `per_page=100`, bounding the worst case to 10 sequential requests per read. `received_events` is GitHub-capped at ~300 events, so it never reaches the budget; `notifications` and `user/subscriptions` above 1000 are rare, which is why the cap is a guard, not an expected path. The uniform value across all three readers is intentional — differentiating it per reader adds complexity without changing the truncation semantics.

**Cap-hit log.** Use the `[LoggerMessage]` **source generator** (mirroring the real precedent `Log.TimelineCapHit` at `GitHubReviewService.cs:624-645`, which is a `[LoggerMessage]`-attributed `partial` method on a `static partial class Log`, **not** manual `LoggerMessage.Define`). The `Log` class lives as a nested `static partial class Log` inside the now-`static partial class GitHubArrayReader`, so the helper itself emits with `Resource` and `MaxPages` fields. `LogLevel.Warning`; pick a stable explicit `EventId` (the existing `Log` methods pin explicit ids). Message to the effect of: "GitHub list read for {Resource} hit the {MaxPages}-page pagination budget; results may be truncated." No-op when `logger` is null or the budget is not reached. The `resource` argument is a hardcoded literal at each call site (below) — never derived from the URL/body/token — so the structured log cannot leak a token or PII.

### 2. The three readers accept an optional `ILogger<T>?` and pass `(logger, resource)`

Each reader gains a **trailing** constructor parameter `ILogger<TReader>? logger` (trailing so the existing positional args are unchanged; note `GitHubReceivedEventsReader` is 3-arg today — `httpFactory, readToken, readLogin` — so its logger goes 4th) and forwards it plus a resource label to `ReadAsync`:

- `GitHubReceivedEventsReader` → `resource: "received_events"`
- `GitHubNotificationsReader` → `resource: "notifications"`
- `GitHubWatchedReposReader` → `resource: "user/subscriptions"`

DI construction lambdas in `PRism.GitHub/ServiceCollectionExtensions.cs` (currently ~lines 183 / 197 / 206) pass **`sp.GetService<ILogger<…>>()`** (nullable) — **not** `GetRequiredService` — so a bare test container built without `AddLogging()` cannot throw at resolution (matches the recorded `optional_ilogger_di_seam_use_getservice` learning). The reader forwards whatever it got (possibly null) to the helper, which no-ops a null logger. The readers' public `ReadAsync` signatures and their result records (`ReceivedEventsResult`, `NotificationsResult`, `WatchedReposResult`) are **unchanged**.

### 3. Net effect

`user/subscriptions` is read to completion (up to the budget), so `ActivityFeedBuilder.BuildWatching` sees every watched repo and the P1 false-negative-past-page-1 truncation is eliminated for lists up to 1000. No change to result structs, `ActivityProvider`, `ActivityContracts`, `ActivityEndpoints`, `FakeActivityProvider`, or the `/api/activity` wire.

## Testing

New `GitHubArrayReader` multi-page tests (drive with the existing `tests/PRism.GitHub.Tests/TestHelpers/PaginatedFakeHandler.cs`, which auto-emits `Link rel="next"` for non-last pages and 500s on over-call, and `CapturingLogger<T>` — note the type is generic, so instantiate a concrete `CapturingLogger<GitHubArrayReaderTests>` (or similar) and pass it as `ILogger`):

1. **Follows `next` across pages and concatenates** — 3 scripted pages ⇒ all items returned, `CallCountFor` == 3, `degraded:false`.
2. **Stops at the max-page budget and logs** — handler always advertises `next`, small `maxPages` ⇒ exactly `maxPages` requests, `maxPages × pageSize` items, one `Warning` captured with the `Resource`/`MaxPages` fields, `degraded:false`.
3. **Later-page failure ⇒ partial prefix + `degraded:false`** — page 1 succeeds, page 2 returns 500 ⇒ page-1 items returned, **`degraded:false`** (the coherent-prefix rule; this is what prevents the `ActivityRail` all-or-nothing blank regression).
4. **Page-1 failure ⇒ empty + `degraded:true`** — first request 500s ⇒ `([], true)` (unchanged contract).
5. **Repeated `next` URL ⇒ break, no duplicates** — handler emits a `next` pointing back to an already-fetched page ⇒ loop stops on the visited-set guard, items are not duplicated, `degraded:false`, and no cap-hit warning is logged.
6. **Off-host `next` ⇒ degraded** — a **well-formed** absolute `Link next` pointing off-host (e.g. `https://attacker.example/...`) ⇒ `ApplyHeaders` throws `HttpRequestException` ⇒ prefix + degraded-if-empty (locks the egress-guard interaction). (A *malformed* next is a different path — `TryGetRel` returns false and pagination stops cleanly — optionally covered by a `GitHubLinkHeaderTests` case.)
7. **Single page / no `next` ⇒ unchanged** — existing single-request behavior, `degraded:false`.

Preserve unchanged: existing `GitHubArrayReaderTests` degrade/cancel cases (`Faults_degrade`, `Malformed_json_degrades`, `Non_array_root_degrades`, `Genuine_cancellation_propagates`) — all page-1 paths, still `([], true)` / rethrow.

Reader + integration level:
- One reader-level full-pagination test (e.g. `GitHubWatchedReposReader` across ≥2 pages via `PaginatedFakeHandler`) proving the #604 Part E fix end-to-end (all watched repos present).
- `GitHubActivityReadersAuthHeaderTests` continues to pass — assert the Bearer header is attached on **every** page request, not just the first.
- **Compile-break sweep (mechanical):** adding the trailing logger ctor param breaks every direct reader construction. Update each to pass a logger (`NullLogger<T>.Instance` or a `CapturingLogger<T>`): at least `GitHubActivityReadersAuthHeaderTests.cs:56-60`, `GitHubNotificationsReaderTests.cs:15-18` and `:120-121`, `GitHubWatchedReposReaderTests.cs`, plus the 3 DI lambdas in `ServiceCollectionExtensions.cs`. This is ~4 test files + 3 DI sites, all single-line.

## Out of scope (deferred)

- ETag / `If-None-Match` / `304` on the poll path — #628 Slice 2.
- Secondary rate-limit (`403` + `Retry-After`) handling distinct from 429/auth-fail — #628 Slice 3.
- `FetchPagedCountAsync` `rel="last"` generalization (`GitHubReviewService.cs:381`) — #604 Part D, already documented as `per_page==1`-asserted; not needed here.
- **User-facing cap surfacing** (a `Capped` flag on the result structs / `ActivityResponse` / a per-source "list may be incomplete" note when the >budget cap is hit) — file as a follow-up (see Risks). Requires the consumer-side `degraded`-gate rework (events/notifications are all-or-nothing today), which is a frontend change outside this backend slice.

## Risks

- **Sequential request fan-out.** Pagination turns one request into up to `maxPages` sequential requests for large lists. Bounded by the budget and the visited-URL guard; only triggered by genuinely large lists that were previously being silently truncated (the extra requests are the correctness fix, not waste).
- **Later-page fault silently drops the tail (accepted).** Under the coherent-prefix rule, a transient fault on page 2+ returns the prefix with `degraded:false`, so for `user/subscriptions` a repo beyond the fault boundary is silently omitted for that tick — with no "incomplete" note. This is a transient condition (the 60s poll retries and typically succeeds with the full list) and is no worse than today's permanent single-page truncation. The alternative (flag `degraded:true`) was rejected because `ActivityRail`'s all-or-nothing gate on notifications/received_events would blank the whole rail on any transient later-page fault — a strictly worse regression on the two readers that don't need pagination (Consumer-semantics section).
- **>Budget list still truncates silently to the user (accepted residual, follow-up filed).** A user with >1000 subscriptions (or notifications) hits the page budget: the read returns the first 1000, `degraded:false`, and only an **operator log** signals the truncation — the user sees a confident, complete-looking list missing the tail. This is the #604-Part-E defect class narrowed from "past 100" to "past 1000" (a large improvement, since ~all real users are under 1000), but it is the same silent-to-the-user shape. Accepted for this slice because closing it properly requires the deferred user-facing cap surfacing (out-of-scope, needs the frontend gate rework). **Follow-up to file:** surface a per-source "list may be incomplete" signal when the budget cap is hit.
- **Maintainer trap (guard against a future regression).** The absolute `next` URL must never be re-derived/stripped to a relative path: a relative URL always resolves against the trusted `BaseAddress`, so the absolute-URI branch of the egress guard would never run — a bug in such re-derivation (e.g. mishandling a protocol-relative `//host/path`) could silently reopen the off-host PAT-leak the guard exists to prevent. Add a short code comment at the pagination call site (near the `TryGetRel(resp, "next", …)` use) stating this, so a future "simplification" doesn't undo it.
