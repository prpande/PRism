# Decompose GitHubReviewService — PR1 (parsers + auth) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the pure JSON→DTO parsers into `GitHubPrParser` and the PAT auth path into `GitHubAuthValidator : IReviewAuth`, removing one capability interface from the 4-interface `GitHubReviewService` god-class — a mechanical, behavior-preserving relocation.

**Architecture:** Pure cut-and-relocate by member identity. No method bodies change. The existing `PRism.GitHub.Tests` + `PRism.GitHub.Tests.Integration` suites are the regression net — they must stay green with **zero** assertion edits except the three mechanical re-points listed below. `Submit.cs` and the two comment partials stay byte-identical. The cap-hit trio (`HasAnyNextPage`/`ConnectionHasNext`/`PagedConnections`), `TryGetPath`, `ThrowIfGraphQLErrorsWithoutData`, `Truncate`, and all logging stay on `GitHubReviewService` (logging convergence + the `IReviewSubmitter` split are PR2).

**Tech Stack:** C# / .NET 10, xUnit, `TreatWarningsAsErrors=true`, `<Nullable>enable</Nullable>`. Source: `D:/src/PRism-321/PRism.GitHub/`. Authoritative design: `docs/specs/2026-06-13-decompose-github-review-service-pr1-design.md` (the "What moves / what stays", DI before/after, and Tests tables there govern this plan).

**Why no TDD here:** This is a relocation, not new behavior. The "failing test first" loop does not apply — the safety property is *the existing suite keeps passing unchanged*. Each task's gate is `dotnet build` (0 warnings) + the GitHub test suites green.

---

## File structure (decomposition locked here)

- **Create** `PRism.GitHub/GitHubPrParser.cs` — `internal static class GitHubPrParser`: the 7 pure DTO parsers + 2 private helpers (`ReadActor`, `IsTypeName`). One responsibility: map GraphQL `pullRequest` JSON → PRism DTOs.
- **Create** `PRism.GitHub/GitHubAuthValidator.cs` — `internal sealed class GitHubAuthValidator : IReviewAuth`: the PAT auth/scope path. One responsibility: validate a PAT and report login/scopes/warnings.
- **Modify** `PRism.GitHub/GitHubReviewService.cs` — remove the moved members; remove `IReviewAuth` from the class declaration; qualify the 7 read-path parser call sites.
- **Modify** `PRism.GitHub/ServiceCollectionExtensions.cs` — rebind `IReviewAuth` to `GitHubAuthValidator`; update the `AddPrismGitHub` XML-doc summary.
- **Modify** `tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs` — re-point one call.
- **Modify** `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs` — swap constructed type (no logger arg present).
- **Modify** `tests/PRism.GitHub.Tests/GitHubReviewServiceValidateSkipTests.cs` — swap constructed type + drop the trailing `null` logger arg.
- **Untouched** (verify, don't edit): `GitHubReviewService.Submit.cs`, `.ReviewComments.cs`, `.IssueComments.cs`, `PatScopeContractTests.cs`, `LiveGitHubFixture.cs`, `ServiceRegistrationTests.cs`, the byte-identity tests.

---

## Task 1: Extract `GitHubPrParser` (pure DTO parsers)

**Files:**
- Create: `PRism.GitHub/GitHubPrParser.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove the 9 members; qualify 7 call sites)
- Modify: `tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs:16`

- [ ] **Step 1: Create the new parser class with the moved members**

Create `PRism.GitHub/GitHubPrParser.cs`. Move these members **verbatim** (bodies unchanged) out of `GitHubReviewService.cs` and into the new class. Promote each `private static` to `internal static`; `ParseReviewThreads` is already `internal`; keep `ReadActor` and `IsTypeName` `private static`:

- `ParsePr` (`GitHubReviewService.cs:945`) → `internal static`
- `ParseRootComments` (`:1000`) → `internal static`
- `ParseReviewThreads` (`:1019`) → stays `internal static`
- `ParseTimelineCommits` (`:780`) → `internal static`
- `ParseForcePushes` (`:804`) → `internal static`
- `ParseReviewEvents` (`:827`) → `internal static`
- `ParseAuthorComments` (`:853`) → `internal static`
- `ReadActor` (`:935`) → stays `private static`
- `IsTypeName` (`:873`) → stays `private static`

Do **NOT** move: `TryGetPath` (`:916`), `HasAnyNextPage` (`:1071`), `ConnectionHasNext` (`:1078`), `PagedConnections` (`:1069`), `ThrowIfGraphQLErrorsWithoutData` (`:889`), `Truncate` (`:768`), or any logger field — they stay on `GitHubReviewService`.

File skeleton (fill the bodies by moving them verbatim):

```csharp
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Iterations;

namespace PRism.GitHub;

// Pure JSON→DTO parsers for the GraphQL `pullRequest` payload. Relocated from
// GitHubReviewService.cs (#321 PR1). No behavioral change — bodies are verbatim.
// `internal` (test-visible via the csproj InternalsVisibleTo); not `public`.
internal static class GitHubPrParser
{
    internal static List<ClusteringCommit> ParseTimelineCommits(JsonElement pull) { /* verbatim */ }
    internal static List<ClusteringForcePush> ParseForcePushes(JsonElement pull) { /* verbatim */ }
    internal static List<ClusteringReviewEvent> ParseReviewEvents(JsonElement pull) { /* verbatim */ }
    internal static List<ClusteringAuthorComment> ParseAuthorComments(JsonElement pull) { /* verbatim */ }
    internal static Pr ParsePr(JsonElement pull, PrReference reference) { /* verbatim */ }
    internal static List<IssueCommentDto> ParseRootComments(JsonElement pull) { /* verbatim */ }
    internal static List<ReviewThreadDto> ParseReviewThreads(JsonElement pull) { /* verbatim */ }

    private static bool IsTypeName(JsonElement node, string expected) { /* verbatim */ }
    private static (string Login, string? AvatarUrl) ReadActor(JsonElement node) { /* verbatim */ }
}
```

- [ ] **Step 2: Qualify the read-path call sites in `GitHubReviewService.cs`**

In `GetPrDetailAsync` (around `:301-303`):
```csharp
        var pr = GitHubPrParser.ParsePr(pull, reference);
        var rootComments = GitHubPrParser.ParseRootComments(pull);
        var reviewComments = GitHubPrParser.ParseReviewThreads(pull);
        var timelineCapHit = HasAnyNextPage(pull);   // unchanged — stays on this class
```

In `GetTimelineAsync` (around `:383-386`):
```csharp
        var rawCommits = GitHubPrParser.ParseTimelineCommits(pull);
        var forcePushes = GitHubPrParser.ParseForcePushes(pull);
        var reviewEvents = GitHubPrParser.ParseReviewEvents(pull);
        var authorComments = GitHubPrParser.ParseAuthorComments(pull);
```

Leave `TryGetPath(...)`, `HasAnyNextPage(...)`, and `ThrowIfGraphQLErrorsWithoutData(...)` call sites unqualified — those members did not move.

- [ ] **Step 3: Re-point the one direct parser test**

`tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs:16`:
```csharp
        var threads = GitHubPrParser.ParseReviewThreads(doc.RootElement);
```
(was `GitHubReviewService.ParseReviewThreads`). No other line in this file changes.

- [ ] **Step 4: Build**

Run: `dotnet build PRism.GitHub/PRism.GitHub.csproj -c Debug`
Expected: Build succeeded, 0 warnings, 0 errors. (A `CS0103 'ParsePr' does not exist` means a call site was missed; a `CS0122 inaccessible` means a member wasn't promoted to `internal`.)

- [ ] **Step 5: Run the GitHub unit tests**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`
Expected: all pass, 0 failed. `ParseReviewThreadsDatabaseIdTests`, `GitHubReviewServicePrDetailTests`, and `GitHubReviewServiceTimelineTests` exercise the moved parsers indirectly + directly — green confirms the relocation is behavior-preserving.

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/GitHubPrParser.cs PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/ParseReviewThreadsDatabaseIdTests.cs
git commit -m "refactor(github): extract GitHubPrParser from GitHubReviewService (#321)"
```

---

## Task 2: Extract `GitHubAuthValidator` and rebind `IReviewAuth`

**Files:**
- Create: `PRism.GitHub/GitHubAuthValidator.cs`
- Modify: `PRism.GitHub/GitHubReviewService.cs` (remove auth members; drop `IReviewAuth` from the class declaration)
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (rebind + XML-doc)
- Modify: `tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs`
- Modify: `tests/PRism.GitHub.Tests/GitHubReviewServiceValidateSkipTests.cs`

- [ ] **Step 1: Create `GitHubAuthValidator` with the moved auth members**

Create `PRism.GitHub/GitHubAuthValidator.cs`. Move these **verbatim** out of `GitHubReviewService.cs`: `ValidateCredentialsAsync` (`:85`), the `TokenType` enum (`:142`), `ClassifyToken` (`:149`), `IsDnsFailure` (`:152`), `InterpretAsync` (`:163`), `ProbeRepoVisibilityAsync` (`:220`), `SearchHasResultsAsync` (`:229`), and the `RequiredScopes` table (`:24`). The path uses only `_httpFactory`, `_readToken`, `_host` — no `_log`.

```csharp
using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using PRism.Core;
using PRism.Core.Contracts;   // AuthValidationResult / AuthValidationError / AuthValidationWarning live here (IReviewAuth is in PRism.Core)

namespace PRism.GitHub;

// PAT auth/scope validation, relocated from GitHubReviewService (#321 PR1). Implements
// IReviewAuth on its own instance; shares no state with the read/submit paths. Bodies verbatim.
internal sealed class GitHubAuthValidator : IReviewAuth
{
    private static readonly (string Capability, string[] AcceptedBy)[] RequiredScopes =
    [
        ("repo", ["repo"]),
        ("read:org", ["read:org", "write:org", "admin:org"]),
    ];   // verbatim, including the explanatory comment block above it in the source

    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;

    public GitHubAuthValidator(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string host)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
    }

    public async Task<AuthValidationResult> ValidateCredentialsAsync(CancellationToken ct, bool skipCredentialHealth = false) { /* verbatim */ }

    private enum TokenType { Classic, FineGrained }
    private static TokenType ClassifyToken(string token) { /* verbatim */ }
    private static bool IsDnsFailure(HttpRequestException ex) { /* verbatim */ }
    private static async Task<AuthValidationResult> InterpretAsync(HttpResponseMessage resp, TokenType tokenType, CancellationToken ct) { /* verbatim */ }
    private async Task<AuthValidationWarning> ProbeRepoVisibilityAsync(string token, bool skipCredentialHealth, CancellationToken ct) { /* verbatim */ }
    private async Task<bool> SearchHasResultsAsync(string token, string query, bool skipCredentialHealth, CancellationToken ct) { /* verbatim */ }
}
```

Keep the verbatim explanatory comments that precede `RequiredScopes` and `ClassifyToken` in the source — they document the scope/token-classification policy and must travel with the code.

- [ ] **Step 2: Remove `IReviewAuth` from `GitHubReviewService`**

In `GitHubReviewService.cs:12` change the declaration to drop `IReviewAuth`:
```csharp
public sealed partial class GitHubReviewService : IPrDiscovery, IPrReader, IReviewSubmitter
```
Confirm all eight auth members listed in Step 1 are now gone from this file. `GitHubHttp.ApplyHeaders` / `GitHubAuthHealthHandler.SkipHealthKey` are statics referenced from the moved code — they need no change.

- [ ] **Step 3: Rebind `IReviewAuth` in DI**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, replace the line:
```csharp
services.AddSingleton<IReviewAuth>(sp => sp.GetRequiredService<GitHubReviewService>());
```
with:
```csharp
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
Leave the `IPrDiscovery` / `IPrReader` / `IReviewSubmitter` bindings and the `AddSingleton<GitHubReviewService>(...)` registration exactly as they are.

- [ ] **Step 4: Update the `AddPrismGitHub` XML-doc summary**

In the `<summary>` on `AddPrismGitHub` (`ServiceCollectionExtensions.cs:17-25`), change the phrase that says `GitHubReviewService` is bound to the **four** capability interfaces to state that `IReviewAuth` is now backed by `GitHubAuthValidator`, and `GitHubReviewService` backs the remaining three (`IPrDiscovery`, `IPrReader`, `IReviewSubmitter`). Keep the rest of the summary intact.

- [ ] **Step 5: Swap the SUT type in the two auth unit tests**

**Both helpers declare a `GitHubReviewService` return type — that must change too**, or the swapped-in `GitHubAuthValidator` won't convert (CS0029). The callers only invoke `ValidateCredentialsAsync`, so the helper may return `GitHubAuthValidator` (used below) or `IReviewAuth`.

`GitHubReviewService_ValidateCredentialsAsyncTests.cs` — helper is `private static GitHubReviewService BuildSut(...)` with `return new GitHubReviewService(factory, () => Task.FromResult<string?>(token), host);` (3-arg, no logger). Change the return type **and** the constructed type:
```csharp
    private static GitHubAuthValidator BuildSut(HttpMessageHandler handler, string token = "ghp_test", string host = "https://github.com")
    {
        // ... body unchanged ...
        return new GitHubAuthValidator(factory, () => Task.FromResult<string?>(token), host);
    }
```
There is no logger arg to remove here.

`GitHubReviewServiceValidateSkipTests.cs` — helper is `private static (GitHubReviewService, IGitHubCredentialHealth) Build(HttpStatusCode status, string token)` with `var svc = new GitHubReviewService(factory, () => Task.FromResult<string?>(token), "github.com", null);` (4-arg, trailing `null` logger). Change the tuple's first type, the constructed type, **and drop the `null`**:
```csharp
    private static (GitHubAuthValidator, IGitHubCredentialHealth) Build(HttpStatusCode status, string token)
    {
        // ... body unchanged ...
        var svc = new GitHubAuthValidator(factory, () => Task.FromResult<string?>(token), "github.com");
        // ... return (svc, health) unchanged ...
    }
```
`GitHubAuthValidator`'s 3-arg ctor has no logger param, so the trailing `null` must go or it won't compile. No assertion bodies change in either file.

- [ ] **Step 6: Build the project**

Run: `dotnet build PRism.GitHub/PRism.GitHub.csproj -c Debug`
Expected: 0 warnings, 0 errors. (A `CS0535 'GitHubReviewService' does not implement IReviewAuth` means a member is still referenced as if on the class; a `CS1729 no constructor takes 4 arguments` in a test means the `null` logger arg wasn't dropped.)

- [ ] **Step 7: Run the GitHub unit tests**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj`
Expected: all pass. `GitHubReviewService_ValidateCredentialsAsyncTests` and `GitHubReviewServiceValidateSkipTests` now construct `GitHubAuthValidator` and must stay green with no assertion edits.

- [ ] **Step 8: Commit**

```bash
git add PRism.GitHub/GitHubAuthValidator.cs PRism.GitHub/GitHubReviewService.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/GitHubReviewService_ValidateCredentialsAsyncTests.cs tests/PRism.GitHub.Tests/GitHubReviewServiceValidateSkipTests.cs
git commit -m "refactor(github): split IReviewAuth into GitHubAuthValidator; rebind DI (#321)"
```

---

## Task 3: Full verification gate (solution build + both GitHub suites + byte-identity confirm)

**Files:** none (verification only).

- [ ] **Step 1: Confirm the untouched files are byte-identical**

Run: `git diff --stat origin/main -- PRism.GitHub/GitHubReviewService.Submit.cs PRism.GitHub/GitHubReviewService.ReviewComments.cs PRism.GitHub/GitHubReviewService.IssueComments.cs`
Expected: **no output** (zero changes to all three — the B2 surface and the comment partials were not touched).

- [ ] **Step 2: Full-solution build (catches any downstream reference break)**

Run: `dotnet build -c Debug` (solution root)
Expected: Build succeeded, 0 warnings (`TreatWarningsAsErrors` would fail otherwise), 0 errors. This proves no consumer in `PRism.Web` / `PRism.Desktop` / `PRism.Core` referenced the concrete `GitHubReviewService` auth members or the moved parsers.

- [ ] **Step 3: Run both GitHub test suites**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj` then `dotnet test tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj`
Expected: all pass / live-gated tests skip as usual. Zero assertion edits were made beyond the three mechanical re-points — green here is the behavior-preservation proof.

- [ ] **Step 4: Confirm `IReviewAuth` is the only changed binding**

Run: `git diff origin/main -- PRism.GitHub/ServiceCollectionExtensions.cs`
Expected: the diff shows only the `IReviewAuth` lambda change + the XML-doc summary update; the other three interface bindings and the `GitHubReviewService` singleton registration are unchanged.

- [ ] **Step 5: Run the repo pre-push checklist**

Run the project's pre-push checklist (`.ai/docs/development-process.md`) for the backend tier verbatim (build + test). This mirrors CI; do not self-curate a subset.

---

## Self-review (run before handoff)

- **Spec coverage:** Task 1 ⇒ design "New file: GitHubPrParser" + the parser rows of the Tests table. Task 2 ⇒ design "New file: GitHubAuthValidator" + "DI" + the two auth-test rows + the XML-doc note. Task 3 ⇒ design "Verification" + the "Submit.cs byte-identical" / "comment partials untouched" claims + the "nothing injects the concrete type" claim. The deferred items (Submit split, transport collaborator, logging convergence, the `[~]` ACs) are explicitly PR2 — no task here, by design.
- **No placeholders:** every code step shows the exact edit; `/* verbatim */` markers denote "move the existing body unchanged," which is the intended action for a relocation, not a TODO.
- **Type consistency:** `GitHubPrParser` / `GitHubAuthValidator` names, the `(IHttpClientFactory, Func<Task<string?>>, string)` ctor, and the `IReviewAuth` rebind are identical across the file-structure section, the tasks, and the DI block.
- **Gate consistency:** every task ends with build (0 warnings) + the relevant test suite green + a commit; Task 3 adds the full-solution build and the byte-identity guard.

---

## Execution handoff

After the plan is approved, execute via **subagent-driven-development** (recommended) or **executing-plans**. Then run `/simplify` and raise PR1 through `pr-autopilot`. PR body must use `Part of #321` / `Refs #321` (NOT `Closes` — PR2 closes the issue) and record the ce-doc-review dispositions (2 rounds) in the `## Proof` section.
