# Decompose `GitHubReviewService` — PR2 (submit split + transport + logging)

- **Issue:** #321 (epic #317, code-quality review). Tier T3, **gated B2** — this slice carries the human gate.
- **This slice:** PR2 of 2 — touches `Submit.cs`, the enumerated reviewer-atomic risk surface. **Closes #321.**
- **Date:** 2026-06-13
- **Worktree / branch:** `D:/src/PRism-321-pr2` / `feature/321-decompose-pr2-submit`
- **Builds on:** PR1 (#460, merged) which extracted `GitHubPrParser` + `GitHubAuthValidator`.

## Problem

After PR1, `GitHubReviewService` still implements **three** capability interfaces at once:

```csharp
public sealed partial class GitHubReviewService : IPrDiscovery, IPrReader, IReviewSubmitter
```

Two of issue #321's acceptance criteria remain open:

1. **"No class implements more than one capability interface (or a documented pairing like
   Reader+Discovery)."** Three interfaces on one class is neither single-capability nor the allowed
   pairing.
2. **"One logging declaration style in the project."** The project mixes two styles: the
   source-generated `[LoggerMessage]` partial (dominant — used by `GitHubReviewService.Log`,
   `GitHubAwaitingAuthorFilter`, `GitHubSectionQueryRunner`) and four hand-rolled
   `LoggerMessage.Define` static fields with manually-assigned `EventId`s (2,3 in `Submit.cs`; 4,5 in
   `GitHubReviewService.cs`) split across partials — the collision-prone pattern the issue calls out.

PR2 closes both, plus folds in two cleanups deferred from PR1's bot review.

## Scope

In scope:

- **Split `IReviewSubmitter`** out of `GitHubReviewService` into a new `GitHubReviewSubmitter` class.
- **Extract a shared GraphQL transport** (`GitHubGraphQL.PostAsync`, static) so the reader and the new
  submitter both issue GraphQL POSTs through one provably-identical function — this is the change that
  rewires how `Submit.cs` obtains its transport, i.e. the B2 surface.
- **Move the shared pure helpers** `TryGetPath` and `Truncate` to a shared static so both halves use
  one copy (no duplication, no edit-in-place divergence).
- **Converge logging:** convert the four `LoggerMessage.Define` fields to `[LoggerMessage]` partials
  (this alone satisfies the "one logging style" AC), and pin **explicit EventIds on every method in the
  three touched Log classes** — preserving current operator-facing Ids — so those classes are
  collision-free without depending on the generator's default-EventId behavior. The two untouched
  all-source-gen classes are left as-is (see *Logging convergence*).
- **Fold-in 1:** `GitHubAuthValidator.IsDnsFailure` reads `se.Message` (the inner `SocketException`)
  instead of `ex.Message` (the `HttpRequestException` wrapper) — with a regression test.

Out of scope (explicit non-goals):

- **Moving `ParseFileChanges` into `GitHubPrParser`** (claude[bot]'s "once `_log` can travel"
  suggestion). Deliberately **not done** — see *Decision: ParseFileChanges stays on the reader*.
- Any behavioral change to the read path, the submit pipeline's GraphQL shapes, or the auth path
  (beyond fold-in 1).
- Caching the PR node ID, decomposing the reader further, or renaming `PRism.Core` contracts.

## Approach decision: static transport function (Approach A)

The read path (`GetPrDetailAsync`, `GetTimelineAsync`) and the submit pipeline (`Submit.cs`,
`ReviewComments.cs`) both reach the network through the instance method `PostGraphQLAsync`
(`GitHubReviewService.cs:558`). Its `apiVersion:false` byte-identity (pinned by the integration
shape-drift test, and noted at `GitHubReviewService.cs:567-570`) is the B2 contract: a submit GraphQL
request must remain wire-identical across this refactor. Splitting the submitter into its own class
means that one method can no longer be a private instance method shared by inheritance — the transport
must become a collaborator both classes reach.

**Chosen: Approach A — a static transport function**, mirroring how #320 already made
`GitHubHttp.SendAsync` a static shared by 10 classes:

```csharp
// new file PRism.GitHub/GitHubGraphQL.cs
internal static class GitHubGraphQL
{
    // The raw GraphQL POST: resolves the host's GraphQL endpoint, sends apiVersion:false
    // (byte-identical to the pre-split PostGraphQLAsync), logs transport failures, throws
    // HttpRequestException on non-2xx. Returns the raw JSON body.
    internal static async Task<string> PostAsync(
        HttpClient http, string? token, string host, ILogger log,
        string query, object variables, CancellationToken ct) { ... }
}
```

Both halves keep their own thin token-read + `factory.CreateClient("github")` cadence (consistent with
how the other 10 classes already read their own token) and call `GitHubGraphQL.PostAsync(...)` for the
raw POST. The read-side error wrapper `ThrowIfGraphQLErrorsWithoutData` stays on the reader; the
submit-strict wrapper `PostSubmitGraphQLAsync` stays on the submitter — each just delegates its raw POST
to the one static.

**Why not Approach B (an instance `GitHubGraphQLTransport` collaborator injected via DI):** it adds a
DI registration, the reader still holds `factory`/`readToken`/`host` for its many REST calls so it
doesn't actually shrink, it creates two token-read sources, and the test factory must build + inject the
collaborator — more moving parts for the identical byte-identity guarantee. Approach A keeps the risk
surface in a single function with two callers, needs zero new DI wiring, and leaves test construction
shape unchanged. (Owner-approved 2026-06-13.)

## What moves, what stays

### New file: `PRism.GitHub/GitHubGraphQL.cs` — `internal static class GitHubGraphQL`

Holds the raw GraphQL transport relocated from `GitHubReviewService.PostGraphQLAsync` **verbatim**
(same `HostUrlResolver.GraphQlEndpoint`, same `apiVersion:false`, same non-2xx → `HttpRequestException`
with truncated body, same transport-failed log), reshaped only from an instance method
(`_httpFactory`/`_readToken`/`_host`/`_log` fields) to a static taking `(http, token, host, log, …)`.
The transport-failed log (EventId 5, `GraphQLTransportFailed`) moves here as a `[LoggerMessage]`
partial on a nested `Log` class.

**Mandatory constraint (security — the PAT credential guard): `GitHubGraphQL.PostAsync` MUST send via
`GitHubHttp.SendAsync`, never `http.SendAsync` directly.** The same-host credential guard
(scheme+host+port match against `BaseAddress`, refusing to attach the Bearer PAT to an off-host absolute
URL) lives in `GitHubHttp.ApplyHeaders`, which is reached **only** through `GitHubHttp.SendAsync`. The
current `PostGraphQLAsync` already routes through it (`GitHubReviewService.cs:572`); a careless "verbatim"
move that instead hand-builds an `HttpRequestMessage` + calls `http.SendAsync` would silently drop the
guard and let the PAT ride an attacker-influenced GHES endpoint URL. This is an explicit acceptance
criterion (see *Verification*), verified by grep (`GitHubGraphQL.cs` contains no bare `http.SendAsync`)
and by a header-attachment assertion mirroring the existing reader-side `AuthHeaderTests`.

`Truncate` and `TryGetPath` also land in shared `internal static` homes (no body change; reader and
submitter both call the shared copy):

| Helper | New home | Rationale |
|--------|----------|-----------|
| `TryGetPath(JsonElement, …)` | `GitHubGraphQL` | JSON path-walk over GraphQL response shapes; used by the reader read path + all submit methods |
| `Truncate(string, int)` | `GitHubHttp` | truncates HTTP **error bodies**; `GitHubHttp` already owns the sibling `ReadErrorBodyBestEffortAsync`, and `Truncate` is used by both the GraphQL transport error path and the REST comment-POST error paths — `GitHubHttp` is the home both reach without a new dependency |

### New file(s): `PRism.GitHub/GitHubReviewSubmitter.cs` (+ partials) — `internal sealed partial class GitHubReviewSubmitter : IReviewSubmitter`

The three submit partials move here, renamed from `GitHubReviewService.*` to `GitHubReviewSubmitter.*`,
class declaration changed, **bodies byte-identical**:

| Current file | New file | Members |
|--------------|----------|---------|
| `GitHubReviewService.Submit.cs` | `GitHubReviewSubmitter.Submit.cs` | the 7 pending-review methods + `PostSubmitGraphQLAsync`, `ResolvePullRequestNodeIdAsync`, `ProjectPendingReviewThread`, `ReadInt`, the submit logger fields (EventIds 2,3) |
| `GitHubReviewService.ReviewComments.cs` | `GitHubReviewSubmitter.ReviewComments.cs` | `CreateReviewCommentAsync`, `CreateReviewCommentReplyAsync` |
| `GitHubReviewService.IssueComments.cs` | `GitHubReviewSubmitter.IssueComments.cs` | `CreateIssueCommentAsync` |

Constructor — same three dependencies the submit path actually uses (it reads the token, builds the
`github` client, posts GraphQL/REST, and logs):

```csharp
internal sealed partial class GitHubReviewSubmitter(
    IHttpClientFactory httpFactory,
    Func<Task<string?>> readToken,
    string host,
    ILogger<GitHubReviewSubmitter>? log = null) : IReviewSubmitter
```

The submitter gets its own thin `SendGitHubAsync` (the 3-line token-read wrapper over
`GitHubHttp.SendAsync`, used by the REST comment paths) — a verbatim copy of the reader's, which is the
deliberate per-class token-read cadence #320 established, not meaningful duplication. Its
`PostSubmitGraphQLAsync` now calls `GitHubGraphQL.PostAsync(...)` for the raw POST and keeps its strict
errors-array check (unchanged). The submit logger fields (EventIds 2,3) become `[LoggerMessage]`
partials on a nested `Log` class.

`internal sealed` (not `public`); constructed via DI and the test factory (InternalsVisibleTo).

### `GitHubReviewService` after PR2

Drops the three submit partials, `PostGraphQLAsync` (moved to `GitHubGraphQL`), and the shared statics
`TryGetPath` / `Truncate` (moved). Its class declaration becomes the **documented Reader+Discovery
pairing**:

```csharp
public sealed partial class GitHubReviewService : IPrDiscovery, IPrReader
```

Read-path call sites change by qualification only: `PostGraphQLAsync(...)` → a thin local that reads the
token + builds the client + calls `GitHubGraphQL.PostAsync(...)` (or inline at the two call sites —
decide in plan to keep the read error-handling readable); `TryGetPath(...)` → the shared static;
`Truncate(...)` → the shared static. `ThrowIfGraphQLErrorsWithoutData` and its read-failed log
(EventId 4) stay on the reader (read-specific error tolerance) — converted to `[LoggerMessage]`.
The cap-hit trio, the per-commit fan-out, `ParseFileChanges`, the query consts, and `TryParsePrUrl`
stay exactly as in PR1.

### DI: `ServiceCollectionExtensions.AddPrismGitHub`

```csharp
// before (PR1): one GitHubReviewService singleton aliased to all three remaining interfaces
services.AddSingleton<GitHubReviewService>(sp => new GitHubReviewService(factory, …, host, log));
services.AddSingleton<IPrDiscovery>(sp => sp.GetRequiredService<GitHubReviewService>());
services.AddSingleton<IPrReader>(sp => sp.GetRequiredService<GitHubReviewService>());
services.AddSingleton<IReviewSubmitter>(sp => sp.GetRequiredService<GitHubReviewService>());

// after (PR2): GitHubReviewService backs Reader+Discovery; GitHubReviewSubmitter backs Submit
services.AddSingleton<GitHubReviewService>(sp => new GitHubReviewService(factory, …, host, log));
services.AddSingleton<IPrDiscovery>(sp => sp.GetRequiredService<GitHubReviewService>());
services.AddSingleton<IPrReader>(sp => sp.GetRequiredService<GitHubReviewService>());
services.AddSingleton<IReviewSubmitter>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubReviewSubmitter(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        config.Current.Github.Host,
        sp.GetRequiredService<ILogger<GitHubReviewSubmitter>>());
});
```

The two blocks above show **only the delta** — the `IReviewSubmitter` rebinding. The rest of
`AddPrismGitHub` is unchanged and elided: the PR1 `IReviewAuth` → `GitHubAuthValidator` registration
stays exactly as it is, as do the named `github` `HttpClient` and all inbox/activity registrations
(`ISectionQueryRunner`, `IPrEnricher`, `IAwaitingAuthorFilter`, `ICiFailingDetector`, the activity
readers). `IReviewSubmitter` is the **only** binding that moves in PR2.

The host capture + token closure mirror the existing `GitHubReviewService` registration exactly (same
late-binding behavior, not a regression). The XML-doc summary on `AddPrismGitHub` updates so the
`GitHubReviewService` clause reads "bound to the Reader+Discovery pairing (`IPrDiscovery`, `IPrReader`)"
and a new clause notes "`GitHubReviewSubmitter` bound to `IReviewSubmitter`" — without disturbing the
existing `GitHubAuthValidator`/`IReviewAuth` sentence. No consumer injects the concrete
`GitHubReviewService` for submit — verified: only the interface-binding lambdas reference the concrete
type, and `IReviewSubmitter` is the only rebinding.

**Singleton-identity note (behavior change, intentional and safe):** before PR2, the same
`GitHubReviewService` instance backed `IReviewSubmitter` and the reader; after PR2 they are two
instances. No consumer casts between capability interfaces or relies on `ReferenceEquals` across them —
both classes hold only immutable `readonly` DI fields (factory, token closure, host, logger), so there
is no shared mutable state to preserve. This is the same reasoning PR1 used for the
`IReviewAuth` → `GitHubAuthValidator` split, and the same DI-alias pattern.

## Logging convergence

Convert the four `LoggerMessage.Define` fields to `[LoggerMessage]` source-gen partials and place each
on the `Log` nested class of whichever class now owns it:

| Current field | EventId | New home | New `[LoggerMessage]` method |
|---------------|---------|----------|------------------------------|
| `s_graphqlSubmitFailed` (`Submit.cs:509`) | 2 | `GitHubReviewSubmitter.Log` | `GraphQLSubmitFailed` |
| `s_graphqlSubmitNoData` (`Submit.cs:513`) | 3 | `GitHubReviewSubmitter.Log` | `GraphQLSubmitNoData` |
| `s_graphqlReadFailed` (`GitHubReviewService.cs:634`) | 4 | `GitHubReviewService.Log` | `GraphQLReadFailed` |
| `s_graphqlTransportFailed` (`GitHubReviewService.cs:599`) | 5 | `GitHubGraphQL.Log` | `GraphQLTransportFailed` |

Preserve each message template, level (Warning for 4/5, Error for 2/3), and EventId number/name
verbatim — operators grep on these.

**What satisfies the AC, and what's scoped where.** The AC is *"one logging declaration style in the
project."* It is met the moment the four `LoggerMessage.Define` fields become `[LoggerMessage]`
partials — after that, every log declaration in `PRism.GitHub` is source-generated, and
`grep -rn "LoggerMessage.Define" PRism.GitHub/` returns **zero** (the AC's verifiable form). Assigning
explicit EventIds to *every* log method project-wide is **not** required by the AC and is explicitly out
of scope — the two all-source-gen classes this PR does not otherwise touch
(`GitHubAwaitingAuthorFilter`, 2 methods; `GitHubSectionQueryRunner`, 4 methods) are **left alone**:
they are already single-style, their EventIds are generator-managed and internally consistent, and
editing them would inflate a B2 diff for no AC benefit.

**Within-class collision is the real risk, and it is bounded to the three Log classes this PR edits.**
The source generator enforces EventId uniqueness *per class*, not per assembly — so the only place a
collision can arise is a Log class that ends up mixing explicit EventIds (the preserved 2–5) with
implicit ones. That happens only in `GitHubReviewService.Log`, where `GraphQLReadFailed` (explicit 4)
will sit beside the four currently-implicit methods (`FanOutDegraded`/`TimelineCapHit`/
`DiffPagesCapped`/`PatchParseFailed`). To make that class deterministic, **assign explicit EventIds to
all methods in the three touched Log classes** — `GitHubReviewService.Log`, `GitHubReviewSubmitter.Log`
(keep 2,3), `GitHubGraphQL.Log` (keep 5).

**Preserve operator-facing EventIds *consistently* — including the four previously-implicit ones.** The
"operators grep on these" principle that protects 2–5 applies equally to the four already-`[LoggerMessage]`
reader methods: each currently emits *some* generator-assigned `EventId.Id`, and an operator alert could
key on it. So the implementation's first step is the empirical probe (inspect the generated source) to
read those four current Ids, then **pin each method to the Id it already emits** — making the explicit
assignment a no-op for operators, not a renumber. `GraphQLReadFailed` keeps 4; if the probe shows it
would collide with a reader method's current Id within `GitHubReviewService.Log`, that collision exists
*today* (latent) and the probe is what surfaces it — resolve by giving `GraphQLReadFailed` the next free
Id and recording the one changed event in the PR's change story. If the probe shows the four reader
methods currently share a single Id (e.g. all `0`, indistinguishable), assign them distinct stable Ids —
a strict improvement, explicitly noted as such since no operator could have keyed on indistinguishable
events. The point: **do not arbitrarily renumber an operator-visible EventId; pin to current, and flag
any Id that genuinely must change.** This touches no file outside the split.

**Note (accepted consequence): the transport log's category changes by caller.** `GraphQLTransportFailed`
(EventId 5) moves onto the static `GitHubGraphQL.Log` and is invoked with whatever `ILogger` the caller
passes — `ILogger<GitHubReviewService>` from the reader, `ILogger<GitHubReviewSubmitter>` from the
submitter. Today it is always emitted under the `…GitHubReviewService` category. After the split the same
EventId 5 event can surface under either category depending on which path failed. This is acceptable —
the EventId and message template are preserved (the operator's primary grep key), and the category
actually carries *more* signal (which capability hit the transport failure), not less.

The per-class (not project-wide) scope of the generator's duplicate-EventId build error is why
"collision-free" here is an **inspection-verified** property within the three touched classes plus the
green build, not an assembly-wide build guarantee.

## Decision: `ParseFileChanges` stays on the reader

claude[bot] (PR1) suggested moving `ParseFileChanges` into `GitHubPrParser` "once `_log` can travel."
**Not done, by decision.** `ParseFileChanges` parses GitHub's per-file unified-diff `patch` field into
`DiffHunk`s and logs `PatchParseFailed` on a parser fault — it is diff-fetch logic owned by the
diff-*fetching* reader (`GetDiffAsync` → `PaginatePullsFilesAsync`/`FetchCompareFilesAsync`), not a
generic JSON→DTO mapper. `GitHubPrParser`'s entire PR1 identity is *pure, logger-free, side-effect-free*
DTO parsing; pushing a logger-dependent method into it to satisfy a colocation instinct trades a clean
boundary for a muddier one. Recorded here as a deliberate won't-do so a future reader doesn't
re-litigate it as an oversight.

## Tests

The submit relocation is mechanical (type + file rename, bodies byte-identical); the transport/helper
extraction is behavior-preserving. Changes:

The submitter relocation is mechanical (type + file rename, bodies byte-identical); the
transport/helper extraction is behavior-preserving. The SUT-swap surface is **every test whose helper
returns `GitHubReviewService` and calls a method that moves to `GitHubReviewSubmitter`** — that is all
eight `Submit*`/comment test files, not the four originally listed (round-1 review caught the
under-count: `SubmitFinalize`/`AttachThread`/`AttachReply`/`Delete` were missing and would fail to
compile after the move). The plan must verify the complete set by grepping
`tests/PRism.GitHub.Tests/` for helpers returning `GitHubReviewService` that call a moved method —
do **not** rely on this table being exhaustive; treat it as the known set to confirm-and-extend.

| Test surface | Change |
|--------------|--------|
| `GitHubReviewServiceFactory.cs` (TestHelpers) | Add a `CreateSubmitter(handler, readToken?)` returning `GitHubReviewSubmitter` (same FakeHttpClientFactory / host / `ghp_test` wiring as `Create`). Keep `Create` (still builds the reader for read-path tests). |
| **All eight submit/comment test files** — `GitHubReviewServiceSubmitBeginTests`, `…SubmitFinalizeTests`, `…SubmitAttachThreadTests`, `…SubmitAttachReplyTests`, `…SubmitDeleteTests`, `…SubmitFindOwnTests`, `…ReviewCommentsContractTests`, `…IssueCommentsTests` | `NewService`/SUT helper return type `GitHubReviewService` → `GitHubReviewSubmitter`, constructed via `GitHubReviewServiceFactory.CreateSubmitter(...)`. **No assertion changes** — same methods, same fake responses. (Test-class file names may stay as-is; renaming is discretionary churn.) |
| `GraphQlByteIdentityTests.cs` | **Split, not untouched.** The two query-const facts (`PrDetailGraphQLQuery` / `TimelineQuery`) stay against `GitHubReviewService` (consts stay on the reader). The existing `SubmitPath_graphql_request_transport_is_unchanged` fact — which constructs the SUT and calls `FinalizePendingReviewAsync` — **must migrate to `CreateSubmitter(...)` and call `GitHubReviewSubmitter.FinalizePendingReviewAsync`**, with its byte-identity assertion preserved unchanged (this is the B2 wire-identity guard — do not weaken it to make the build pass). |
| Other read-path tests (`PrDetailTests`, `TimelineTests`, `AuthHeaderTests`, `PrUrlParsingTests`, etc.) | **Untouched** — they construct `GitHubReviewService` and call read/discovery methods (`TryParsePrUrl` included), which still exist on it. |
| `PRism.Core.Tests/Submit/**` | **Untouched** — they exercise `SubmitPipeline` against the `InMemoryReviewSubmitter` fake / `IReviewSubmitter`, never the concrete GitHub class. |
| `PRism.Web.Tests` submit/comment endpoint tests | **Untouched** — they use `IReviewSubmitter` fakes (`SubmitEndpointFakes`, `PrDetailFakeReviewService`), resolved via DI, so the concrete rebind is transparent. |
| **New:** `GitHubAuthValidatorDnsFailureTests.cs` (fold-in 1) | See *Fold-in 1* for the exact two-case test design. |

**Byte-identity guard (the B2 contract).** A submit-side GraphQL transport test **already exists**:
`GraphQlByteIdentityTests.SubmitPath_graphql_request_transport_is_unchanged`. The transport extraction
must keep it green, with the SUT-construction migration above (`Create` → `CreateSubmitter`). (Earlier
drafts said the plan would "add a submit-side assertion if missing" — it is not missing; the work is to
*re-point* it.)

**But that test pins the request URI + headers only — not the request body** (it asserts `RequestUri`,
`UserAgent`, `Accept`, absent `X-GitHub-Api-Version`, and the `Authorization` parameter; it never reads
`req.Content`). The dimension most likely to drift in a serialization-touching transport move — the
`StringContent` media type/encoding (`new StringContent(payload, UTF8, "application/json")`) and the
`{query, variables}` payload bytes/property order — is therefore **unguarded** today. Since this PR is
the transport move, **strengthen the assertion to also pin the body**: capture
`await req.Content.ReadAsStringAsync()` and assert the serialized `{query,variables}` payload is
byte-equal, plus `req.Content.Headers.ContentType` is `application/json; charset=utf-8`. This closes the
gap the security grep ("no bare `http.SendAsync`") cannot — the grep proves the PAT guard stays in the
call chain but says nothing about the `StringContent` construction. Only with the body pinned is "keeps
the test green" an honest proof of submit-request byte-identity. The read-side integration shape-drift
test likewise stays green.

## Fold-in 1: `IsDnsFailure` reads the inner `SocketException`'s message

Current (`GitHubAuthValidator.cs:110-119`):

```csharp
if (ex.InnerException is SocketException se)
{
    return se.SocketErrorCode == SocketError.HostNotFound
        || ex.Message.Contains("Name or service not known", …)   // ← reads the WRAPPER's message
        || ex.Message.Contains("No such host", …);
}
```

The "Name or service not known" / "No such host" strings originate on the inner `SocketException`
(`se.Message`); reading them off the `HttpRequestException` wrapper (`ex.Message`) is the latent bug
claude[bot] flagged. Fix: read `se.Message` for both string checks. This is a small **behavior** tweak
(it changes which messages match on platforms where the wrapper and inner messages differ), so it ships
**with a regression test**, not silently. `SocketErrorCode == HostNotFound` already covers the primary
path; the string fallbacks cover platforms/locales where the code isn't surfaced.

**Test design (round-1 review caught a trap).** The *existing* DNS test in
`GitHubReviewService_ValidateCredentialsAsyncTests` constructs
`new HttpRequestException("Name or service not known", new SocketException(11001))` — and `11001` **is**
`SocketError.HostNotFound`, so that test passes via the `SocketErrorCode == HostNotFound` branch
**regardless** of whether the string check reads `ex.Message` or `se.Message`. It therefore does *not*
pin the fix. The new `GitHubAuthValidatorDnsFailureTests` needs **two** cases:

1. `SocketErrorCode == HostNotFound` (any messages) → `DnsError` — the primary-path guard (mirrors the
   existing test).
2. `SocketErrorCode` set to a **non-`HostNotFound`** value (e.g. `SocketError.TryAgain`), with the
   "No such host" / "Name or service not known" string present **only on `se.Message`** and a neutral
   `ex.Message` → still `DnsError`. This case is green only when the code reads `se.Message`, so it is
   the one that actually pins fold-in 1.

**Commit hygiene.** Ship fold-in 1 (the `IsDnsFailure` change + its test) as its **own commit** within
PR2, separate from the mechanical submit-split commits. It is a behavior change on the `IReviewAuth`
surface (PR1's `GitHubAuthValidator`), not the submit risk surface this PR is gated for; an isolated
commit keeps `git bisect`/blame able to separate the behavior tweak from the pure relocation, and lets
the B2 reviewer see the one non-mechanical line on its own.

*Alternative considered: ship fold-in 1 as its own tiny PR* (so the B2 gate certifies exactly one risk
surface — the submit transport). Rejected because the owner chose to close #321 in this PR, and a
one-line fix plus a two-case test is disproportionate as a standalone PR; the own-commit isolation gives
the B2 reviewer a clean, separable diff for the one behavior line. (Owner-approved fold-in, 2026-06-13.)

## Acceptance criteria mapping

From issue #321 (the two PR1 left open):

- [x] **No class implements more than one capability interface (or a documented pairing)** — PR2
  splits `IReviewSubmitter` into `GitHubReviewSubmitter`; `GitHubReviewService` is the documented
  Reader+Discovery pairing; `GitHubAuthValidator` (PR1) is single-capability.
- [x] **One logging declaration style in the project** — all four `LoggerMessage.Define` fields become
  `[LoggerMessage]` partials; `grep "LoggerMessage.Define" PRism.GitHub/` returns zero. Explicit EventIds
  are pinned on every method in the three touched Log classes (preserving current operator-facing Ids);
  the two untouched all-source-gen classes are left as-is (see *Logging convergence* — project-wide
  explicit-EventId assignment is deliberately out of scope).

Already satisfied by PR1 and unaffected here: parsers-in-own-class, DI-updated/no-contract-change,
GitHub.Tests-green-mechanical. **#321 closes on PR2 merge.**

## Risks & non-goals

- **Risk (B2): the submit GraphQL request changes wire shape during the transport move.** Mitigation:
  `GitHubGraphQL.PostAsync` is the *verbatim* body of `PostGraphQLAsync` (same endpoint resolution,
  same `apiVersion:false`, same headers via `GitHubHttp`); one function, two callers. The integration
  byte-identity test (read side) stays green, and the plan adds a submit-side request-body assertion if
  one is missing. Zero edits to any mutation string or variable shape.
- **Risk: a naive file move drags a staying member.** The submit partials are self-contained
  (`Submit.cs` references only members that move with it + the now-shared statics), but `TryGetPath` /
  `Truncate` are used by both halves. Mitigation: move those to the shared static **first** (own step),
  re-point both halves, verify build, *then* move the submit partials.
- **Risk: EventId collision after convergence.** Mitigation: the only collision-prone class is
  `GitHubReviewService.Log` (preserved explicit `4` joining four previously-implicit methods); the plan
  assigns explicit unique EventIds to all methods in the **three touched Log classes** so none mixes
  implicit + explicit. The source generator errors on duplicate EventIds **within a class** (per-class,
  not assembly-wide), so a green build proves intra-class uniqueness for those three; the two untouched
  all-implicit classes (`GitHubAwaitingAuthorFilter`, `GitHubSectionQueryRunner`) stay internally
  consistent and out of scope. "Collision-free across the touched classes" is inspection-verified, not
  an assembly-wide build guarantee — see *Logging convergence*.
- **Risk: singleton-identity change breaks a consumer.** Mitigation: documented above — no consumer
  relies on cross-interface identity; both classes are immutable-field-only. Full-solution build +
  `PRism.Web.Tests` green confirm no downstream break.
- **Non-goal:** moving `ParseFileChanges`, caching the node ID, read-path decomposition, any GraphQL
  shape change, or renaming contracts/test files.

## Verification

Pre-push gates (real binaries, per repo conventions):

- `dotnet build --configuration Release` — 0 warnings (`TreatWarningsAsErrors`), full solution (catches
  DI/accessibility/downstream breaks and any within-class EventId-duplicate generator error).
- `dotnet test --no-build --configuration Release --settings .runsettings` on `PRism.GitHub.Tests`,
  `PRism.GitHub.Tests.Integration`, `PRism.Core.Tests`, `PRism.Web.Tests` — all green. Test edits are
  the submitter SUT-type swap across **all eight** submit/comment test files + the `GraphQlByteIdentityTests`
  `SubmitPath` re-point + the two-case DNS-failure test. The `SubmitPath_graphql_request_transport_is_unchanged`
  byte-identity fact must stay green (the B2 contract).
- `grep -rn "LoggerMessage.Define" PRism.GitHub/` → empty (the "one logging style" AC's verifiable form).
- **Security AC:** `GitHubGraphQL.cs` contains no bare `http.SendAsync` — its GraphQL POST routes through
  `GitHubHttp.SendAsync` so `ApplyHeaders`' same-host PAT guard stays in the call chain; a header-attachment
  test on the new static (mirroring `AuthHeaderTests`) confirms the Bearer token is attached on the trusted
  host and refused off-host.
- Confirm the submit partials' method bodies are byte-identical to PR1 modulo the class name + the
  `PostGraphQLAsync` → `GitHubGraphQL.PostAsync` / shared-static re-points (`git diff` review).
