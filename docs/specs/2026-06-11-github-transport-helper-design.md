# GitHub HTTP transport helper — extract shared request/response plumbing

- **Issue:** #320 (epic #317, Theme B — GitHub provider; severity High / P1)
- **Date:** 2026-06-11
- **Tier / Risk:** T3 (cross-cutting + new shared abstraction) · hands-off, with a B2 pre-PR re-check
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
| **B. 429 → `RateLimitExceededException`** | identical `if (resp.StatusCode == TooManyRequests) throw new RateLimitExceededException(msg, resp.Headers.RetryAfter?.Delta)` | `GitHubSectionQueryRunner` :116, `GitHubPrEnricher` :60, `GitHubAwaitingAuthorFilter` :68, `GitHubCiFailingDetector` :136 + :259 (×5) |
| **C. Link-header parsers (RFC 8288)** | three parsers, **three return semantics** | `GitHubReviewService.TryParseLastPage` (`bool` + `out int page`, from rel=`last`), `GitHubReviewService.ExtractNextLink` (`string?` *relative path*, rel=`next`), `GitHubCiFailingDetector.TryGetNextLink` (`Uri?` *absolute*, rel=`next`) |
| **D. Error-body read → wrap** | best-effort body read (try/catch + `CA1031` pragma) then `throw new HttpRequestException(...statusCode:...)` | `PostGraphQLAsync` :806, `ReviewComments.cs` :34, `IssueComments.cs` :41 (×3); plus near-identical success-path `id`/`created_at` parse in `ReviewComments.cs` :50 and `IssueComments.cs` :71 |
| **E. `pulls/{n}` fetchers** | two fetch scaffolds → two records (`PollPullMeta(HeadSha,State,Mergeability,Merged)` vs `PullMeta(BaseSha,HeadSha,ChangedFiles)`) | `GitHubReviewService.FetchPullJsonAsync` / `FetchPullMetaAsync` |
| **F. Timeline GraphQL fragment** | the `timelineItems(...)` selection duplicated, second copy **outside** the frozen-shape test's protection | `PrDetailGraphQLQuery` :44 vs `GetTimelineAsync` :353 |
| **G. `author{login avatarUrl}` extraction** | same `TryGetProperty`+`ValueKind==String` null-dance ×3 | `GitHubReviewService.cs` :1018, :1079, :1116 |
| **H. Tuning constants** | `ConcurrencyCap = 8` declared 4×; page sizes as bare `per_page=…`/`first:…` vs named consts | `GitHubReviewService` :391, `GitHubPrEnricher` :12, `GitHubAwaitingAuthorFilter` :12, `GitHubCiFailingDetector` :11; page-size literals scattered |

### 1.2 Observed drift (the bug this fixes)

`X-GitHub-Api-Version: 2022-11-28` is sent by only **2 of 15** sites (`SendGitHubAsync`
and the feedback submitter). Every Inbox/Activity request and `GetCommitAsync` /
`GetFileContentAsync` omit it, contradicting `SendGitHubAsync`'s own comment ("recommended
by GitHub for all REST calls"). The magic UA string `"PRism/0.1"` appears 15× and the
version number would rot in 15 places.

## 2. Goals / non-goals

**Goals**
- One definition each of the UA string and the GitHub header set.
- Every REST call sends `X-GitHub-Api-Version` (closes the drift).
- One Link-header parser, one 429 throw, one error-body-wrap helper; satellite copies deleted.
- **No GraphQL query text change** — fragment extraction is byte-identical textual composition.
- `dotnet test` green; behavior preserved everywhere except the inert header addition.

**Non-goals**
- No change to *what* any endpoint fetches, parses, or returns (pure provider-internal refactor).
- No `GitHubReviewService` god-object decomposition (tracked separately by the epic).
- No DI/lifetime changes to the 10 classes (see §4.1 rejected alternative).
- Not in this PR: group **E** (`pulls/{n}` union record) and force-merging semantically-distinct
  page sizes — see §5.

## 3. Acceptance criteria

1. `"PRism/0.1"` and the `Accept` / `X-GitHub-Api-Version` header set are defined **exactly
   once** in production code (`grep -c "PRism/0.1"` over `PRism.GitHub/**` non-test = 1).
2. **All** REST calls send `X-GitHub-Api-Version: 2022-11-28`, including the three
   previously-missed Activity readers. (GHES-inert where unsupported — see §6.)
3. Exactly one Link-header parser, one 429-throw, one error-body-wrap helper; the satellite
   copies are deleted.
4. The two production GraphQL query strings (`PrDetailGraphQLQuery`, `GetTimelineAsync`'s
   `query`) are **byte-identical** to their current values, pinned by a characterization test.
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

    // Resolves the token via the caller's existing delegate, applies the standard
    // header set, attaches optional content, and sends. `accept` overrides AcceptJson
    // (e.g. GetFileContentAsync's raw media type); `apiVersion:false` is reserved for
    // any future call that must NOT send the version header (none today).
    internal static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpMethod method, string url,
        Func<Task<string?>> readToken, CancellationToken ct,
        HttpContent? content = null, string? accept = null, bool apiVersion = true)
    { /* build request, apply headers, send */ }
}
```

**Why static, not an injected `IGitHubHttp`.** The helper holds no state and does no
policy — it is a pure function of `(http, method, url, token)`. Injecting it would add a
constructor parameter to **10 sealed classes** and their test fixtures for zero behavioral
benefit, and the classes do not share a single client name (`"github"` vs the feedback
submitter's `"github.com"`), so there is nothing to centralize in an instance. A static
helper that takes the already-injected `_readToken` delegate is the minimal diff and is
trivially unit-testable with a stub `HttpMessageHandler`. The empty-token guard
(`if (!string.IsNullOrEmpty(token))`) moves inside the helper, removing that duplicate too.

**`X-GitHub-Api-Version` on GraphQL.** `PostGraphQLAsync` will route through the same header
application. The REST version header is ignored by the GraphQL endpoint, so this is inert
there; it keeps a single header path rather than a GraphQL-special-case.

### 4.2 `GitHubLinkHeader` — one parser, caller-side adapters

The three parsers differ only in their *return shape*, not their RFC-8288 parsing. Extract
the parsing once; preserve each caller's exact current semantics with a one-line adapter.

```csharp
internal static class GitHubLinkHeader
{
    // Returns the absolute URL GitHub put in the `Link` header for the given rel
    // ("next" | "last" | ...), or false if absent. Handles quoted and unquoted rel.
    internal static bool TryGetRel(HttpResponseMessage resp, string rel, out string url);
}
```

Caller adapters (behavior-preserving):
- **`TryParseLastPage`** (rel=`last`, wants the `&page=N` value): `TryGetRel(resp,"last",out var u)` → parse the `page` query param from `u`. The page-extraction stays at the caller (it is a `last`-specific concern, not Link parsing).
- **`ExtractNextLink`** (rel=`next`, wants a *relative* path to reuse `BaseAddress`): `TryGetRel(resp,"next",out var u)` → `new Uri(u).PathAndQuery.TrimStart('/')`.
- **`TryGetNextLink`** (rel=`next`, wants an *absolute* `Uri`): `TryGetRel(resp,"next",out var u)` → `new Uri(u)`.

The relative-vs-absolute divergence is **deliberately preserved** — the two callers resolve
against different `BaseAddress` expectations, and "simplify both to absolute" is a behavior
change this refactor will not make (§ rejected alternatives).

### 4.3 `ThrowIfRateLimited` — one 429 throw

```csharp
// On HTTP 429, throw RateLimitExceededException(message, resp.Headers.RetryAfter?.Delta).
// No-op otherwise. Replaces the 5 inline blocks.
internal static void ThrowIfRateLimited(HttpResponseMessage resp);
```

The current five blocks share an identical message ("GitHub rate-limited (429); orchestrator
should skip this tick."). That single message moves into the helper.

### 4.4 Error-body wrap + created-entity parse

```csharp
// Best-effort body read (CA1031-suppressed in this ONE audited place), then throw
// HttpRequestException with statusCode populated and a truncated body in the message.
// `context` is the caller's label ("GitHub GraphQL", "GitHub review comment POST", ...).
internal static async Task ThrowGitHubHttpErrorAsync(
    HttpResponseMessage resp, string context, CancellationToken ct);

// Reads { id:int64, created_at:string } → (long Id, DateTimeOffset CreatedAt); throws
// HttpRequestException(statusCode: OK) on a missing field. Shared by ReviewComments /
// IssueComments success paths.
internal static (long Id, DateTimeOffset CreatedAt) ParseCreatedEntity(JsonElement root, string context);
```

`PostGraphQLAsync` keeps its extra transport-failure **log** call (`s_graphqlTransportFailed`)
at the caller — it is GraphQL-specific telemetry, not part of the shared wrap. The helper
owns only the read-body-then-throw shape; the GraphQL caller logs, then calls it (or the
helper returns the body for the caller to log; decided in the plan to keep the log call-site
intact). The `Truncate` helper stays where it is and is reused.

### 4.5 `ReadActor` — author extraction (group G)

```csharp
// (login, avatarUrl) from an `author{login avatarUrl}` node; ("", null) when absent.
internal static (string Login, string? AvatarUrl) ReadActor(JsonElement node);
```

Replaces the three inline null-dances. Pure JSON read; zero behavior risk.

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

Composition (verified byte-equal to the originals):
- PR-detail: `… + TimelineItemsArgs + "{pageInfo{hasNextPage endCursor} " + TimelineNodes + "}" + …`
- Timeline: `… + TimelineItemsArgs + "{" + TimelineNodes + "}" + …`

This brings the previously-unprotected `GetTimelineAsync` copy under a characterization test
(AC #4). Extraction is the *only* change here — no schema/shape edit.

### 4.7 `ConcurrencyCap` (subset of group H)

Collapse the four identical `ConcurrencyCap = 8` declarations into one
`internal const int GitHubLimits.ConcurrencyCap = 8`. Page sizes are **not** force-merged
(see §5).

## 5. Scope boundary (what lands vs. defers)

**Lands in this PR** (AC-mandated + cheap/safe): A (headers + UA const), B (429), C (Link),
D (error-wrap + created-entity parse), F (timeline fragment), G (`ReadActor`), and the
`ConcurrencyCap` consolidation from H.

**Deferred** (filed as a follow-up issue, cross-linked from this PR):
- **Group E — `pulls/{n}` union record.** `PollPullMeta` carries `Mergeability`/`Merged`,
  which feeds the active-PR mergeability surface (#259/#270) — a B2-adjacent concern. Merging
  it with `PullMeta` couples two consumers and restructures a model that touches mergeability
  semantics; that does not belong in a "transport plumbing" PR whose safety rests on being
  behavior-preserving. Defer to keep this PR hands-off.
- **Aggressive page-size consolidation.** `per_page=1` (existence probe), `per_page=50`
  (sections), `per_page=100` (full pagination), and `first:50`/`first:100` (GraphQL) are
  **different limits for different endpoints**, not one concept. Forcing them into a single
  `GitHubLimits` surface would be false consolidation that obscures intent. Where a page size
  is currently an unnamed literal it may get a *local* named const, but cross-endpoint merging
  is out of scope.

This split keeps the PR's risk envelope at "behavior-preserving + one inert header" while
still satisfying every acceptance criterion.

## 6. Behavior change: `X-GitHub-Api-Version` everywhere

Routing the previously-omitting sites through `GitHubHttp.SendAsync` means they start sending
`X-GitHub-Api-Version: 2022-11-28`. Intended. On github.com this pins the documented API
version (the current default — no response change). On GHES the header is ignored where the
version is unsupported, so it is inert. One sentence to this effect goes in the PR body.

## 7. Risk surface (B2 pre-PR re-check)

The shared transport underlies `PostGraphQLAsync` and the issue/review-comment POST paths,
which sit beneath the **reviewer-atomic submit pipeline** (a B2 surface). The refactor is
behavior-preserving on those paths: same auth, same body, same error shape, plus the inert
version header. The atomic-submit GraphQL sequence (`addPullRequestReview` →
thread/reply → `submitPullRequestReview`) and its pending-review-id handling are **not
touched**. At pre-PR re-check (workflow step 7) the committed diff is re-read against the
Axis-B table; if any submit-path *semantic* shifted, the issue re-classifies to gated (B2)
and routes to the human gate before the PR opens.

## 8. Testing strategy (TDD)

Behavior-preserving refactor → the proof is **characterization tests written before the
refactor** (pin current behavior, stay green through the change) plus targeted unit tests for
the new helpers.

1. **GraphQL byte-identity (AC #4).** Pin `PrDetailGraphQLQuery` and `GetTimelineAsync`'s
   query string to their exact current bytes (the frozen-shape integration test already covers
   the former; add an explicit pin for the latter). Refactor → both stay green.
2. **Header presence (AC #1/#2).** Unit-test `GitHubHttp.SendAsync` via a stub
   `HttpMessageHandler`: asserts UA / Accept / `X-GitHub-Api-Version` / Bearer present; Accept
   override honored; empty token → no Authorization header. Add a regression test that a
   previously-omitting reader (e.g. `GitHubReceivedEventsReader`) now sends the version header.
3. **Link parser parity (AC #3).** Table-test `GitHubLinkHeader.TryGetRel` across quoted /
   unquoted rel, multi-rel headers, missing header; plus per-caller adapter tests proving the
   relative-path / absolute-Uri / last-page outputs equal the pre-refactor outputs.
4. **429 (AC #3).** `ThrowIfRateLimited` throws on 429 with `RetryAfter.Delta`, no-ops otherwise.
5. **Error-wrap + created-entity (AC #3).** `ThrowGitHubHttpErrorAsync` populates `StatusCode`
   and truncates the body; `ParseCreatedEntity` returns id/created_at and throws on a missing field.
6. **Full suite (AC #5).** `dotnet test` Release across all four projects; zero new warnings.

The existing endpoint/integration tests for the 10 classes are the backstop that the
call-site rewrites preserved behavior.

## 9. Rejected alternatives

- **Injected `IGitHubHttp` collaborator** — more churn (ctor + fixture changes across 10
  sealed classes), no shared state to justify it. Static helper wins on minimal-diff +
  testability. (§4.1)
- **Merge `PollPullMeta` + `PullMeta` now** — B2-adjacent (mergeability) and not AC-required;
  deferred. (§5)
- **Force page sizes into one `GitHubLimits`** — false consolidation of distinct endpoint
  limits. (§5)
- **Simplify both `next`-link callers to absolute URLs** — a real behavior change to URL
  resolution against differing `BaseAddress`; out of scope for a behavior-preserving refactor. (§4.2)
- **Fold the GraphQL transport-failure log into the shared wrap** — the log is GraphQL-specific
  telemetry; keep it at the caller, share only the throw shape. (§4.4)

## 10. Self-review

- **Placeholders:** none.
- **Consistency:** AC ↔ design ↔ scope cross-checked; groups A–D + F + G + ConcurrencyCap map
  to §4; E + page sizes explicitly deferred in §5 with rationale.
- **Scope:** single coherent refactor; the riskiest satellite (E) is carved out to hold the
  hands-off envelope.
- **Ambiguity:** the one load-bearing claim ("byte-identical") is made falsifiable by the
  §8.1 characterization pin.
