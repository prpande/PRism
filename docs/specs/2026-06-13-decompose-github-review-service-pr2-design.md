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
- **Converge logging:** convert the four `LoggerMessage.Define` fields to `[LoggerMessage]` partials,
  and assign **explicit, unique `EventId`s to every log method in `PRism.GitHub`** so the converged set
  is deterministic and collision-free.
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

`Truncate` (used by the transport's error path and by the comment partials' error path) and
`TryGetPath` (used 16× by the submit side and by the reader) also land in shared statics:

| Helper | New home | Rationale |
|--------|----------|-----------|
| `Truncate(string, int)` | `GitHubGraphQL` (or `GitHubHttp`) — decide in plan; transport-adjacent | used by transport error path + both comment partials |
| `TryGetPath(JsonElement, …)` | `GitHubGraphQL` (JSON path-walk over GraphQL responses) | used by reader read path + all submit methods |

Both are pure `internal static` with no body change. Reader and submitter both call the shared copy.

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

The host capture + token closure mirror the existing `GitHubReviewService` registration exactly (same
late-binding behavior, not a regression). The XML-doc summary on `AddPrismGitHub` updates to
"`GitHubReviewService` bound to the Reader+Discovery pairing (`IPrDiscovery`, `IPrReader`);
`GitHubReviewSubmitter` bound to `IReviewSubmitter`." No consumer injects the concrete
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
verbatim — operators grep on these. The existing `Log` source-gen methods
(`FanOutDegraded`/`TimelineCapHit`/`DiffPagesCapped`/`PatchParseFailed`) currently **omit** explicit
`EventId`s; the plan must (a) determine the generator's default-EventId behavior empirically and
(b) assign **explicit unique `EventId`s** to those too, so the whole `PRism.GitHub` set is deterministic
and the issue's "collision-prone" concern is actually resolved rather than relocated. Pick an EventId
block that does not clash with 2–5 (e.g. keep 2–5 as-is, assign 6–9 to the four previously-implicit
ones).

After this, `grep -rn "LoggerMessage.Define" PRism.GitHub/` returns **zero** — the AC's verifiable form.

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

| Test surface | Change |
|--------------|--------|
| `GitHubReviewServiceFactory.cs` (TestHelpers) | Add a `CreateSubmitter(handler, readToken?)` returning `GitHubReviewSubmitter` (same FakeHttpClientFactory / host / `ghp_test` wiring as `Create`). Keep `Create` (still builds the reader for read-path tests). |
| `GitHubReviewServiceSubmitBeginTests.cs`, `GitHubReviewServiceSubmitFindOwnTests.cs`, `GitHubReviewServiceReviewCommentsContractTests.cs`, `GitHubReviewServiceIssueCommentsTests.cs` | `NewService`/SUT helper return type `GitHubReviewService` → `GitHubReviewSubmitter`, constructed via `GitHubReviewServiceFactory.CreateSubmitter(...)`. **No assertion changes** — same methods, same fake responses. (Test-class file names may stay as-is; renaming is discretionary churn.) |
| Read-path tests (`PrDetailTests`, `TimelineTests`, `AuthHeaderTests`, `GraphQlByteIdentityTests`, etc.) | **Untouched** — they construct `GitHubReviewService` and call read/discovery methods, which still exist on it. `GraphQlByteIdentityTests` keeps asserting against `GitHubReviewService.PrDetailGraphQLQuery` / `.TimelineQuery` (consts stay on the reader). |
| `PRism.Core.Tests/Submit/**` | **Untouched** — they exercise `SubmitPipeline` against the `InMemoryReviewSubmitter` fake / `IReviewSubmitter`, never the concrete GitHub class. |
| `PRism.Web.Tests` submit/comment endpoint tests | **Untouched** — they use `IReviewSubmitter` fakes (`SubmitEndpointFakes`, `PrDetailFakeReviewService`), resolved via DI, so the concrete rebind is transparent. |
| **New:** `GitHubAuthValidatorDnsFailureTests.cs` (fold-in 1) | Assert that an `HttpRequestException` whose inner `SocketException` carries the host-not-found signal maps to `AuthValidationError.DnsError`, exercising the `se.Message` read. (One added test; see fold-in.) |

**Byte-identity guard:** if a GraphQL byte-identity test exists for the **submit** request shape, it
must stay green through the transport extraction — that is the B2 contract. If only the read-side shape
is pinned today, the plan adds a submit-side wire-shape assertion (request body of one mutation) so the
transport move is provably wire-identical, not merely test-passing.

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

## Acceptance criteria mapping

From issue #321 (the two PR1 left open):

- [x] **No class implements more than one capability interface (or a documented pairing)** — PR2
  splits `IReviewSubmitter` into `GitHubReviewSubmitter`; `GitHubReviewService` is the documented
  Reader+Discovery pairing; `GitHubAuthValidator` (PR1) is single-capability.
- [x] **One logging declaration style in the project** — all four `LoggerMessage.Define` fields become
  `[LoggerMessage]` partials; `grep "LoggerMessage.Define" PRism.GitHub/` returns zero; every log method
  carries an explicit unique EventId.

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
- **Risk: EventId collision after convergence.** The whole point of the AC. Mitigation: assign explicit
  unique EventIds to *all* `[LoggerMessage]` methods in `PRism.GitHub` (not just the four converted
  ones), verified by inspection + a green build (the source generator errors on duplicate EventIds
  within a class).
- **Risk: singleton-identity change breaks a consumer.** Mitigation: documented above — no consumer
  relies on cross-interface identity; both classes are immutable-field-only. Full-solution build +
  `PRism.Web.Tests` green confirm no downstream break.
- **Non-goal:** moving `ParseFileChanges`, caching the node ID, read-path decomposition, any GraphQL
  shape change, or renaming contracts/test files.

## Verification

Pre-push gates (real binaries, per repo conventions):

- `dotnet build --configuration Release` — 0 warnings (`TreatWarningsAsErrors`), full solution (catches
  DI/accessibility/downstream breaks and any EventId-duplicate generator error).
- `dotnet test --no-build --configuration Release --settings .runsettings` on `PRism.GitHub.Tests`,
  `PRism.GitHub.Tests.Integration`, `PRism.Core.Tests`, `PRism.Web.Tests` — all green, the only test
  edits being the submitter SUT-type swap + the one new DNS-failure test.
- `grep -rn "LoggerMessage.Define" PRism.GitHub/` → empty (AC's verifiable form).
- Confirm the submit partials' method bodies are byte-identical to PR1 modulo the class name + the
  `PostGraphQLAsync` → `GitHubGraphQL.PostAsync` / shared-static re-points (`git diff` review).
