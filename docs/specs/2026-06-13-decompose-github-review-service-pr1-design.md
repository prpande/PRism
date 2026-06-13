# Decompose `GitHubReviewService` — PR1 (parsers + auth)

- **Issue:** #321 (epic #317, code-quality review). Tier T3, gated B2 overall.
- **This slice:** PR1 of 2 — **hands-off** (touches no risk surface). PR2 (the gated B2 Submit split) is a separate doc.
- **Date:** 2026-06-13
- **Worktree / branch:** `D:/src/PRism-321` / `feature/321-decompose-github-review-service`

## Problem

`PRism.GitHub/GitHubReviewService.cs` is a single `sealed partial class` implementing all four
ADR-S5-1 capability interfaces at once:

```csharp
public sealed partial class GitHubReviewService : IReviewAuth, IPrDiscovery, IPrReader, IReviewSubmitter
```

It spans ~1,835 lines across four partials (`.cs` 1,172, `.Submit.cs` 515, `.ReviewComments.cs` 82,
`.IssueComments.cs` 66) and mixes five altitudes in one type: PAT auth/scope policy, the read path
(PR detail / diff / timeline / file content / poll), pure JSON→DTO parsing, per-commit fan-out
concurrency, and the GraphQL submit pipeline. The interfaces already partition the surface; the DI
registration (`ServiceCollectionExtensions.cs:52-66`) binds each interface to one shared singleton,
so callers depend on the interfaces, not the concrete class — each capability can move to its own
class with **zero `PRism.Core` contract change**.

## Scope decision: why PR1 stops at parsers + auth

The full decomposition is split across two PRs (owner-chosen, 2026-06-13):

- **PR1 (this doc, hands-off):** extract the pure parsers + the auth path. Leaves `IPrReader` +
  `IPrDiscovery` + `IReviewSubmitter` on `GitHubReviewService`.
- **PR2 (separate, gated B2):** split `IReviewSubmitter` into `GitHubReviewSubmitter` + the shared
  GraphQL transport collaborator, and converge the logging style. This is the slice that touches
  `Submit.cs`, the enumerated B2 risk surface, so it carries the human gate.

**Why the reader cannot also leave the class in PR1.** The read path (`GetPrDetailAsync`,
`GetTimelineAsync`) and the submit pipeline (`Submit.cs`) both call the instance transport wrapper
`PostGraphQLAsync` — by design (the `apiVersion:false` byte-identity note at `GitHubReviewService.cs:746`
records that Submit rides this exact method). Moving the reader into its own class would require either
duplicating `PostGraphQLAsync` (re-introducing the duplication the epic fights) or extracting a shared
transport collaborator — and that collaborator change rewires how Submit obtains its transport, which
is the B2 surface. So reader + discovery + submit stay fused until PR2 does the transport extraction
and the Submit split together. After PR2, the residual `GitHubReviewService` *is* the Reader+Discovery
pairing — the "documented pairing" escape hatch in the issue's AC#1.

## What moves, what stays

### New file: `PRism.GitHub/GitHubPrParser.cs` — `internal static class GitHubPrParser`

Pure, side-effect-free JSON→DTO parsers relocated verbatim from `GitHubReviewService.cs`:

| Member | Current accessibility | New accessibility | Note |
|--------|----------------------|-------------------|------|
| `ParsePr` | `private static` | `internal static` | called cross-class by `GetPrDetailAsync` after the move |
| `ParseRootComments` | `private static` | `internal static` | called cross-class by `GetPrDetailAsync` |
| `ParseReviewThreads` | `internal static` | `internal static` | already `internal`; called directly by `ParseReviewThreadsDatabaseIdTests` |
| `ParseTimelineCommits` | `private static` | `internal static` | called cross-class by `GetTimelineAsync` |
| `ParseForcePushes` | `private static` | `internal static` | called cross-class by `GetTimelineAsync` |
| `ParseReviewEvents` | `private static` | `internal static` | called cross-class by `GetTimelineAsync` |
| `ParseAuthorComments` | `private static` | `internal static` | called cross-class by `GetTimelineAsync` |
| `ReadActor` | `private static` | `private static` | helper used only inside the parser class |
| `IsTypeName` | `private static` | `private static` | helper used only inside the parser class |

Accessibility note: the `private static` → `internal static` promotions above are **mandatory, not
discretionary** — after the move the read path on `GitHubReviewService` (`GetPrDetailAsync`,
`GetTimelineAsync`) calls these parsers across the class boundary, so they must be at least `internal`
for the code to compile. Direct-test reachability is a secondary benefit, not the reason — do **not**
"tighten" any of them back to `private` to reduce surface; that breaks the build. `ParseReviewThreads`
is already `internal`. Helpers used only within `GitHubPrParser` (`ReadActor`, `IsTypeName`) stay
`private`. No member becomes `public`. `InternalsVisibleTo` for both test projects is declared at the
csproj level, so `internal` carries to the existing tests with no new attribute.

**Stays on `GitHubReviewService` (private):** `TryGetPath`, `ThrowIfGraphQLErrorsWithoutData`, and the
cap-hit trio `HasAnyNextPage` / `ConnectionHasNext` / `PagedConnections`. `TryGetPath` is used by both
the read path *and* `Submit.cs` — moving it would edit the B2 file. `ThrowIfGraphQLErrorsWithoutData`
is instance (logs via `s_graphqlReadFailed`) and read-specific; its logging convergence is deferred to
PR2. The cap-hit trio is **not** a DTO mapper — it is a read-path completeness sentinel whose only
caller (`GetPrDetailAsync`, `GitHubReviewService.cs:304`) stays on this class; keeping it `private`
here avoids an unnecessary `internal` promotion + cross-class call and keeps `GitHubPrParser` a single
altitude (pure JSON→DTO mapping). `Truncate` and the `s_graphql*` logger fields also stay — see the
extraction note in *Risks*.

### New file: `PRism.GitHub/GitHubAuthValidator.cs` — `internal sealed class GitHubAuthValidator : IReviewAuth`

The PAT auth/scope path relocated verbatim, with a constructor taking exactly the dependencies it uses:

```csharp
internal sealed class GitHubAuthValidator(
    IHttpClientFactory httpFactory,
    Func<Task<string?>> readToken,
    string host) : IReviewAuth
```

Members moved: `ValidateCredentialsAsync` (the `IReviewAuth` method), `ClassifyToken`, `IsDnsFailure`,
`InterpretAsync`, `ProbeRepoVisibilityAsync`, `SearchHasResultsAsync`, the `TokenType` enum, and the
`RequiredScopes` table. The path has **no logger dependency** and shares no state with the read/submit
paths — it only reads the token, builds a `github` client, and calls `GitHubHttp.ApplyHeaders`
(already a static from #320). Bodies and comments move byte-for-byte.

Accessibility: `internal sealed` (not `public`). Construction is exclusively via DI and the test
projects (InternalsVisibleTo). Callers resolve `IReviewAuth`, never the concrete type.

### `GitHubReviewService` after PR1

The main `GitHubReviewService.cs` partial drops from **1,172** lines to ~760 (≈180 auth + ≈250 parsers
removed; the ~1,835 figure in *Problem* is the four-partial total, not this one file). After PR1 it
implements `IPrDiscovery, IPrReader, IReviewSubmitter` (no longer `IReviewAuth`). Retains: the read path + fetch helpers + per-commit
fan-out, `TryParsePrUrl`, the legacy throw-stubs, the transport wrappers `SendGitHubAsync` /
`PostGraphQLAsync`, `TryGetPath`, `ThrowIfGraphQLErrorsWithoutData`, the cap-hit trio
(`HasAnyNextPage` / `ConnectionHasNext` / `PagedConnections`), `Truncate`, the `Log` source-generated
class, the manual logger fields, the query consts (`PrDetailGraphQLQuery` / `TimelineQuery`), and
`Submit.cs` **byte-identical**.

The other two partials — `GitHubReviewService.ReviewComments.cs` and `.IssueComments.cs` — are
**untouched**: they reference only members that stay (`SendGitHubAsync`, `Truncate`, `TryGetPath`,
`PostSubmitGraphQLAsync`), no moved parser or auth member.

The read path's call sites change only by qualification: `ParsePr(...)` → `GitHubPrParser.ParsePr(...)`,
`ParseReviewThreads(...)` → `GitHubPrParser.ParseReviewThreads(...)`, etc. (in `GetPrDetailAsync`,
`GetTimelineAsync`). `HasAnyNextPage(pull)` at `GitHubReviewService.cs:304` is unchanged (it stays
local).

### DI: `ServiceCollectionExtensions.AddPrismGitHub`

```csharp
// before: IReviewAuth bound to the shared GitHubReviewService singleton
services.AddSingleton<IReviewAuth>(sp => sp.GetRequiredService<GitHubReviewService>());

// after: IReviewAuth bound to its own singleton
services.AddSingleton<IReviewAuth>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubAuthValidator(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        config.Current.Github.Host);
});
```

The eager `config.Current.Github.Host` string capture intentionally mirrors the existing
`GitHubReviewService` registration (`ServiceCollectionExtensions.cs:60`) — same behavior, not a
regression. (A live host change without restart is a pre-existing property of *both* registrations;
switching both to `Func<string>` is out of scope for this refactor.)

`IPrDiscovery` / `IPrReader` / `IReviewSubmitter` keep resolving the shared `GitHubReviewService`
singleton (registered exactly as today). The XML-doc summary on `AddPrismGitHub` is updated to note
`IReviewAuth` is now backed by `GitHubAuthValidator`, not the shared instance. No other consumer of
the registration changes — `IReviewAuth` is the only moved binding, and nothing injects the concrete
`GitHubReviewService` directly (verified: only the four `GetRequiredService<GitHubReviewService>()`
interface-binding lambdas reference the concrete type).

## Tests

All relocations are mechanical; no assertion or scenario changes.

| Test file | Change |
|-----------|--------|
| `ParseReviewThreadsDatabaseIdTests.cs:16` | `GitHubReviewService.ParseReviewThreads` → `GitHubPrParser.ParseReviewThreads` |
| `GitHubReviewService_ValidateCredentialsAsyncTests.cs` | `BuildSut` constructs `new GitHubAuthValidator(...)` instead of `new GitHubReviewService(...)`. This file already calls the **3-arg** form (the logger ctor param is optional and omitted), so the *only* edit is the constructed type — there is no logger arg to remove. |
| `GitHubReviewServiceValidateSkipTests.cs` | Type swap in its `Build` helper to `new GitHubAuthValidator(factory, () => Task.FromResult<string?>(token), "github.com")` — and **drop the trailing `null` logger arg** the current call passes (`GitHubReviewService`'s ctor has an optional `ILogger`; `GitHubAuthValidator`'s 3-arg ctor does not, so leaving the `null` is a compile error). The `skipCredentialHealth` → `SkipHealthKey` propagation lives **inside** `ValidateCredentialsAsync`, which moves to `GitHubAuthValidator` verbatim, and the `GitHubAuthHealthHandler` latch is wired on the named `github` client via `IHttpClientFactory` (not the SUT) — so the latch test exercises the same pipeline. |
| `PRism.GitHub.Tests.Integration/PatScopeContractTests.cs` | **No change.** It resolves `IReviewAuth` from `LiveGitHubFixture`'s DI container (not a direct `new`), so the `IReviewAuth` → `GitHubAuthValidator` rebind takes effect transparently. `LiveGitHubFixture.cs` likewise needs no edit (it already resolves the interface). |

**The `IReviewAuth` DI rebind is intentionally not unit-tested.** `ServiceRegistrationTests` only
covers *dependency-free* registrations (`IGitHubCredentialHealth`, `IClock`) — it builds a provider
from `AddPrismGitHub()` alone, which registers neither `IConfigStore` nor `ITokenStore` (one fact even
comments "no `ITokenStore` stub needed"). The new `IReviewAuth` lambda resolves both of those
composition-root deps eagerly, so a `GetRequiredService<IReviewAuth>()` fact would throw
`InvalidOperationException` unless we stub `IConfigStore` + `ITokenStore` — which would break the file's
deliberate dependency-free pattern and is not "mechanical." The rebind's correctness is instead
guaranteed by the compiler (the lambda must compile against `GitHubAuthValidator`'s ctor) and exercised
end-to-end by the live integration auth tests (`PatScopeContractTests` via `LiveGitHubFixture`). This
mirrors how the *existing* `GitHubReviewService` registration — which also resolves `IConfigStore` /
`ITokenStore` — is likewise not unit-covered here.

The two auth unit-test files keep their current names (no rename) — PR1 is a mechanical relocation, and
a class/namespace rename is discretionary churn that inflates the diff without a correctness need.

Tests that exercise parsers/auth *indirectly* through public methods (`GitHubReviewServicePrDetailTests`,
`GitHubReviewServiceTimelineTests`, `GitHubReviewServiceAuthHeaderTests`, the byte-identity tests) are
**untouched** — they construct `GitHubReviewService` and call public methods, which still delegate to
the relocated statics. `GraphQlByteIdentityTests` keeps asserting against
`GitHubReviewService.PrDetailGraphQLQuery` / `.TimelineQuery` (those consts do not move).

## Acceptance criteria mapping

From issue #321:

- [x] **Parsers live in their own static class(es) with tests moved alongside** — PR1: `GitHubPrParser`; the one direct parser test re-points.
- [~] **No class implements more than one capability interface (or a documented pairing)** — PR1
  removes `IReviewAuth` from the multi-interface class; PR2 finishes by splitting `IReviewSubmitter`,
  leaving the documented Reader+Discovery pairing.
- [x] **DI registration updated; no change to any `PRism.Core` contract** — PR1: `IReviewAuth` rebinds; contracts untouched.
- [x] **Existing GitHub.Tests suite green without behavioral edits (mechanical relocation only)** — PR1.
- [~] **One logging declaration style in the project** — deferred to PR2 (the manual `LoggerMessage.Define`
  fields with hand-assigned EventIds 2–5 span the read side and `Submit.cs`; converging them in one
  PR avoids an intermediate EventId collision).

`[~]` = partially addressed by PR1, completed by PR2. #321 closes on PR2 merge.

## Risks & non-goals

- **Risk: a parser body changes during the move.** Mitigation: relocate by **member identity**, no
  edits to method bodies; the existing indirect tests (`PrDetailTests`, `TimelineTests`) and the direct
  `ParseReviewThreadsDatabaseIdTests` pin behavior. Verify the full `PRism.GitHub.Tests` +
  `.Integration` suites stay green with zero assertion edits.
- **Risk: a naive line-range cut drags a staying member out (or strands a parser helper).** The parser
  members are **non-contiguous** in the source — interleaved with members that must STAY:
  `Truncate` (`:768`), `s_graphqlTransportFailed` (`:776`), `s_graphqlReadFailed` (`:910`), and
  `TryGetPath` (`:916`) all sit between `ParseTimelineCommits` (`:780`) and `HasAnyNextPage` (`:1071`).
  Mitigation: extract method-by-method by identity, never by line range; a range cut would either pull
  `Truncate`/`TryGetPath` into `GitHubPrParser` (breaking `Submit.cs`, which calls both) or leave a
  parser helper behind.
- **Risk: auth ctor drops a dependency the path needs.** Mitigation: the auth path provably uses only
  `(httpFactory, readToken, host)` — no `_log`, no shared fields; the auth tests already construct the
  service with these and call `ValidateCredentialsAsync`.
- **Non-goal:** touching `Submit.cs`, extracting a transport collaborator, converging logging,
  decomposing the read path further, or any behavioral change. All PR2 or out of scope.

## Verification

Pre-push gates (run via real binaries per repo conventions):
`dotnet build` (0 warnings, `TreatWarningsAsErrors`), `dotnet test` on `PRism.GitHub.Tests` +
`PRism.GitHub.Tests.Integration` (all green, no assertion edits), full solution build to confirm no
downstream reference breaks from the DI/accessibility changes.
