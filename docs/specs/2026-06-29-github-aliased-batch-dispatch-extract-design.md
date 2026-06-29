# Extract the aliased-GraphQL-batch dispatch loop (issue #665, sub-task 1)

- **Status:** approved (T2, hands-off; machine `ce-doc-review` substitutes for the human spec gate per the issue-resolution workflow)
- **Issue:** [#665](https://github.com/prpande/PRism/issues/665) — sub-task 1 of 3
- **Tier / Risk:** T2 / hands-off (read-path GraphQL transport refactor; additive to `GitHubGraphQL`, no submit-pipeline change)
- **Date:** 2026-06-29

## Problem

Two sibling batch readers run the *same* aliased-GraphQL dispatch pipeline, physically copied:

- `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` — `FetchChunkAsync` (`:125-192`) + `BuildQuery` (`:200-224`)
- `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs` — `PollBatchAsync` chunk body (`:44-71`) + `BuildQuery` (`:133-150`)

The copied pipeline, per chunk:

1. alias the chunk: `chunk.Select((x, i) => ($"a{i}", x))`
2. build the query envelope: `query{ aN: repository(owner:<json>, name:<json>){ pullRequest(number:N){ <selection> } } … rateLimit{ cost remaining } }`
3. POST via `GitHubGraphQL.PostAsync(http, token, host, log, query, new {}, ct)`
4. translate HTTP-429: `catch (HttpRequestException ex) when (ex.StatusCode == TooManyRequests) → throw new RateLimitExceededException("GitHub GraphQL rate limit (HTTP 429) during <context>.", retryAfter: null)`
5. `using var doc = JsonDocument.Parse(body)`
6. `GitHubGraphQL.ThrowIfRateLimited(doc.RootElement, "<context>")`
7. data-object guard: `doc.RootElement.TryGetProperty("data", …) && data.ValueKind == Object`

Only the **helpers** (`PostAsync`, `ThrowIfRateLimited`, `CountLatestReviews`) are shared today; the **loop + query envelope are copied** and have already drifted: `MaxBatch` is 50 (inbox) vs 100 (active). The #604-class hazard is real — a transport fix has to be applied to both copies.

### What is intentionally NOT unified

- **`MaxBatch` (50 inbox / 100 active).** This drift is deliberate and tracked separately (the alias-cap issue): the inbox's full open-PR query forces per-PR server-side merge-state computation (≈9s at 75 aliases), so it caps at 50; the active query is lighter and caps at 100. **Chunking stays per-reader** — the shared dispatcher operates on one already-chunked alias list.

## Goal / acceptance criteria

This is a **hazard-consolidation** refactor, not a line-count dedup: net LOC is roughly
break-even (the shared method + two selection constants + the inbox selection composer ≈ the
removed lines). The win is a **single point of fix** for the transport/429/parse/rate-limit
block — the #604-class hazard where a transport fix today has to be applied to both copies.

- Steps 2–6 (build envelope → POST → 429-translate → Parse → ThrowIfRateLimited) live in **one** shared method on `GitHubGraphQL`. Both readers call it; the copied transport block is consolidated to a single maintained site.
- **Byte-identical GraphQL wire output** — the exact query string each reader posts today is preserved, pinned by a characterization test at the public seam (capture the POSTed query, assert against a golden string copied from current `main`).
- **No behavior change** anywhere else — existing batch-reader tests stay green; the 429 / 200-RATE_LIMITED rate-limit model is preserved exactly (the `context` string reproduces each reader's message verbatim).
- The intentional `MaxBatch` drift is **preserved** (per-reader chunking untouched).
- No change to the submit pipeline: `PostAsync`/`ThrowIfRateLimited`/`TryGetPath` are untouched; the new method only *composes* them.

## Design

Add to `internal static partial class GitHubGraphQL`:

```csharp
// Builds and sends ONE aliased-batch chunk through the shared GraphQL transport, translating
// BOTH rate-limit signals to RateLimitExceededException (message tagged with `context`):
//   • HTTP 429 (PostAsync throws HttpRequestException, StatusCode preserved)
//   • 200 body carrying errors[].type == "RATE_LIMITED" (ThrowIfRateLimited)
// Returns the parsed response document. The CALLER owns it (`using var doc = …`) and does its
// own data-guard, per-alias parse, and observability — those genuinely differ between the two
// readers. Chunking + chunk size stay with the caller (the readers cap at different alias counts).
internal static async Task<JsonDocument> RunAliasedBatchAsync<TItem>(
    HttpClient http, string? token, string host, ILogger log,
    IReadOnlyList<(string Alias, TItem Item)> aliased,
    Func<TItem, PrReference> refOf,
    string perRefSelection,
    string context,
    CancellationToken ct)
{
    var query = BuildAliasedQuery(aliased, refOf, perRefSelection);
    string body;
    try
    {
        body = await PostAsync(http, token, host, log, query, new { }, ct).ConfigureAwait(false);
    }
    catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.TooManyRequests)
    {
        throw new RateLimitExceededException(
            $"GitHub GraphQL rate limit (HTTP 429) during {context}.", retryAfter: null);
    }

    var doc = JsonDocument.Parse(body);
    try { ThrowIfRateLimited(doc.RootElement, context); }
    catch { doc.Dispose(); throw; }   // don't leak the doc when RATE_LIMITED throws
    return doc;
}

// Shared aliased-batch query envelope. perRefSelection is the verbatim field list inside
// pullRequest{ … } — caller-specific (and, for the inbox, readiness-conditional). The envelope
// (alias → repository(owner,name) → pullRequest(number) wrapper + trailing rateLimit) is the
// copied part this consolidates. Byte-identity is pinned by characterization tests.
private static string BuildAliasedQuery<TItem>(
    IReadOnlyList<(string Alias, TItem Item)> aliased, Func<TItem, PrReference> refOf, string perRefSelection)
{
    var sb = new StringBuilder("query{");
    foreach (var (alias, item) in aliased)
    {
        var r = refOf(item);
        sb.Append(alias).Append(": repository(owner:")
          .Append(JsonSerializer.Serialize(r.Owner)).Append(", name:")
          .Append(JsonSerializer.Serialize(r.Repo)).Append("){ pullRequest(number:")
          .Append(r.Number.ToString(CultureInfo.InvariantCulture))
          .Append("){ ").Append(perRefSelection).Append(" } } ");
    }
    sb.Append("rateLimit{ cost remaining } }");
    return sb.ToString();
}
```

`GitHubGraphQL.cs` must add exactly two usings: `using System.Net;` (HttpStatusCode) and
`using PRism.Core.Contracts;` (PrReference). `System.Text.Json` (JsonDocument) and
`PRism.Core.Inbox` (RateLimitExceededException) are already imported. `StringBuilder`,
`JsonSerializer`, and `CultureInfo` are already in scope (`System.Text`, `System.Text.Json`,
`System.Globalization`).

### Caller collapse

**Active** (`GitHubActivePrBatchReader.PollBatchAsync`): the `MaxBatch=100` `Chunk` loop stays. Per chunk:
```csharp
var aliased = chunk.Select((r, i) => ($"a{i}", r)).ToList();
using var http = _httpFactory.CreateClient("github");
using var doc = await GitHubGraphQL.RunAliasedBatchAsync(
    http, await _readToken().ConfigureAwait(false), _readHost(), _log,
    aliased, r => r, ActiveSelection, "active-PR batch poll", ct).ConfigureAwait(false);
if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
    continue;
foreach (var (alias, prRef) in aliased) { /* unchanged per-alias TryParse + result write */ }
```
`ActiveSelection` is a `private const string` holding the exact field list currently inline in `BuildQuery`. The local `BuildQuery` is **deleted**; `Chunk` is **kept** (it is the chunker, unrelated to the envelope).

**Inbox** (`GitHubPrBatchReader.FetchChunkAsync`): the `MaxBatch=50` `FetchInto` chunk loop stays. The method keeps its signature and all observability (cost log, `RefsDropped`, per-alias `InboxJsonGuard` malformed guard, dropped count). Only the build+POST+429+Parse+ThrowIfRateLimited prefix is replaced:
```csharp
var aliased = chunk.Select((it, idx) => (Alias: $"a{idx}", Item: it)).ToList();
var selection = InboxSelection(includeReadiness);   // common + (readiness ? readiness-fields : "")
using var doc = await GitHubGraphQL.RunAliasedBatchAsync(
    http, token, host, _log, aliased, it => it.Reference, selection, "inbox batch hydration", ct)
    .ConfigureAwait(false);
// unchanged from here: data-guard → RefsDropped(chunk.Count) on miss; cost log; per-alias loop
```
`InboxSelection(bool)` composes the same two field strings `BuildQuery` builds today (common scalars, plus the readiness block when `includeReadiness`). The local `BuildQuery` is deleted.

### Byte-identity construction rule (the one place a regression lands)

The split `"){ " + selection + " } } "` requires each selection const to end at a **precise**
brace boundary, and the two readers close braces *differently* — this asymmetry is the byte
hazard:

- **Active** bundles the `pullRequest`+`repository` closes into its field append
  (`…Team{ name } } } } } `). So `ActiveSelection` must end at the `reviewRequests` close —
  `…reviewRequests(first:20){ nodes{ requestedReviewer{ … on Team{ name } } } }` — with **no
  trailing space**; the envelope's ` } } ` supplies the PR + repo closes.
- **Inbox** closes via a *separate* `sb.Append("} } ")` after the field group, whose last field
  ends with a **trailing space** (`headRepository{ pushedAt } ` / `…reviewRequests(…){…} `).
  So `InboxSelection(false)` (closed) must end at `…headRepository{ pushedAt }` with **no
  trailing space** (the envelope's leading-space ` } } ` supplies the rest), and
  `InboxSelection(true)` (open) must be `common + " " + readiness` where **`common` ends with no
  trailing space** and `readiness` ends at its `reviewRequests` close with no trailing space.
  Defining a single no-trailing-space `common` and injecting the separator at composition avoids
  the double-space / missing-space trap.

Do not hand-verify this by eye. **Capture the three golden query strings from the current
(pre-refactor) code first** (see Testing), then tune the constants until the characterization
tests are green.

### Why the rate-limit `context` reproduces both messages exactly

Both readers already use the same phrase for their 429 message **and** their `ThrowIfRateLimited` call:
- active: 429 → `"…during active-PR batch poll."`; `ThrowIfRateLimited(root, "active-PR batch poll")`
- inbox: 429 → `"…during inbox batch hydration."`; `ThrowIfRateLimited(root, "inbox batch hydration")`

So a single `context` argument used for both produces byte-identical exception messages. (Confirmed against the current source.)

## Testing

TDD with a **characterization-first** discipline for the byte-sensitive query (the wire contract):

1. **Characterization tests (write first, green on PRE-refactor code — this ordering IS the
   safety property):** drive each reader's public method (`PollBatchAsync` / `ReadAsync`) with a
   query-capturing handler (`RecordingHttpMessageHandler` already exists; `GitHubPrBatchReaderTests`
   already extracts `doc.RootElement.GetProperty("query")` — reuse that idiom) and assert the
   POSTed query equals a golden string. Add one per reader, plus one for the inbox
   `includeReadiness:false` (closed) selection.
   - **Land these tests + goldens in a commit verified green BEFORE the refactor commit.** If the
     golden is captured *after* refactoring, it pins the (possibly wrong) refactored output and
     goes green trivially — the net is defeated. Capture against the current `BuildQuery` output.
   - **Include at least one golden whose owner or repo contains a JSON-escapable character**
     (e.g. a quote or backslash) so the test actually exercises the `JsonSerializer.Serialize`
     escaping path the envelope relies on, not just plain `octocat/hello` names.
   - After the refactor, these tests stay green unchanged → byte-identity proof.
2. **New `GitHubGraphQL.RunAliasedBatchAsync` unit tests** (the new contract's home; `GitHubGraphQL` is internal, visible to `PRism.GitHub.Tests`):
   - builds the expected envelope for N aliases (asserts the composed query)
   - HTTP-429 → `RateLimitExceededException` whose message contains the passed `context`
   - 200 body with `errors[].type=="RATE_LIMITED"` → `RateLimitExceededException` (and the returned doc is disposed, not leaked)
   - happy 200 → returns a parsed doc whose `data` carries the aliases
3. **Regression guard:** all existing `GitHubActivePrBatchReaderTests` and `GitHubPrBatchReaderTests` stay green unchanged (per-alias parse, readiness derivation, comment counting, rate-limit, isDraft, caching, eviction).
4. **Submit-contract guard:** `GraphQlByteIdentityTests` must stay green untouched — it pins
   `PostAsync`'s byte-identity (the B2 submit transport). Since this PR is additive to
   `GitHubGraphQL` and does not modify `PostAsync`, that suite proves the submit contract did not
   move. (The integration shape-drift test is `Category=Integration`, excluded by `.runsettings`
   locally; it runs in CI.)

## Out of scope / non-goals

- Sub-tasks #2 (array reader — shipped via #680) and #3 (check-runs pager — split to #681).
- **Unifying `MaxBatch`** — deliberate drift, tracked by the alias-cap issue; preserved here.
- No change to per-alias parsing, the `nonDefinitive`/cache logic, the open/closed query split, eviction, or any observability.
- No change to `PostAsync`/`ThrowIfRateLimited`/`TryGetPath` or the submit pipeline.

## Rejected alternatives

- **Pass a parse delegate + return parsed results (the issue's literal `…, TryParse, …` shape).** The two readers' per-alias handling diverges materially — inbox wraps each alias in an `InboxJsonGuard` malformed-isolation try/catch, counts dropped refs, and logs `RefsDropped`/`RateLimitCost`; active simply skips a missing alias and has *no* per-alias guard (a throw aborts the tick). Folding the loop into the dispatcher would either strip the inbox's isolation/observability or silently add a guard to active (changing its abort-on-malformed behavior). Returning the parsed `JsonDocument` and leaving the per-alias loop in each caller preserves both behaviors exactly while still removing the genuinely-identical build+POST+error block.
- **Share only the dispatch (not the query envelope).** Leaves the larger copied block (the envelope) in place and keeps the #604-class "fix both copies" hazard. Extracting the envelope is the point; byte-risk is mitigated by the characterization tests rather than avoided.
- **Non-generic `RunAliasedBatchAsync(IReadOnlyList<(string Alias, PrReference Ref)> aliased, …)`.** Rejected in favor of the generic `<TItem>` + `refOf`: the inbox needs each alias's *original* `RawPrInboxItem` (not just its `PrReference`) in its post-parse loop (for the cache key + `TryParse`). A non-generic `PrReference`-only dispatcher would force the inbox to maintain a second alias-aligned list (or an alias→item dictionary) to recover the item after the call. The generic lets the inbox pass **one** `(alias, item)` list, used by the dispatcher for the query (via `refOf`) and reused verbatim for the parse loop. Active pays a trivial `refOf = r => r`. The marginal generic overhead buys the inbox a single source of alias↔item truth.
- **A `JsonDocument`-owning wrapper struct (`IDisposable`).** Unnecessary — returning the `JsonDocument` directly (caller `using`s it) is idiomatic and the existing readers already `using var doc` it.
