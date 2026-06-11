# GitHub HTTP transport helper — extract shared request/response plumbing

- **Issue:** #320 (epic #317, Theme B — GitHub provider; severity High / P1)
- **Date:** 2026-06-11
- **Tier / Risk:** T3 (cross-cutting + new shared abstraction) · **hands-off (conditionally
  escalates to B2-gated iff the pre-PR re-check finds a submit-path *semantic* shift)**
- **Worktree / branch:** `D:\src\PRism-320` · `feature/320-github-transport-helper`

## 1. Problem

The `PRism.GitHub` adapter hand-rolls the same GitHub HTTP plumbing at many call
sites. A code survey (2026-06-11, against current `main`) found the duplication is
**broader than the issue scoped** — 15 header-construction sites across **10
classes**, not "12 across 7." The issue missed three Activity readers
(`GitHubNotificationsReader`, `GitHubWatchedReposReader`, `GitHubPrTimelineReader`),
each of which also inlines the header set and omits `X-GitHub-Api-Version`.

### 1.1 Verified duplication groups

| Group | What | Where (current) |
|-------|------|-----------------|
| **A. Request headers** | `Authorization: Bearer`, `User-Agent: PRism/0.1`, `Accept: application/vnd.github+json`, sometimes `X-GitHub-Api-Version: 2022-11-28` rebuilt inline | `GitHubReviewService.cs` (`ValidateCredentialsAsync` :79, `SearchHasResultsAsync` :221, `GetFileContentAsync` :417 *custom Accept*, `GetCommitAsync` :459, `PostGraphQLAsync` :802, plus the `SendGitHubAsync` helper :758) + `Inbox/GitHubSectionQueryRunner` :112, `Inbox/GitHubPrEnricher` :55, `Inbox/GitHubAwaitingAuthorFilter` :63, `Inbox/GitHubCiFailingDetector` :322, `Activity/GitHubReceivedEventsReader` :46, `Activity/GitHubNotificationsReader` :40, `Activity/GitHubWatchedReposReader` :35, `Activity/GitHubPrTimelineReader` :63, `Feedback/GitHubFeedbackSubmitter` :65 |
| **B. 429 → `RateLimitExceededException`** | `if (resp.StatusCode == TooManyRequests) throw new RateLimitExceededException(msg, resp.Headers.RetryAfter?.Delta)` | `GitHubSectionQueryRunner` :116, `GitHubPrEnricher` :60, `GitHubAwaitingAuthorFilter` :68, `GitHubCiFailingDetector` :136 + :259 (×5) |
| **C. Link-header parsers (RFC 8288)** | three parsers, three return shapes | `GitHubReviewService.TryParseLastPage` (`bool` + `out int page`, rel=`last`), `GitHubReviewService.ExtractNextLink` (`string?` *relative path*, rel=`next`), `GitHubCiFailingDetector.TryGetNextLink` (`Uri?` *absolute*, rel=`next`) |
| **D. Error-body read** | best-effort body read (try/catch + `CA1031` pragma) before throwing | `PostGraphQLAsync` :806, `ReviewComments.cs` :34, `IssueComments.cs` :41 (×3) |
| **E. `pulls/{n}` fetchers** | two fetch scaffolds → two records (`PollPullMeta` vs `PullMeta`) | `GitHubReviewService.FetchPullJsonAsync` / `FetchPullMetaAsync` — **deferred, see §5** |
| **F. Timeline GraphQL fragment** | the `timelineItems(...)` selection duplicated, second copy **outside** the frozen-shape test's protection | `PrDetailGraphQLQuery` :44 vs `GetTimelineAsync` :353 |
| **G. `author{login avatarUrl}` extraction** | same `TryGetProperty`+`ValueKind==String` null-dance ×3 | `GitHubReviewService.cs` :1018, :1079, :1116 |
| **H. Tuning constants** | `ConcurrencyCap = 8` declared 4×; page sizes scattered (out of scope, §5) | `GitHubReviewService` :391, `GitHubPrEnricher` :12, `GitHubAwaitingAuthorFilter` :12, `GitHubCiFailingDetector` :11 |

**Survey correction (round-1 review):** the five 429 blocks are **not** byte-identical —
`GitHubSectionQueryRunner` throws `"GitHub Search API rate-limited (429); …"` (note the
`Search API` qualifier); the other four omit it. The shared helper must preserve this
(see §4.3), so consolidation is message-preserving, not message-flattening.

### 1.2 Observed drift (the bug this fixes)

`X-GitHub-Api-Version: 2022-11-28` is sent by only **2 of 15** sites (`SendGitHubAsync`
and the feedback submitter). Every Inbox/Activity request and `GetCommitAsync` /
`GetFileContentAsync` omit it, contradicting `SendGitHubAsync`'s own comment ("recommended
by GitHub for all REST calls"). The magic UA string `"PRism/0.1"` appears 15× and the
version number would rot in 15 places.

## 2. Goals / non-goals

**Goals**
- One definition each of the UA string and the GitHub header set.
- Every **REST** call sends `X-GitHub-Api-Version` (closes the drift).
- One Link-header parser, one 429 throw, one error-body-read helper; satellite copies deleted.
- **No GraphQL query text change** — fragment extraction is byte-identical textual composition.
- `dotnet test` green; behavior preserved everywhere except the inert REST header addition
  and the GHES pagination-correctness fix called out in §4.2.

**Non-goals**
- No change to *what* any endpoint fetches, parses, or returns.
- No `GitHubReviewService` god-object decomposition (tracked separately by the epic).
- No DI/lifetime changes to the 10 classes (see §4.1 rejected alternative).
- **The reviewer-atomic submit pipeline's GraphQL transport (`GitHubReviewService.Submit.cs`,
  `PostSubmitGraphQLAsync`) is NOT touched** (B2 — see §7).
- Not in this PR: group **E** (`pulls/{n}` union record) and force-merging
  semantically-distinct page sizes — see §5.

## 3. Acceptance criteria

1. The UA literal `"PRism/0.1"` appears **exactly once** in `PRism.GitHub/**` production
   (non-test) code — the `GitHubHttp.UserAgent` const definition; every other site
   references the const. (`grep -rc '"PRism/0.1"'` over production `*.cs` = 1; this counts
   the string literal, not const *references*.) The `Accept` / `X-GitHub-Api-Version` values
   are likewise single-sourced as consts.
2. **All REST** calls send `X-GitHub-Api-Version: 2022-11-28`, including the three
   previously-missed Activity readers. (GHES tolerance — see §6.) GraphQL POSTs are
   exempt by design via `apiVersion:false` (§4.1).
3. Exactly one Link-header parser, one 429-throw helper, one error-body-read helper; the
   satellite copies are deleted.
4. `PrDetailGraphQLQuery` and `GetTimelineAsync`'s `query` string are **byte-identical** to
   their current values, pinned by a characterization test.
5. `dotnet test` green across Core / Web / GitHub / Integration with zero new build warnings.

## 4. Design

### 4.1 `GitHubHttp` — a static transport helper (not an injected collaborator)

A new `internal static class GitHubHttp` in `PRism.GitHub` owning the request side:

```csharp
internal static class GitHubHttp
{
    internal const string UserAgent = "PRism/0.1";
    internal const string AcceptJson = "application/vnd.github+json";
    internal const string ApiVersion = "2022-11-28";

    // Inter-batch concurrency cap for per-commit fan-out (was declared 4× as
    // `ConcurrencyCap = 8`). Lives here as the GitHub-adapter's shared tuning const;
    // page sizes deliberately do NOT live here (§5).
    internal const int ConcurrencyCap = 8;

    // Takes the ALREADY-RESOLVED token (string?), so each caller keeps its current
    // token-read cadence: GitHubReviewService/Activity/Feedback read per request;
    // GitHubSectionQueryRunner/GitHubCiFailingDetector read once upstream and pass the
    // shared value across their N concurrent/paginated calls (round-1 feasibility finding).
    // The empty-token guard (no Authorization when null/empty) moves inside here.
    // `accept` overrides AcceptJson (GetFileContentAsync's raw media type).
    // `apiVersion:false` suppresses the version header (read-side GraphQL POST — §4.4).
    internal static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpMethod method, string url, string? token, CancellationToken ct,
        HttpContent? content = null, string? accept = null, bool apiVersion = true)
    { /* build request, host-guard the Authorization (below), apply headers, send */ }
}
```

**Why static, not an injected `IGitHubHttp`.** The helper holds no state and does no
policy — it is a pure function of `(http, method, url, token)`. Injecting it would add a
constructor parameter to **10 sealed classes** and their test fixtures for zero behavioral
benefit, and the classes do not share a single client name (`"github"` vs the feedback
submitter's `"github.com"`), so there is nothing to centralize in an instance. A static
method taking the already-resolved token is the minimal diff, is trivially unit-testable
with a stub `HttpMessageHandler`, and does **not** foreclose a future `IGitHubHttp` seam
(the static method can later delegate to one). Every one of the 10 classes already stores
`_readToken` as `Func<Task<string?>>`; passing the *resolved* token (not the delegate)
preserves each site's exact read cadence — a delegate parameter would silently re-read the
token once per request for the two callers that currently read once per batch.

**Same-host Authorization guard.** Unifying the `next`-link adapters to absolute URLs (§4.2)
means `SendAsync` now receives server-controlled absolute URLs (from `Link` response headers)
at two callers instead of one. To keep the PAT from ever riding a request to an unexpected
host, `SendAsync` attaches `Authorization` only when the request URL is **relative** (resolved
against the trusted `BaseAddress`) **or** its host equals `http.BaseAddress!.Host`; an
absolute, off-host URL throws `ArgumentException` (fail loud — never silently send the token
off-host, never silently drop it). GitHub pagination `Link` URLs are always same-host, so this
is inert for every legitimate response; it is a cheap chokepoint guard at the moment the
absolute-URL path is broadened. (Pre-existing posture hardened, not new required behavior —
the deeper "validate all egress hosts" work is out of scope.)

### 4.2 `GitHubLinkHeader` — one parser, unified to absolute URLs

```csharp
internal static class GitHubLinkHeader
{
    // Returns the absolute URL GitHub put in the `Link` header for the given rel
    // ("next" | "last" | ...), or false if absent. Accepts quoted (rel="next") and
    // unquoted (rel=next) forms — standardizing on the most-capable existing parser
    // (GitHubCiFailingDetector's). This slightly broadens the two GitHubReviewService
    // callers, which currently match quoted-only; inert because GitHub always quotes rel.
    internal static bool TryGetRel(HttpResponseMessage resp, string rel, out string url);
}
```

**Corrected rationale (round-1 adversarial finding).** The previous draft justified keeping
the three parsers' divergent return shapes as "the callers resolve against different
`BaseAddress` expectations." **That was false** — `ExtractNextLink` and `TryGetNextLink` use
the *same* `"github"` client and the *same* single `BaseAddress`. The real divergence:
`ExtractNextLink` strips the URL to `PathAndQuery.TrimStart('/')` and re-resolves it against
`BaseAddress`, which is github.com-correct but on GHES (`BaseAddress = {host}/api/v3/`)
produces a doubled `/api/v3/api/v3/…` → **404 on every paginated diff past page 1**.
`TryGetNextLink` hands the absolute URL through unchanged — correct on both. Freezing
`ExtractNextLink`'s transform behind a characterization test would have *defended the bug*.

**Decision: unify both `next`-link callers to the absolute URL.** On github.com (the
exercised target) the resulting wire request is byte-identical to today (a relative path
resolved against `BaseAddress` yields the same absolute URL GitHub returned). On GHES it
removes the double-prefix 404. Caller adapters over the single primitive:
- **last-page** (`TryParseLastPage`, rel=`last`): `TryGetRel(resp,"last",out var u)` → parse
  the `page` query param from `u` (the `page` extraction stays at the caller — it is a
  `last`-specific concern, not Link parsing).
- **next, diff pagination** (was `ExtractNextLink`): `TryGetRel(resp,"next",out var u)` → pass
  the absolute `u` (or `new Uri(u)`) to `SendAsync`. **Behavior change: GHES-correct now.**
- **next, CI pagination** (was `TryGetNextLink`): `TryGetRel(resp,"next",out var u)` →
  `new Uri(u)` — unchanged.

This collapses three parsers into one **and** fixes a latent GHES pagination bug. The PR body
calls the GHES fix out explicitly (it is the one intentional behavior delta beyond the header
addition); a GHES-shaped `Link`-header test pins it (§8).

### 4.3 `ThrowIfRateLimited` — one 429 throw, message-preserving

```csharp
// On HTTP 429, throw RateLimitExceededException($"GitHub{subject} rate-limited (429);
// orchestrator should skip this tick.", resp.Headers.RetryAfter?.Delta). No-op otherwise.
// `subject` is " Search API" for the search-section caller, "" (default) for the other four
// — preserving each site's current message exactly (§1.1 correction).
internal static void ThrowIfRateLimited(HttpResponseMessage resp, string subject = "");
```

### 4.4 Error-body read (group D) — shared best-effort read, throws stay at callers

The triplicated ugly part is the `CA1031`-suppressed best-effort body read, not the throw
(whose context label differs per caller). Extract the read; keep each caller's throw/log:

```csharp
// The ONE audited CA1031-suppressed read. Returns the body, or "" on a non-cancellation
// read failure. OperationCanceledException propagates (caller shutdown).
internal static async Task<string> ReadErrorBodyBestEffortAsync(HttpResponseMessage resp, CancellationToken ct);
```

Callers:
- **GraphQL** (`PostGraphQLAsync`): `var body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct);`
  then its existing `s_graphqlTransportFailed(… Truncate(body,1024) …)` log, then
  `throw new HttpRequestException($"GitHub GraphQL HTTP {(int)code} {reason}: {Truncate(body,512)}", null, code);`.
  The GraphQL-specific log stays at the caller (it is telemetry, not part of the shared read).
- **review / issue comment POST**: `var body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct);`
  then `throw new HttpRequestException($"GitHub {context} HTTP {(int)code} {reason}: {Truncate(body,512)}", null, code);`
  with `context` = `"review comment POST"` / `"issue comment POST"` — reproducing both messages exactly.

The **success-path** `id`/`created_at` parse in `ReviewComments.cs` / `IssueComments.cs` is
**left inline, not extracted** (round-1 finding): the two callers' missing-field messages
differ (`missing 'id'.` vs `missing 'id' field.`) and a single shared parser cannot reproduce
both without flattening a user-facing message. A 2-caller, ~6-line, message-divergent parse
is below the extraction bar; deduping it would trade byte-identical behavior for a premature
unifier. `Truncate` stays where it is and is reused.

`PostGraphQLAsync` routes its send through `GitHubHttp.SendAsync(…, apiVersion:false)` — the
REST version header is meaningless to the GraphQL endpoint, and suppressing it keeps the
read-side GraphQL request **byte-identical to today** (no spurious header on a GraphQL POST).
This is the `apiVersion` param's first real consumer.

### 4.5 `ReadActor` — author extraction (group G)

```csharp
// (login, avatarUrl) from an `author{login avatarUrl}` node; ("", null) when absent.
internal static (string Login, string? AvatarUrl) ReadActor(JsonElement node);
```

Replaces the three inline null-dances. Pure JSON read; zero behavior risk. Not AC-mandated —
an explicit cheap extra (§5).

### 4.6 Timeline GraphQL fragment (group F) — byte-identical extraction

The two copies differ only by the `pageInfo{hasNextPage endCursor} ` wrapper (present in
`PrDetailGraphQLQuery`, absent in `GetTimelineAsync`) — including the trailing space. Extract
the common parts as `internal const`:

```csharp
internal const string TimelineItemsArgs =
    "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW])";
internal const string TimelineNodes =
    "nodes{__typename " +
    "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
    "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
    "... on PullRequestReview{submittedAt}" +
    "}";
```

Composition (verified byte-equal to the originals at survey time):
- PR-detail: `… + TimelineItemsArgs + "{pageInfo{hasNextPage endCursor} " + TimelineNodes + "}" + …`
- Timeline: `… + TimelineItemsArgs + "{" + TimelineNodes + "}" + …`

This brings the previously-unprotected `GetTimelineAsync` copy under a characterization test
(AC #4). Extraction is the *only* change here — no schema/shape edit. **The characterization
pin (§8.1) is written and green BEFORE the extraction**, so the bytes are locked first.

### 4.7 `ConcurrencyCap` (subset of group H)

Collapse the four identical `ConcurrencyCap = 8` declarations into one
`internal const int GitHubHttp.ConcurrencyCap = 8` (§4.1). **No separate `GitHubLimits`
class** (round-1 scope finding): a one-const umbrella class named for "limits" would invite
the very page-size folding §5 argues against. Page sizes are not consolidated (§5).

## 5. Scope boundary (what lands vs. defers)

**Lands in this PR.**
- **AC-mandated:** A (headers + UA const), B (429), C (Link — incl. the §4.2 GHES fix),
  D (error-body read), F (timeline fragment).
- **Explicit cheap extras** (issue-listed, zero behavior risk, *not* AC-required — included
  by deliberate choice, not drift): G (`ReadActor`), the `ConcurrencyCap` consolidation
  (the in-scope half of group H).

**Deferred** (filed as a follow-up issue, cross-linked from this PR):
- **Group E — `pulls/{n}` union record.** `PollPullMeta` carries `Mergeability`/`Merged`,
  which feeds the active-PR mergeability surface (#259/#270) — a B2-adjacent concern. Merging
  it with `PullMeta` couples two consumers and restructures a model that touches mergeability
  semantics; that does not belong in a behavior-preserving transport PR. *Note:* both `pulls/{n}`
  fetchers still route their requests through `GitHubHttp.SendAsync`, so the **transport/header
  unification reaches them** — only the *record merge* is deferred, leaving no raw header
  duplication behind.
- **Page-size consolidation** (the other half of group H). `per_page=1` (existence probe),
  `per_page=50` (sections), `per_page=100` (full pagination), and `first:50`/`first:100`
  (GraphQL) are **different limits for different endpoints**, not one concept. A local named
  const may replace an unnamed literal, but cross-endpoint merging is out of scope (false
  consolidation that obscures intent).
- **Same-host egress allowlist beyond the §4.1 guard**, and **`Submit.cs` GraphQL transport**
  (B2 — §7).

## 6. Behavior change: `X-GitHub-Api-Version` on REST, and GHES tolerance

Routing the previously-omitting REST sites through `GitHubHttp.SendAsync` means they start
sending `X-GitHub-Api-Version: 2022-11-28`.

- **github.com:** `2022-11-28` is the current default REST version, so responses are
  unchanged. No behavior delta.
- **GHES:** `2022-11-28` is the **baseline** date-based REST version, supported by every GHES
  release that implements API versioning (3.9+). GHES releases that predate API versioning
  ignore the unknown request header (HTTP servers ignore unrecognized request headers by
  default), so the header is inert there too. The narrow theoretical gap — a GHES that
  implements versioning but rejects `2022-11-28` — does not exist (it is the first/lowest
  version). If a specific deployment is ever found to reject it, the per-call `apiVersion:false`
  escape hatch (§4.1) is the mitigation; this is noted, not pre-built.

GraphQL POSTs do **not** gain the header (`apiVersion:false`, §4.4). One sentence to this
effect goes in the PR body.

## 7. Risk surface (B2 pre-PR re-check)

The shared transport underlies `PostGraphQLAsync` (read-side GraphQL) and the standalone
issue/review-comment REST POSTs. To hold the tightest B2 envelope:

- **The reviewer-atomic submit pipeline's GraphQL transport (`Submit.cs`,
  `PostSubmitGraphQLAsync`, the `addPullRequestReview → thread/reply → submitPullRequestReview`
  sequence and its pending-review-id handling) is left untouched.** Out of scope.
- Read-side `PostGraphQLAsync` keeps its request **byte-identical** (`apiVersion:false`, same
  auth, same body, same error shape).
- The standalone comment POSTs already route through `SendGitHubAsync` (which already sends the
  version header), so rerouting them through `GitHubHttp.SendAsync` is header-identical.

At pre-PR re-check (workflow step 7) the committed diff is re-read against the Axis-B table; if
any submit-path *semantic* shifted, the issue re-classifies to gated (B2) and routes to the
human gate before the PR opens.

## 8. Testing strategy (TDD)

Behavior-preserving refactor → the proof is **characterization tests written before the
refactor** (pin current behavior, stay green through the change) plus targeted unit tests for
the new helpers.

1. **GraphQL byte-identity (AC #4).** Pin `PrDetailGraphQLQuery` and `GetTimelineAsync`'s
   query string to their exact current bytes (the frozen-shape integration test already covers
   the former; add an explicit pin for the latter) **before** extraction; both stay green after.
2. **Header presence (AC #1/#2).** Unit-test `GitHubHttp.SendAsync` via a stub
   `HttpMessageHandler`: UA / Accept / `X-GitHub-Api-Version` / Bearer present; `accept`
   override replaces the default; empty token → no Authorization; **`apiVersion:false` → no
   version header**; **`GetFileContentAsync`'s raw Accept + version header still returns the
   raw body unchanged** (the one site where a non-default Accept meets the version header).
   Regression: a previously-omitting reader (e.g. `GitHubReceivedEventsReader`) now sends the
   version header.
3. **Same-host guard (§4.1).** `SendAsync` with a relative URL attaches Authorization; with a
   same-host absolute URL attaches it; with an off-host absolute URL throws `ArgumentException`
   (token never leaves the host).
4. **Link parser parity + GHES fix (AC #3, §4.2).** Table-test `GitHubLinkHeader.TryGetRel`
   across quoted / unquoted rel, multi-rel headers, missing header. Per-caller adapter tests
   prove last-page / next outputs equal the pre-refactor outputs **on github.com-shaped
   headers**, and a **GHES-shaped `Link` header** (`{host}/api/v3/…` next URL) resolves to a
   request URL with a single `/api/v3/` segment (the bug the unification fixes).
5. **429 message-preserving (AC #3).** `ThrowIfRateLimited` throws on 429 with
   `RetryAfter.Delta`; the `subject:" Search API"` variant reproduces the search message; no-op
   otherwise.
6. **Error-body read (AC #3).** `ReadErrorBodyBestEffortAsync` returns the body, returns `""`
   on a faulted read, and propagates `OperationCanceledException`.
7. **Full suite (AC #5).** `dotnet test` Release across all four projects; zero new warnings.

The existing endpoint/integration tests for the 10 classes are the backstop that the
call-site rewrites preserved behavior.

## 9. Rejected alternatives

- **Injected `IGitHubHttp` collaborator** — more churn (ctor + fixture changes across 10
  sealed classes), no shared state to justify it. Static helper wins; does not foreclose a
  future seam. (§4.1)
- **Pass `Func<Task<string?>>` to `SendAsync`** — silently re-reads the token per request for
  the two callers that currently read once per batch. Pass the resolved token instead. (§4.1)
- **Preserve `ExtractNextLink`'s relative-path transform** — it is a latent GHES double-prefix
  bug, not intent; unify to absolute and fix it. (§4.2)
- **Extract `ParseCreatedEntity` for the success-path parse** — the two callers' missing-field
  messages differ; a shared parser flattens a user-facing message for a 2-caller, 6-line gain.
  Left inline. (§4.4)
- **A `GitHubLimits` class for `ConcurrencyCap`** — a one-const umbrella invites the page-size
  folding §5 rejects. Put the const on `GitHubHttp`. (§4.7)
- **Merge `PollPullMeta` + `PullMeta`; force page sizes into one surface; touch `Submit.cs`
  transport** — deferred / out of scope. (§5, §7)

## 10. Round-1 `ce-doc-review` dispositions

Recorded in full in the PR `## Proof`. Summary: adversarial **P1** (false Link rationale
masking a GHES bug) → applied (§4.2, unify-to-absolute + GHES test); feasibility **P2** (429
messages not identical) → applied (§4.3 `subject`); feasibility **P2** (delegate misfits
token-sharing callers) → applied (§4.1 resolved-token); feasibility **P3** + scope **P2**
(`ParseCreatedEntity` un-reproducible / premature) → applied (dropped, §4.4); security **P2**
(token on off-host absolute URL) → applied (§4.1 host guard); coherence **P1** (GHES claim
unevidenced) → applied (§6); scope **P2** (`GitHubLimits` one-const class) → applied (§4.7);
plus coherence/scope wording clarifications (gate phrasing, Group H split, AC#1 grep semantics,
explicit cheap extras). Security **P3** (error-body in messages) → FYI: pre-existing, truncated,
no token material; noted, no behavior change. Round 2 pending.

## 11. Self-review

- **Placeholders:** none.
- **Consistency:** AC ↔ design ↔ scope cross-checked; A–D + F map to §4 (AC), G + ConcurrencyCap
  are §5 explicit extras; E + page sizes + `Submit.cs` deferred in §5/§7 with rationale.
- **Scope:** single coherent refactor; the riskiest satellite (E) and the B2 submit transport
  are carved out to hold the hands-off envelope.
- **Ambiguity:** the load-bearing claims (byte-identical fragment; GHES Link fix) are made
  falsifiable by the §8.1 and §8.4 tests.
