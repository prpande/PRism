---
title: "Frozen-PR contract tests — live-GitHub integration suite against prpande/PRism"
date: 2026-05-18
status: design
revisions:
  - 2026-05-18: brainstorm pass — design committed for human review (supersedes the deferred S3 Task 11 targeting `mindbody/Api.Codex`)
related:
  - 2026-05-06-s3-pr-detail-read-design.md       # original spec § 11.4 — superseded by this redirect
  - 2026-05-06-s3-pr-detail-read.md              # original plan Task 11 — superseded by this redirect
  - 2026-05-18-real-flow-e2e-playwright-design.md # sibling live-GitHub suite (disjoint surface; see § 10)
---

# Frozen-PR contract tests — live-GitHub integration suite against prpande/PRism

## 1. Origin and goal

S3 Task 11 was deferred (memory `project_s3_task11_open`) because the original framing required manually authoring a deliberately-shaped PR on `mindbody/Api.Codex` (the original plan's § 11.1 calls for "three iterations of varying shape" pushed by hand). The manual-authoring requirement weakened the "real-world shape" property the suite was buying — a hand-shaped PR is not a real PR.

This spec redirects the suite to **PRism's own merged-PR history** on `prpande/PRism`. The five PRs picked (§ 4) span four of the five canonical iteration shapes the algorithm cares about; together they exercise the algorithm against shapes that emerged from real review cycles, real cross-day work, real rebase clusters — not from a test author's mental model of what the algorithm should see.

The fifth canonical shape (force-push-after-review) is unavailable in the corpus because Pratyush's workflow is fix-on-top, never amend — a sweep of all 56 merged PRs found zero `HeadRefForcePushedEvent` timeline entries. § 10 captures this as a documented coverage gap, with the unit-test compensation pointer.

**This is a trade, not a strict upgrade:** the redirect gains shape authenticity and resistance to picking-time bias, and loses force-push integration coverage. Unit tests at `ForcePushMultiplierTests` (§ 10) compensate for the lost axis. The trade is net-better because (a) picking-time bias was the original framing's biggest weakness, and (b) the lost axis is exercised at a different stack layer with comparable confidence. Future readers re-evaluating this choice should see the trade in the open — if force-push integration coverage starts mattering more (e.g., the GraphQL parsing layer for `HeadRefForcePushedEvent` becomes load-bearing), revisit § 10's coverage-gap bullet.

## 2. In scope / out of scope

**In:**

- New `tests/PRism.GitHub.Tests.Integration/` xUnit project gated by `[Trait("Category", "Integration")]` and excluded from default `dotnet test` via a new repo-root `.runsettings` (xUnit trait filter `Category!=Integration`).
- Seven xUnit tests: 3 parameterized over the 5-PR corpus (7a, 7b, 7f), 3 single-PR-anchored (7c on #19, 7g on #19, 7h on #16), and 1 PAT-shape contract test (7e) that exercises `IReviewAuth.ValidateCredentialsAsync` only (see § 4 / § 5).
- A capture mode for the GraphQL shape-drift fixture, env-gated.
- A `.github/workflows/integration-tests.yml` job running on `workflow_dispatch` only — no recurring schedule (see § 8 for the rationale: a recurring schedule is observationally equivalent to manual dispatch for a sole-owner project and trains noise-filtering). Authenticated via a `PRISM_INTEGRATION_PAT` secret.
- An operator runbook at `docs/contract-tests.md` covering: prereqs, running, the PR corpus + shape rationale, adding a new test PR, refreshing the fixture, triaging shape-drift failures, unlocking a test PR.
- A short README addition pointing developers at the local-run command.
- Locking conversation on the five corpus PRs (`gh api -X PUT /repos/prpande/PRism/issues/{N}/lock`) — performed by the implementing agent during the implementation PR, not the user.

**Out:**

- Force-push-shape integration coverage (§ 10 — accepted gap; unit tests at `ForcePushMultiplierTests.Force_push_after_long_gap_returns_one_point_five` cover the amplification path).
- CI gating on PR push. The suite is opt-in (`workflow_dispatch` only — no recurring schedule, see § 8).
- Multi-target-repo support. The single-target-repo property is load-bearing — the suite's value comes from PRs that weren't authored for it.
- Adding an out-of-repo force-push PR. Considered and rejected (§ 10) — breaks the single-target-repo property for a single-shape gain that's already covered at unit level.
- Mutation testing of the suite. The seven tests are direct contract assertions; mutation-resistance can be revisited at P0+.
- Coordination edit to `2026-05-18-real-flow-e2e-playwright-design.md` § 10 Risks paragraph. The disjoint-vs-overlapping relationship between the two suites is documented in this spec (§ 10 below) for new readers; real-flow's own spec is not edited.

## 3. Approach in one paragraph

A new xUnit test project at `tests/PRism.GitHub.Tests.Integration/` instantiates `GitHubReviewService` against live GitHub with a real `HttpClient`. PATs come from `gh auth token --hostname github.com` (executed via `System.Diagnostics.Process.Start`) locally and from the `PRISM_INTEGRATION_PAT` env var in CI; a single `GhCliPat` helper picks the right source. Tests pin to commit SHAs (not branch HEADs) read from a `FrozenPrCorpus` static record in code; the implementation captures those SHAs once via `gh pr view <N> --json commits` and writes them into the corpus record. A separate `Frozen_pr_graphql_shape_unchanged` test compares the full GraphQL response for the anchor PR (#19) against a checked-in fixture JSON; the structural diff is hand-rolled (~50 LOC over `JsonElement`, no NuGet dep) and the diff is what appears in xUnit's failure message. Capture mode (`PRISM_FROZEN_PR_CAPTURE_FIXTURE=1`) rewrites the fixture instead of asserting, for intentional-schema-update workflows. Default `dotnet test` excludes the `Integration` trait via a new `.runsettings` at repo root; CI runs the suite only on `workflow_dispatch` (no recurring schedule — § 8) with a fine-grained `PRISM_INTEGRATION_PAT` secret (`metadata:read + pull_requests:read` scoped to `prpande/PRism`).

## 4. Test-PR corpus

Five pre-S4 merged PRs (numbers ≤ 28, all merged before 2026-05-09 when the engineer was building the iteration-clustering core and was not yet hand-shaping work to demonstrate the algorithm). Picks were made on objective shape criteria (commit count, time gaps, `authoredDate`-vs-`committedDate` divergence) before running the algorithm — this discipline mitigates self-referential bias and is documented in the runbook's "adding a new test PR" section so future expansions follow the same rule.

| PR | Title | Shape category | Why it tests |
|---|---|---|---|
| **#1** | `Add Claude Code GitHub Workflow` | Single-iteration baseline | 2 commits 2 seconds apart (`bd8ba9d` → `b21b38b`), 94 LOC, no review feedback. Tests `clusteringQuality === "low"` path — the algorithm must NOT fabricate iteration boundaries on minimum-viable PRs. |
| **#16** | `stop two flaky tests` | Rebased-history `committedDate` collision | 9 commits with `authoredDate` spanning 02:20→02:55Z but `committedDate` all stamped at 02:55:10Z (final rebase rewrote them), then 3 distinct-time commits at 03:08/03:17/03:25Z, plus merge commit (10 total). Tests algorithm graceful-degradation when the primary time signal is collapsed — does it fabricate noise or degrade gracefully? |
| **#19** | `PR detail read-side` | Multi-burst with review-fix tail | 12 commits over ~1h36m: Burst 1 (5 commits 13:32→14:11Z), Burst 2 (4 commits 14:15→14:36Z), Tail (2 commits 15:00, 15:08Z review-feedback). Tests default boundary detection at natural work gaps — count should resolve to 2-3, not 12. Bonus: 2 documented review rounds anchor the comment-anchor subset assertion test. |
| **#22** | `SSE + per-PR fanout + auth middleware` | Overnight time-gap boundary | 10 commits: 9-commit evening session (18:37→21:16Z), then 1 review-feedback commit at 02:17Z next day. Tests time-gap boundary signal — the late cross-day commit must form its own iteration despite being a small diff. |
| **#28** | `Diff Pane + Markdown Pipeline` | Tight intra-cluster + late package-lock fix | 8 commits: 7 commits packed into 14:16→14:35Z (~19 min — includes prettier formatting + useEffect hook fix), then 4-hour gap to 18:24Z package-lock regen. Tests the short-gap commit-suppression early-return path of `ForcePushMultiplier` (returns 1.0 when `committedDate` delta ≤ `ForcePushLongGapSeconds = 600s`), NOT force-push handling — the heuristic gates on commit time-deltas, not on `HeadRefForcePushedEvent` presence. See `PRism.Core/Iterations/ForcePushMultiplier.cs:16-17`. |

### 4.1 Note on the `ForcePushMultiplier` naming

The class is named `ForcePushMultiplier` but does two things in sequence — read the source:

```csharp
// PRism.Core/Iterations/ForcePushMultiplier.cs
var gapSeconds = Math.Max(0, (next.CommittedDate - prev.CommittedDate).TotalSeconds);
if (gapSeconds <= coefficients.ForcePushLongGapSeconds) return 1.0;   // short-gap suppression

// ... otherwise look for a force-push event in the [prev, next] window
return hasForcePushInWindow ? coefficients.ForcePushAfterLongGap : 1.0;
```

The early-return short-gap suppression gates purely on `committedDate` deltas — it is **independent** of whether any force-push event exists. PR #28 exercises this path with zero force-pushes in the corpus. The second path (force-push amplification, 1.5× when gap > 600s AND a `HeadRefForcePushedEvent` sits in the window) is not exercised by any PRism PR and remains a known coverage gap (§ 10). The class naming pre-dates this distinction and is retained for compatibility; a future rename to `CommitGapAndForcePushMultiplier` is a separate concern.

### 4.2 Hand-labeled expected iteration counts

| PR | Expected count | Assertion form | Notes |
|---|---|---|---|
| #1 | (none — `Low` quality short-circuit) | Test 7a asserts `iterations === null` | `CommitMultiSelectPicker` fallback path; verified by test 7f (`quality === "low"`). |
| #16 | 1-2 | `Should().BeInRange(1, 2)` | 9 rebase commits cluster as 1; the 3 distinct-time commits at 03:08/03:17/03:25 may form a 2nd iteration. Merge commit excluded. |
| #19 | 2-3 | `Should().BeInRange(2, 3)` | Burst 1 + Burst 2 may join across the 4-min seam (14:11→14:15Z); tail (15:00/15:08Z) is its own iteration. |
| #22 | 2 | `Should().Be(2)` | Canonical overnight-gap signal — single boundary expected. |
| #28 | 2 | `Should().Be(2)` | Short-gap cluster + 4-hour-gap late commit — two iterations expected. |

Range assertions on #16 and #19 leave headroom for coefficient tuning without test churn while still catching "blew up to 8 iterations" regressions. Equality assertions on #22 and #28 lock in the canonical single-boundary signal.

## 5. Test inventory

Seven xUnit tests split across two files: `FrozenPrismPrTests.cs` (the six corpus-anchored tests — `[Theory]` over `FrozenPrCorpus.All()` for parameterized ones, `[Fact]` for single-PR-anchored ones) and `PatScopeContractTests.cs` (test 7e — the lone PR-independent contract test, carved out so the corpus suite's narrative stays focused on "tests against real PRs"). Both files carry `[Trait("Category", "Integration")]` so the runsettings filter sweeps them together.

| # | Test | Anchored on | Asserts |
|---|---|---|---|
| 7a | `Frozen_pr_returns_expected_iteration_count` | All 5 (parameterized) | Iteration count matches `FrozenPrCorpus[i].ExpectedIterationRange` (encoded as `(Min, Max)` tuple — when `Min == Max`, assertion is `Should().Be(Min)`; otherwise `Should().BeInRange(Min, Max)`. When the tuple is `null` — PR #1 — the assertion is `iterations.Should().BeNull()`). |
| 7b | `Frozen_pr_returns_expected_files_in_diff` | All 5 (parameterized) | Files list at the pinned SHA equals `FrozenPrCorpus[i].ExpectedFiles` (set-equality). Locked-conversation + closed-merged status + pinned SHA make the file list deterministic; a GraphQL field-shape addition is caught by 7g, not by relaxing this assertion. Set equality catches both over-collection (parser regression in `GitHubReviewService`) and under-collection (missing files). |
| 7c | `Frozen_pr_existing_comments_have_expected_anchors` | PR #19 | `FrozenPrCorpus[19].ExpectedCommentAnchors` is a SUBSET of returned comment-anchor tuples. Subset assertion defends against accidental new comments between lock-time and runtime. Failure message includes the hint *"If `Frozen_pr_graphql_shape_unchanged` is also failing, fix the fixture first; this assertion runs against parsed shape."* |
| ~~7d~~ | ~~`Frozen_pr_force_push_event_appears_in_timeline`~~ | DROPPED — see § 10 | n/a |
| 7e | `ValidateCredentialsAsync_returns_ok_with_login_for_test_pat` | n/a — exercises `IReviewAuth.ValidateCredentialsAsync` only. Lives in `PatScopeContractTests.cs`, not the corpus test file (see § 5 intro). Single `[Fact]`, not parameterized. | **Fitness-smoke contract** (not scope-shape — see note below): asserts (a) `AuthValidationResult.Ok == true`, (b) `Login` is non-empty, and (c) one live read against `prpande/PRism` succeeds (fetch PR #1's `node_id` via `gh api /repos/prpande/PRism/pulls/1` — confirms the credential actually authorizes against the target repo, not just that the credential format is valid). Failure here means "the credential cannot exercise the suite" — surfaces cleanly before 7a/7b/etc. produce cryptic 401/403 errors. <br><br>**Why not scope-equality:** The round-1 spec asserted SET EQUALITY against `{metadata:read, pull_requests:read}` but `GitHubReviewService.InterpretAsync` reads scopes only from the `X-OAuth-Scopes` HTTP header, which fine-grained PATs do not return (`Scopes` is empty array). Classic PATs return scopes in a different namespace (`repo`, `read:user`, `read:org` — see `RequiredScopes` constant in `GitHubReviewService.cs:14`). No assertion shape involving `Scopes` works for both PAT types. Reframed as fitness-smoke at round 2 (FEAS-R2-1, FEAS-R2-2). |
| 7f | `Frozen_pr_returns_clustering_quality_ok` | All 5 (parameterized) | `quality === "low"` on PR #1, `quality === "ok"` on PRs #16/#19/#22/#28. |
| 7g | `Frozen_pr_graphql_shape_unchanged` | PR #19 | Full GraphQL response structurally equal to `Fixtures/pr19-graphql-response.json`. Failure message contains the hand-rolled structural diff: `+ path`, `- path`, `~ path (typeA → typeB)`. |
| 7h | `Frozen_pr_handles_rebased_committedDate_collision` | PR #16 | Iteration count in `[1, 2]` despite 9 commits sharing identical `committedDate`. Separate from 7f because PR #16 is healthy multi-commit (`quality === "ok"`) — not degenerate-input — so the assertion is behavioral, not quality-class. |

## 6. Architecture / components

```
tests/PRism.GitHub.Tests.Integration/
├── PRism.GitHub.Tests.Integration.csproj
├── FrozenPrismPrTests.cs            # corpus-anchored tests (7a, 7b, 7c, 7f, 7g, 7h)
├── PatScopeContractTests.cs         # test 7e — PR-independent PAT-shape contract (carved out — § 5)
├── FrozenPrCorpus.cs                # static immutable record of 5 PRs
├── Fixtures/
│   └── pr19-graphql-response.json   # ~50KB checked-in shape baseline, stripped via allowlist (§ 7)
└── Helpers/
    ├── GhCliPat.cs                  # gh auth token / env var, wraps result in RedactedSecret (§ 6.2)
    ├── GraphQLShapeDiff.cs          # ~50 LOC structural diff over JsonElement
    └── FixtureStripAllowlist.cs     # allowlist of GraphQL paths kept during capture-mode write
```

### 6.1 `FrozenPrCorpus.cs`

Immutable static record. SHAs and expected values are filled during implementation via `gh pr view <N> --json commits,files,reviewThreads`:

```csharp
internal static class FrozenPrCorpus
{
    public static readonly FrozenPrEntry Pr1 = new(
        PrNumber: 1,
        HeadSha: "<captured during impl>",
        ExpectedQuality: ClusteringQuality.Low,
        ExpectedIterationRange: null,                   // Low short-circuits
        ExpectedFiles: new[] { ".github/workflows/claude.yml", ".github/workflows/claude-code-review.yml" },
        ExpectedCommentAnchors: Array.Empty<CommentAnchor>());
    public static readonly FrozenPrEntry Pr16 = new(/* ... */);
    public static readonly FrozenPrEntry Pr19 = new(/* ... */);
    public static readonly FrozenPrEntry Pr22 = new(/* ... */);
    public static readonly FrozenPrEntry Pr28 = new(/* ... */);

    // Iteration order over the corpus — consumers iterate the entries directly.
    public static IEnumerable<FrozenPrEntry> All() =>
        new[] { Pr1, Pr16, Pr19, Pr22, Pr28 };

    // xUnit-facing wrapper for `[Theory] [MemberData(nameof(AllAsTheoryData))]`. The plan's
    // tests bind to this; All() is the cleaner enumeration for non-theory call sites.
    public static IEnumerable<object[]> AllAsTheoryData() =>
        All().Select(e => new object[] { e });
}

internal sealed record FrozenPrEntry(
    int PrNumber,
    string HeadSha,
    ClusteringQuality ExpectedQuality,
    (int Min, int Max)? ExpectedIterationRange,
    string[] ExpectedFiles,
    CommentAnchor[] ExpectedCommentAnchors);

internal sealed record CommentAnchor(string Path, int Line);
```

The record is the single source of truth for what each test asserts. Adding a new corpus PR is one new static field plus one `All()` entry.

### 6.2 `GhCliPat.cs`

Single helper that returns the PAT for the test run:

```csharp
internal static class GhCliPat
{
    private static readonly Lazy<string> _cached = new(Resolve);
    public static string Get() => _cached.Value;

    private static string Resolve()
    {
        // CI path: PRISM_INTEGRATION_PAT env var.
        var fromEnv = Environment.GetEnvironmentVariable("PRISM_INTEGRATION_PAT");
        if (!string.IsNullOrWhiteSpace(fromEnv)) return fromEnv;

        // Local path: gh CLI.
        using var p = new Process { StartInfo = new ProcessStartInfo("gh", "auth token --hostname github.com")
        { RedirectStandardOutput = true, UseShellExecute = false } };
        p.Start();
        var token = p.StandardOutput.ReadToEnd().Trim();
        p.WaitForExit(5_000);
        if (p.ExitCode != 0 || string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException(
                "No PRISM_INTEGRATION_PAT env var and `gh auth token` failed. " +
                "Run `gh auth login --scopes \"repo,read:org\"` or set PRISM_INTEGRATION_PAT.");
        return token;
    }
}
```

Cached for the whole test run; `gh` is only shelled out once per `dotnet test` invocation.

**PAT redaction.** The return value is wrapped in a `RedactedSecret` struct. Four-guard contract (all required, or the wrapper provides false confidence):
1. `ToString()` returns `"[REDACTED]"`.
2. `ToString(string format, IFormatProvider provider)` (the `IFormattable` overload) also returns `"[REDACTED]"`. FluentAssertions and `ILogger` template expansion call the formatted overload for non-primitive values.
3. The accessor is `Reveal()` — a **method**, not a property — so reflection-based property enumeration (used by FluentAssertions' object-graph formatter and by debugger visualizers) does not surface the raw value.
4. `[DebuggerDisplay("[REDACTED]")]` annotation prevents IDE debugger auto-expand from leaking the value during local triage.

No implicit string conversion operator. Test bodies use `.Reveal()` only at the HttpClient Authorization-header assignment site; a future test author who copy-pastes this pattern for a different sink (e.g., logging) is not enforced against, but the four guards above make the most common leak vectors structurally safe. The CI workflow (§ 8) additionally adds `::add-mask::` for defense-in-depth — masking only works if at least one of the two layers holds; we apply both.

### 6.3 `GraphQLShapeDiff.cs`

Walks two `JsonElement` trees and collects path-keyed differences as a list of strings:

- `+ <jsonPointer> (<kind>)` — present in actual, missing in expected.
- `- <jsonPointer>` — present in expected, missing in actual.
- `~ <jsonPointer> (<expectedKind> → <actualKind>)` — same key, different `JsonValueKind`.

Returns a `List<string>` consumed by the test's failure assertion. Arrays diff by index (positional); a future enhancement could diff by key for arrays of objects with a stable identifier, but the GraphQL shape under test today is small enough that positional diff is sufficient. The helper is covered by its own unit tests in `PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs` (synthetic inputs only — fast unit tests, no live calls).

**Self-check against the real fixture shape.** The differ author and the differ-test author are the same engineer, which creates bug-class-symmetric coverage — a depth bug in the walker would also be missing from the synthetic tests. Mitigation: one test in `GraphQLShapeDiffTests.cs` loads the real `Fixtures/pr19-graphql-response.json`, programmatically mutates a deeply-nested path representative of the GitHub GraphQL shape (e.g., `data.repository.pullRequest.timelineItems.nodes[0].author.login` becomes `data.repository.pullRequest.timelineItems.nodes[0].author.handle`), and asserts the differ reports the mutation. The path is chosen to exercise the same depth and array-of-objects nesting that the real GraphQL response uses. If the differ has a depth or array-walk bug, this test catches it.

### 6.4 Repo-root `.runsettings`

```xml
<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <RunConfiguration>
    <!-- Exclude integration tests AND strict-canonical sibling tests from default `dotnet test`.
         xUnit's trait filter property is `Category` (the trait name we apply); MSTest's is
         `TestCategory`. We use xUnit. The Canonical=Strict clause keeps the canonical-strict
         sibling tests (CanonicalIterationCountTests, § 10 silent-drift bullet) out of routine
         runs — they fire only via `dotnet test --filter "Canonical=Strict"` during triage. -->
    <TestCaseFilter>Category!=Integration&amp;Canonical!=Strict</TestCaseFilter>
  </RunConfiguration>
</RunSettings>
```

`dotnet test --filter "Category=Integration"` overrides the default filter and runs only the integration suite — that is the local-run command for developers and the CI command. Verified during implementation by (a) running `dotnet test` from repo root and observing zero integration tests in the output, (b) running `dotnet test --filter "Category=Integration"` and observing all seven integration tests run.

## 7. Capture mode

`Frozen_pr_graphql_shape_unchanged` reads `PRISM_FROZEN_PR_CAPTURE_FIXTURE` once at test-start:

- **Unset / empty:** asserts the live response equals the fixture; on mismatch, the failure message is the hand-rolled structural diff.
- **`=1`** (exact string equality, case-sensitive — see "Activation predicate" below): writes the live response to the source-tree fixture path `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` (resolved at test-run time from the test project's source-directory anchor, not from `bin/` output), then logs *"Captured fixture for PR #19 → <path>. Re-run without the env var to assert."* and **passes**.

**Activation predicate.** The capture code path activates only when `Environment.GetEnvironmentVariable("PRISM_FROZEN_PR_CAPTURE_FIXTURE") == "1"` — exact string equality. Setting the variable to `""` (empty string) does not activate. This is the contract the § 8 CI YAML's `PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''` line relies on for layer-1 protection: an empty-string assignment overrides any inherited value to a non-`"1"` state, and the exact-equality check fails. A future refactor that loosens the check to `!string.IsNullOrEmpty` would silently demote layer 1; the implementation pins the predicate in a single `IsCaptureModeEnabled()` helper with a comment naming this dependency.

Capture mode is the workflow for intentional schema updates: when a real GitHub GraphQL schema change rolls out, the developer runs the suite with the env var, diffs the resulting JSON in the PR review, and lands the fixture diff alongside any code changes. The runbook documents this end-to-end. There is no write-if-missing behaviour — fixture must exist or the test fails loudly with a "run with capture env var" hint.

**CI write-protection.** Capture mode must NEVER engage in CI (a leaked env var would silently rewrite the fixture and the run would still report green, masking shape drift indefinitely). Two-layer guard: (1) the CI workflow (§ 8) explicitly sets `PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''` to override any inherited value; (2) the capture code path throws `InvalidOperationException("Capture mode is disabled in CI to prevent silent fixture rewrites. Run locally with PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 to refresh.")` when both `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1` AND `CI` env var are set. Either layer is sufficient; together they're defence-in-depth.

**Fixture content discipline.** The captured GraphQL response can contain freeform text fields (PR description body, review comment bodies, commit messages) and identity fields (user logins, commit author emails). Because the fixture is checked into the repo's git history and PRism is currently a private repo but could be made public in future, the capture flow strips these before writing the file — keeping only the structural/metadata fields the shape-drift detector needs.

The strip is implemented as an allowlist in `FixtureStripAllowlist.cs` (only listed paths survive), not a denylist, so a future GraphQL field addition doesn't silently include sensitive content. **Category rule for the allowlist** (correctness criterion the implementer follows when populating it):
- **Kept:** structural and schema fields — type names, field presence, `JsonValueKind`, primitive count-valued fields (`totalCount`, `changedFiles`, etc.), enum-valued fields (`state`, `reviewType`).
- **Stripped:** all freeform text — PR/review/comment `body`, `bodyText`, `bodyHTML`, commit `message`, `title`. All identity fields — `email`, `login`, `name`, author/committer sub-objects beyond their type name.

Human PR review of any captured fixture is the final defense (a reviewer rejecting a PR with `body` content surviving is a structural backstop). No separate pre-write secret-pattern scan; the category rule above covers token-pattern paths because token strings would only appear in stripped freeform fields. (Round-2 PL-R2-1 dropped the redundant scan layer to control cumulative complexity.) The runbook (§ 9.6) documents the rebuild workflow; this section is the canonical location for the allowlist content rule.

## 8. CI workflow

New file `.github/workflows/integration-tests.yml`:

```yaml
name: Integration tests (live GitHub)
on:
  workflow_dispatch:   # manual only — no recurring schedule (see prose below)
jobs:
  integration:
    runs-on: windows-latest   # matches the main `ci.yml` runner for consistency
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }   # matches Directory.Build.props TargetFramework=net10.0
      - name: Mask PAT in subsequent log output
        shell: pwsh
        run: |
          $token = $env:PRISM_INTEGRATION_PAT
          if (-not [string]::IsNullOrWhiteSpace($token)) { Write-Output "::add-mask::$token" }
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}
      - run: dotnet test tests/PRism.GitHub.Tests.Integration --configuration Release --filter "Category=Integration&Canonical!=Strict" --logger "console;verbosity=detailed"
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}
          PRISM_FROZEN_PR_CAPTURE_FIXTURE: ''   # explicit override — capture mode MUST NOT engage in CI (§ 7)
```

Secret setup is one-time: the repo owner creates `PRISM_INTEGRATION_PAT` (fine-grained PAT, `metadata:read + pull_requests:read`, scoped to `prpande/PRism` only, **set to a finite expiry — recommend 90 days — with a calendar reminder for rotation**) before the first dispatched run. Failure routes through GitHub's default failure surface (UI + email if the user has notifications on). No Slack/Discord integration in scope.

**Why no recurring schedule.** PRism is a sole-owner PoC. A `schedule:` cron triggers a run every day regardless of repo activity; in a one-engineer project that becomes (a) an email stream the engineer trains themselves to filter, or (b) an Actions tab the engineer ignores until something else makes them look. Neither pattern delivers the value `nightly` typically delivers on a multi-engineer team (recurring sentinel that someone-on-rotation triages). The trigger events that should run this suite are explicit: a developer about to ship a change that touches `PRism.Core.Iterations/**` or `PRism.GitHub/GitHubReviewService*`, a release-tag cut, or a public GitHub announcement of a GraphQL schema change. Each of those is `workflow_dispatch`-able. If a future state introduces a second maintainer with on-call rotation, revisit and add the schedule then.

**Main CI (`.github/workflows/ci.yml`) update required.** The new test project is added to `PRism.sln` (§ 12), which makes it visible to the existing `dotnet test --no-build --configuration Release` step on every PR. To prevent integration tests from running on PR pushes and failing for lack of a PAT, the existing step is updated to explicitly pass `--settings .runsettings` (the file exists per § 6.4 and applies the `Category!=Integration` filter). Auto-discovery of `.runsettings` from the working directory is documented but the explicit `--settings` flag removes the risk that a future dotnet version changes discovery semantics. § 11 DoD includes the verification step (run `dotnet test` in main CI with no PAT secret and confirm zero integration tests are attempted).

## 9. Operator runbook (`docs/contract-tests.md`)

Living doc for engineers expanding the corpus. Sections:

1. **What this suite is for** — one paragraph; pointer back to this spec.
2. **Prereqs** —
   - **Local (recommended):** a fine-grained PAT scoped to `prpande/PRism` only with `metadata:read + pull_requests:read`, exported as `PRISM_INTEGRATION_PAT` in your shell profile. Smallest blast radius if the token leaks. Note: fine-grained PATs do not return scopes in the `X-OAuth-Scopes` header (the GitHub API does not expose fine-grained scope metadata at the `/user` endpoint at all); the fitness-smoke test 7e accepts this by design — see § 5 row 7e.
   - **Local (fallback):** `gh auth login --scopes "repo,read:org"` — the test suite uses `gh auth token`. The `repo` scope grants full read/write to every private repo your account can reach (not just `prpande/PRism`); the principle-of-least-privilege concern is real but acceptable for one-off runs. Test 7e's fitness-smoke contract works the same way as for the fine-grained path.
   - **CI:** `PRISM_INTEGRATION_PAT` secret (owner-managed), set with a finite expiry (90-day recommended) and a calendar reminder for rotation.
3. **Running locally** — `dotnet test --filter "Category=Integration"` from repo root.
4. **Test PR corpus** — table of the 5 PRs with shape rationale (mirrored from § 4 above for the audience that lands here without reading the spec first).
5. **Adding a new test PR** — checklist:
   - Pick on shape criteria (commit count, time gaps, `authoredDate` vs `committedDate` divergence). Do **not** run the algorithm first.
   - **Sequence lock-then-capture atomically.** Run a single script — committed in two equivalent forms at `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1` (PowerShell, primary — matches PRism's documented shell) and `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh` (bash, for cross-platform parity). Both scripts (a) lock the PR via `gh api -X PUT /repos/prpande/PRism/issues/{N}/lock`, then (b) immediately capture head SHA, files, comment anchors via `gh pr view <N> --json commits,files` and `gh api /repos/prpande/PRism/pulls/{N}/comments`. This window must be tight — locking first means no new comments can land; capturing immediately after means the snapshot reflects the locked state. **Do not** capture-then-lock; an in-flight comment between the two steps causes silent corpus drift. Both scripts run end-to-end against a known-good PR as part of the impl PR's verification step, confirming they remain runnable; the verification is part of § 11 DoD.
   - Add a new static field to `FrozenPrCorpus` and append it to `All()`.
   - Document the shape category in this runbook.
6. **Refreshing the GraphQL fixture** — when an intentional GitHub schema change lands. Run locally (NOT in CI — the workflow blocks it; § 7):
   - **PowerShell (PRism's documented shell):** `$env:PRISM_FROZEN_PR_CAPTURE_FIXTURE='1'; dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`
   - **bash (cross-platform):** `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`

   The capture flow strips freeform-text and identity fields against an allowlist (§ 7); review the resulting fixture diff in the PR alongside any related code edits.
7. **Triaging a shape-drift failure** — read the structural diff in the test output; check the GitHub changelog; decide intentional-update-vs-real-break.

   For **iteration-count failures** (tests 7a, 7h), use this decision rule:
   - Q1: Does the new count match a defensible hand-labeled boundary count for the PR's shape, derived without looking at the algorithm output? If **no**, the algorithm change is a regression — revisit the coefficient change.
   - Q2: If yes, does the PR's shape category (per § 4 table) still hold? If **yes**, update the expected count in `FrozenPrCorpus` with a one-line PR comment explaining the new canonical value. If **no** (the shape category no longer applies — e.g., a force-push event was added retroactively), retire the PR from the corpus and pick a replacement on the same shape criteria.

   For **range assertions on PRs #16 / #19** (§ 4.2), the range absorbs both tuning moves AND regressions within the range. The sibling strict-canonical tests in `CanonicalIterationCountTests.cs` (run via `dotnet test --filter "Canonical=Strict"`) assert the captured canonical value — when the range test passes but `Canonical=Strict` fails, apply Q1/Q2 above to decide whether the shift is a regression or a tuning move that warrants updating the canonical value.
8. **Unlocking a test PR** — `gh api -X DELETE /repos/prpande/PRism/issues/{N}/lock` if anyone needs to re-comment.
9. **PAT expiry recovery** — when the `PRISM_INTEGRATION_PAT` secret expires (after the 90-day reminder is missed or rotation lapses), all corpus tests fail with HTTP 401 (the GitHub API rejects the expired token). Diagnosis: check the secret's expiry date in repo Settings → Secrets and variables → Actions. Recovery: create a new fine-grained PAT with the same scope (`prpande/PRism`, `metadata:read + pull_requests:read`, new 90-day expiry, calendar reminder reset) and update the `PRISM_INTEGRATION_PAT` secret value. Re-trigger `workflow_dispatch` to confirm the suite returns to green.

Runbook is named `docs/contract-tests.md` (general) rather than `docs/frozen-pr-tests.md` (specific) so a future second contract-style suite can fold in without rename or split. Today it's single-suite.

## 10. Risks & coverage gaps

- **Force-push category gap.** Sweep of all 56 merged PRs found zero `HeadRefForcePushedEvent` entries. Pratyush's workflow is fix-on-top, never amend. **Decision: accept the gap, document it here, do not add an out-of-repo PR to close it.** Rationale: a single out-of-repo PR breaks the "single target repo, no manual authoring" property the redirect is buying — paying a structural cost for a single-shape gain. Compensation: the force-push amplification path of `ForcePushMultiplier` is exercised at unit level by `tests/PRism.Core.Tests/Iterations/ForcePushMultiplierTests.cs` (`Force_push_after_long_gap_returns_one_point_five`, `Force_push_with_null_shas_positions_by_occurredAt_in_window`, `Multiple_force_pushes_in_window_apply_at_most_once`). The integration suite does not duplicate this coverage.
- **Comment drift on closed-not-locked PRs.** Closed PRs accept new comments until locked. Mitigation: the implementation PR locks all 5 corpus PRs (#1, #16, #19, #22, #28) via `gh api -X PUT` calls performed by the implementing agent. Subset assertions for comments (test 7c) defend against accidental drift between lock-time and runtime — a new comment is not a failure unless it displaces an expected one.
- **Rate-limit budget.** Five PRs × ~3 GraphQL calls per test × 7 tests ≈ 105 requests per run, well under the 5000/hr authenticated budget. With manual-dispatch-only cadence (no recurring schedule per § 8), the daily ceiling is effectively bounded by however many times the developer runs it — practically <20 runs/day even during heavy debugging, ~2100 requests/day worst case. Trivial against the budget.
- **Self-referential bias — picking-time floor.** All five picks pre-date S4 (numbers ≤ 28, merged before 2026-05-09 when the iteration-clustering core was being built). Picks made on objective shape metrics without running the algorithm first. The runbook's "adding a new test PR" checklist reinforces this for future expansions. **Verification floor: self-attestation by the engineer who also built the algorithm.** No external second-party shape classification exists for the initial corpus. If a future engineer needs stronger verification (e.g., before this suite is used to validate algorithm changes by someone other than the original author), commission a second-party shape-category labelling against `FrozenPrCorpus` and reconcile against the existing labels.
- **Self-referential bias — population-time floor.** Beyond picking, the population the picks are drawn from is one engineer's merged PRs on one repo. The algorithm was implicitly tuned during S3 against the same author's commit cadence (`docs/spec/iteration-clustering-algorithm.md` was authored alongside the same workflow). The corpus validates the algorithm against the distribution it was fit to — passing here does not guarantee the algorithm generalizes to other developers' shapes. Mitigation deferred to P0+: once Pratyush has Codex review history on `mindbody/Api.Codex` (or a public OSS repo with relevant shape diversity), add 1-2 multi-author corpus PRs as a sanity check. Track as a P0+ corpus-expansion item; the redirect itself is not gated on it.
- **Range assertion silent-drift.** `Should().BeInRange(1, 2)` on PR #16 passes for both endpoints — if a coefficient regression silently shifts the algorithm's answer from the canonical value (e.g., 2) to the other endpoint (e.g., 1), the test stays green. Mitigation: alongside each ranged corpus entry, the impl adds a sibling test in `CanonicalIterationCountTests.cs` carrying `[Trait("Canonical", "Strict")]` that asserts equality against the captured canonical value (e.g., `Pr16_canonical_iteration_count_equals_2` → `Should().Be(2)`). Strict-canonical tests are excluded from default `dotnet test` (via the `.runsettings` filter rule, parallel to `Category!=Integration`) AND from the standard integration-suite filter; they run only via `dotnet test --filter "Canonical=Strict"` when a developer is triaging a suspected range-shift. This gives the canonical value compiler-and-runtime teeth — a coefficient retune that shifts the value to the range's other endpoint passes the range test but fails `Canonical=Strict` on next triage run, prompting the runbook's § 9.7 Q1/Q2 decision rule. Code comments alone (the round-1 `// canonical: N` convention) are not the mitigation — they have no enforcement and were dropped at round 2 (PL-R2-2 / AV-R2-3).
- **Corpus durability — enforced staleness trigger.** Today's corpus represents one engineer's 2026 cadence. Workflows evolve (rebasing, paired-work, CI/CD changes). Without a refresh mechanism, the corpus becomes a 2026-time-capsule that the algorithm gets tuned against. **Enforcement:** a unit test in `CorpusStalenessTest.cs` (not category-Integration, runs on every `dotnet test`) asserts `FrozenPrCorpus.All().Max(e => e.MergedAt) > DateTimeOffset.UtcNow.AddMonths(-18)`. When the most recent corpus PR ages past 18 months, the build fails with a message naming the runbook procedure (`See docs/contract-tests.md § 5 — add a ≤6-month-old PR on the same shape-criteria, optionally retire the oldest`). Today the trigger date is 2027-11-09 (18 months after PR #28's merge); a sole-owner project has no "next contributor" who reliably opens an issue, so the trigger has to live where the build sees it. **Limitation:** the trigger is refresh-additive — adding one fresh PR satisfies the assertion but doesn't replace older PRs. A replace-older-PRs refresh is deferred to a stronger trigger (multi-engineer adoption, observed workflow-cadence shift).
- **Single-anchor shape-drift detection (open follow-up).** `Frozen_pr_graphql_shape_unchanged` (test 7g) runs only against PR #19's full GraphQL response. PRs #16/#22/#28 are fetched by other tests via the same `GitHubReviewService` calls and return shapes that overlap heavily with #19 but may differ in timeline-event types unique to their categories (e.g., rebase-event traits in #16). A GitHub schema change to a field that appears only in those PRs' responses would not be caught by 7g, though the parser may surface the divergence via other test failures. **Trigger to expand to per-PR fixtures:** the first time shape drift is detected anywhere in the suite, evaluate whether the drift was field-typed within #19's coverage (no action) or outside it (open a follow-up task to add one fixture per remaining corpus PR with the same allowlist + write-protection treatment as `pr19-graphql-response.json`). Not addressing pre-emptively because the cost (4× fixture storage + 4× capture-mode complexity + 4× shape-strip review burden) is concrete and the gap is unmeasured.
- **Disjoint-not-overlapping with the real-flow Playwright suite.** The two live-GitHub suites overlap on neither runner nor surface:

  | Surface | Frozen-PR (this spec) | Real-flow Playwright (`2026-05-18-real-flow-e2e-playwright-design.md`) |
  |---|---|---|
  | Runner | xUnit | Playwright |
  | Stack layer | Backend-only (`GitHubReviewService` instantiated directly) | Full-stack browser (PRism.Web booted, browser-driven) |
  | Target repo | `prpande/PRism` (real merged history) | `prpande/prism-sandbox` (fixture PRs per teammate) |
  | GraphQL surface | Read queries (`pullRequest`, timeline, reviews) | Write mutations (`addPullRequestReview*`, `submit*`, `delete*`) |
  | Failure class caught | Parsing / derivation drift, GraphQL shape drift on read paths | FE→BE wire-up regressions, mutation-shape acceptance on write paths |
  | CI gate | `workflow_dispatch` only (no recurring schedule) | Local-dev / pre-release; not in CI |

  The two suites are deliberately complementary — neither's coverage subsumes the other's. New readers should see this table; existing real-flow consumers don't need to update their model. Per a user decision during brainstorming, real-flow's spec is not edited to add a cross-reference back; this spec carries the relationship statement.

- **Algorithm coefficient drift.** If `IterationClusteringCoefficients.ForcePushLongGapSeconds`, `MadThresholdSigmas`, etc. are tuned in a future PR, iteration counts on #16/#19/#22/#28 may shift. Range assertions on #16 and #19 absorb small tuning moves; equality assertions on #22 and #28 will fail loudly. Treat such failures as a signal to either (a) revisit the picks (does the new coefficient set still cluster these shapes correctly?) or (b) update the expected counts with explicit reasoning in the PR. The runbook calls this out under "triaging".

## 11. Definition of Done

- [ ] All five corpus PRs (#1, #16, #19, #22, #28) locked via the lock-then-capture atomic script (§ 9.5) — locks first, captures SHAs / files / comment anchors immediately after in the same script invocation. Both PowerShell + bash forms (`tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.{ps1,sh}`) executed end-to-end against a known-good PR during impl as a runnability check.
- [ ] `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` exists and is added to `PRism.sln`.
- [ ] All seven tests pass against pinned SHAs locally (`dotnet test --filter "Category=Integration"`) and via `workflow_dispatch` on the new CI job.
- [ ] `Frozen_pr_graphql_shape_unchanged` fixture (`Fixtures/pr19-graphql-response.json`) committed; fixture strip-allowlist verified (no freeform text, no identity emails, no secret-pattern matches).
- [ ] `GraphQLShapeDiff` covered by unit tests (synthetic inputs + the real-fixture self-check mutation test from § 6.3; not category-Integration).
- [ ] New repo-root `.runsettings` excludes `Category=Integration` from default `dotnet test`. Verified by running `dotnet test` (no `--filter`) and observing zero integration tests in the run output.
- [ ] `.github/workflows/ci.yml` updated to pass `--settings .runsettings` explicitly on the existing test step. Verified by triggering a PR push with no `PRISM_INTEGRATION_PAT` secret available and confirming zero integration tests are attempted.
- [ ] `docs/contract-tests.md` runbook lands in the same PR with the sections in § 9.
- [ ] `.github/workflows/integration-tests.yml` lands; `PRISM_INTEGRATION_PAT` secret created in the repo settings (90-day expiry, calendar reminder for both PAT rotation AND a 30-day workflow_dispatch poke — see § 8 trigger-events list) before the first dispatched run.
- [ ] Capture-mode CI write-protection verified (§ 7): unit test that asserts the capture code path throws when both `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1` AND `CI` env vars are set. Activation predicate test (`IsCaptureModeEnabled()` returns true only on exact-string `"1"`, false on `""`, `"true"`, `"yes"`, `"0"`) also lands.
- [ ] `RedactedSecret` four-guard contract verified (§ 6.2): unit tests confirm `ToString()`, `ToString("format", null)`, `[DebuggerDisplay]` attribute presence, and that `Reveal` is a method not a property (via reflection: `typeof(RedactedSecret).GetMethod("Reveal") != null` AND `typeof(RedactedSecret).GetProperty("Reveal") == null`).
- [ ] `FixtureStripAllowlist` category rule verified (§ 7): the allowlist's content is reviewed against the kept/stripped category rule before the first fixture capture; any field falling outside the categories requires an explicit comment in the allowlist source naming the rationale.
- [ ] `CanonicalIterationCountTests.cs` lands with strict-equality assertions for the ranged PRs (#16, #19); `[Trait("Canonical", "Strict")]` excluded from default and integration filters, runnable via `dotnet test --filter "Canonical=Strict"`.
- [ ] `CorpusStalenessTest.cs` lands and is part of the default (non-Integration) test run; asserts the corpus has at least one PR merged within the last 18 months.
- [ ] README addition pointing developers at the local-run command.
- [ ] `docs/specs/README.md` updated: this spec moves to the "In progress" group during impl and to "Implemented" once the impl PR lands.
- [ ] Memory `project_s3_task11_open` updated post-merge: replace with "S3 Task 11 redirected + shipped" entry naming this spec and the impl PR.

## 12. Files created and changed

| Path | Change |
|---|---|
| `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` | NEW |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` | NEW — corpus-anchored tests 7a/7b/7c/7f/7g/7h |
| `tests/PRism.GitHub.Tests.Integration/PatScopeContractTests.cs` | NEW — test 7e (PAT-shape contract, PR-independent — carved out per § 5 to keep the corpus suite focused) |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs` | NEW — includes the `RedactedSecret` wrapper (§ 6.2) |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiff.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs` | NEW (unit-test coverage for the differ; includes the real-fixture mutation self-check from § 6.3; no `Category` trait, so default `dotnet test` picks it up) |
| `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs` | NEW — applied during capture mode (§ 7); allowlist of GraphQL paths kept in the fixture (category rule documented in § 7) |
| `tests/PRism.GitHub.Tests.Integration/CanonicalIterationCountTests.cs` | NEW — strict-equality sibling tests for ranged corpus PRs (#16, #19); `[Trait("Canonical", "Strict")]` so they're excluded from default + integration filters; runnable via `--filter "Canonical=Strict"` during triage (§ 9.7, § 10 silent-drift bullet) |
| `tests/PRism.GitHub.Tests.Integration/CorpusStalenessTest.cs` | NEW — non-Integration unit test that fails the build when the most recent corpus PR is more than 18 months old (§ 10 corpus-durability enforcement) |
| `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.ps1` | NEW — PowerShell form of the atomic lock-then-capture script (primary; matches PRism's documented shell) |
| `tests/PRism.GitHub.Tests.Integration/scripts/lock-and-capture.sh` | NEW — bash form of the atomic lock-then-capture script (cross-platform parity) |
| `PRism.sln` | + new test project |
| `.runsettings` | NEW — exclude `Category=Integration` from default `dotnet test` |
| `.github/workflows/integration-tests.yml` | NEW |
| `.github/workflows/ci.yml` | + `--settings .runsettings` on the existing `dotnet test` step (§ 8 main CI update) |
| `docs/contract-tests.md` | NEW |
| `README.md` | + brief integration-suite local-run section |
| `docs/specs/README.md` | + entry under "In progress" → "Implemented" on impl merge |

## 12.1 Tracked follow-ups (separate from this spec)

- **Rename `ForcePushMultiplier` → `CommitGapAndForcePushMultiplier`.** Spec § 4.1 documents that the class is misnamed (it does short-gap suppression as the early-return path, force-push amplification only as the secondary path). The rename is out of scope here, but every reader of the spec or source has to relearn the same clarification. Tracking the rename as an explicit follow-up gives § 4.1 a finite lifetime. **Mitigation in this spec's scope:** plan task adds an XML docstring on `ForcePushMultiplier` mirroring § 4.1's two-path explanation, so source-code readers don't have to find this spec to disambiguate.

## 13. Open during implementation

These are mechanical capture steps the implementation PR resolves; the spec does not pre-commit values:

- **Pinned head SHAs** for each of the five corpus PRs. Capture via `gh pr view <N> --json commits`.
- **Expected files list** per PR. Capture via `gh pr view <N> --json files`.
- **Expected comment-anchor tuples** for PR #19. Capture via `gh api /repos/prpande/PRism/pulls/19/comments` and filter to the relevant subset.
- *(removed at round 2 — test 7e was redesigned from scope-shape assertion to a fitness-smoke check; see § 5 row 7e for the current contract. The original equality-vs-superset open question is no longer applicable because no scope assertion works across both fine-grained and classic PAT shapes — see FEAS-R2-1/FEAS-R2-2 round-2 findings.)*
