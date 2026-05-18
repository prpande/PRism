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

This is **strict-upgrade** over the original framing: real shapes from real review cycles instead of synthetic shapes from one developer trying to anticipate the algorithm.

## 2. In scope / out of scope

**In:**

- New `tests/PRism.GitHub.Tests.Integration/` xUnit project gated by `[Trait("Category", "Integration")]` and excluded from default `dotnet test` via a new repo-root `.runsettings` (xUnit trait filter `Category!=Integration`).
- Seven xUnit tests (5 parameterized over the 5-PR corpus + 2 single-PR-anchored — see § 4).
- A capture mode for the GraphQL shape-drift fixture, env-gated.
- A `.github/workflows/integration-tests.yml` job running on `workflow_dispatch` + nightly schedule, authenticated via a `PRISM_INTEGRATION_PAT` secret.
- An operator runbook at `docs/contract-tests.md` covering: prereqs, running, the PR corpus + shape rationale, adding a new test PR, refreshing the fixture, triaging shape-drift failures, unlocking a test PR.
- A short README addition pointing developers at the local-run command.
- Locking conversation on the five corpus PRs (`gh api -X PUT /repos/prpande/PRism/issues/{N}/lock`) — performed by the implementing agent during the implementation PR, not the user.

**Out:**

- Force-push-shape integration coverage (§ 10 — accepted gap; unit tests at `ForcePushMultiplierTests.Force_push_after_long_gap_returns_one_point_five` cover the amplification path).
- CI gating on PR push. The suite is opt-in (`workflow_dispatch` + nightly) only.
- Multi-target-repo support. The single-target-repo property is load-bearing — the suite's value comes from PRs that weren't authored for it.
- Adding an out-of-repo force-push PR. Considered and rejected (§ 10) — breaks the single-target-repo property for a single-shape gain that's already covered at unit level.
- Mutation testing of the suite. The seven tests are direct contract assertions; mutation-resistance can be revisited at P0+.
- Coordination edit to `2026-05-18-real-flow-e2e-playwright-design.md` § 10 Risks paragraph. The disjoint-vs-overlapping relationship between the two suites is documented in this spec (§ 10 below) for new readers; real-flow's own spec is not edited.

## 3. Approach in one paragraph

A new xUnit test project at `tests/PRism.GitHub.Tests.Integration/` instantiates `GitHubReviewService` against live GitHub with a real `HttpClient`. PATs come from `gh auth token --hostname github.com` (executed via `System.Diagnostics.Process.Start`) locally and from the `PRISM_INTEGRATION_PAT` env var in CI; a single `GhCliPat` helper picks the right source. Tests pin to commit SHAs (not branch HEADs) read from a `FrozenPrCorpus` static record in code; the implementation captures those SHAs once via `gh pr view <N> --json commits` and writes them into the corpus record. A separate `Frozen_pr_graphql_shape_unchanged` test compares the full GraphQL response for the anchor PR (#19) against a checked-in fixture JSON; the structural diff is hand-rolled (~50 LOC over `JsonElement`, no NuGet dep) and the diff is what appears in xUnit's failure message. Capture mode (`PRISM_FROZEN_PR_CAPTURE_FIXTURE=1`) rewrites the fixture instead of asserting, for intentional-schema-update workflows. Default `dotnet test` excludes the `Integration` trait via a new `.runsettings` at repo root; CI runs the suite only on `workflow_dispatch` or a nightly schedule with a fine-grained `PRISM_INTEGRATION_PAT` secret (`metadata:read + pull_requests:read` scoped to `prpande/PRism`).

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

`tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` — seven tests, xUnit `[Theory]` over `FrozenPrCorpus.All()` for the parameterized ones, `[Fact]` for the anchored ones.

| # | Test | Anchored on | Asserts |
|---|---|---|---|
| 7a | `Frozen_pr_returns_expected_iteration_count` | All 5 (parameterized) | Iteration count matches `FrozenPrCorpus[i].ExpectedIterationRange` (encoded as `(Min, Max)` tuple — when `Min == Max`, assertion is `Should().Be(Min)`; otherwise `Should().BeInRange(Min, Max)`. When the tuple is `null` — PR #1 — the assertion is `iterations.Should().BeNull()`). |
| 7b | `Frozen_pr_returns_expected_files_in_diff` | All 5 (parameterized) | Files list at the pinned SHA is a SUPERSET of `FrozenPrCorpus[i].ExpectedFiles`. Subset assertion (not equality) so a future GraphQL field addition doesn't flake the test. |
| 7c | `Frozen_pr_existing_comments_have_expected_anchors` | PR #19 | `FrozenPrCorpus[19].ExpectedCommentAnchors` is a SUBSET of returned comment-anchor tuples. Subset assertion defends against accidental new comments between lock-time and runtime. Failure message includes the hint *"If `Frozen_pr_graphql_shape_unchanged` is also failing, fix the fixture first; this assertion runs against parsed shape."* |
| ~~7d~~ | ~~`Frozen_pr_force_push_event_appears_in_timeline`~~ | DROPPED — see § 10 | n/a |
| 7e | `Frozen_pr_handles_pat_scope_validation_for_read_paths` | n/a — exercises `IReviewService.ValidateCredentialsAsync` only | Returned scope set matches expected `metadata:read + pull_requests:read`. PAT-shape contract test; independent of any specific PR. |
| 7f | `Frozen_pr_returns_clustering_quality_ok` | All 5 (parameterized) | `quality === "low"` on PR #1, `quality === "ok"` on PRs #16/#19/#22/#28. |
| 7g | `Frozen_pr_graphql_shape_unchanged` | PR #19 | Full GraphQL response structurally equal to `Fixtures/pr19-graphql-response.json`. Failure message contains the hand-rolled structural diff: `+ path`, `- path`, `~ path (typeA → typeB)`. |
| 7h | `Frozen_pr_handles_rebased_committedDate_collision` | PR #16 | Iteration count in `[1, 2]` despite 9 commits sharing identical `committedDate`. Separate from 7f because PR #16 is healthy multi-commit (`quality === "ok"`) — not degenerate-input — so the assertion is behavioral, not quality-class. |

## 6. Architecture / components

```
tests/PRism.GitHub.Tests.Integration/
├── PRism.GitHub.Tests.Integration.csproj
├── FrozenPrismPrTests.cs            # the seven tests
├── FrozenPrCorpus.cs                # static immutable record of 5 PRs
├── Fixtures/
│   └── pr19-graphql-response.json   # ~50KB checked-in shape baseline
└── Helpers/
    ├── GhCliPat.cs                  # shells out to `gh auth token` / reads CI env
    └── GraphQLShapeDiff.cs          # ~50 LOC structural diff over JsonElement
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

    public static IEnumerable<object[]> All() =>
        new[] { Pr1, Pr16, Pr19, Pr22, Pr28 }.Select(e => new object[] { e });
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

### 6.3 `GraphQLShapeDiff.cs`

Walks two `JsonElement` trees and collects path-keyed differences as a list of strings:

- `+ <jsonPointer> (<kind>)` — present in actual, missing in expected.
- `- <jsonPointer>` — present in expected, missing in actual.
- `~ <jsonPointer> (<expectedKind> → <actualKind>)` — same key, different `JsonValueKind`.

Returns a `List<string>` consumed by the test's failure assertion. Arrays diff by index (positional); a future enhancement could diff by key for arrays of objects with a stable identifier, but the GraphQL shape under test today is small enough that positional diff is sufficient. The helper is covered by its own unit tests in `PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs` (synthetic inputs only — fast unit tests, no live calls).

### 6.4 Repo-root `.runsettings`

```xml
<?xml version="1.0" encoding="utf-8"?>
<RunSettings>
  <RunConfiguration>
    <!-- Exclude integration tests from default `dotnet test`. xUnit's trait filter property is
         `Category` (the trait name we apply); MSTest's is `TestCategory`. We use xUnit. -->
    <TestCaseFilter>Category!=Integration</TestCaseFilter>
  </RunConfiguration>
</RunSettings>
```

`dotnet test --filter "Category=Integration"` overrides the default filter and runs only the integration suite — that is the local-run command for developers and the CI command. Verified during implementation by (a) running `dotnet test` from repo root and observing zero integration tests in the output, (b) running `dotnet test --filter "Category=Integration"` and observing all seven integration tests run.

## 7. Capture mode

`Frozen_pr_graphql_shape_unchanged` reads `PRISM_FROZEN_PR_CAPTURE_FIXTURE` once at test-start:

- **Unset / empty:** asserts the live response equals the fixture; on mismatch, the failure message is the hand-rolled structural diff.
- **`=1`:** writes the live response to `Fixtures/pr19-graphql-response.json` (the path resolved relative to the test assembly directory walked back to the source tree), then logs *"Captured fixture for PR #19 → <path>. Re-run without the env var to assert."* and **passes**.

Capture mode is the workflow for intentional schema updates: when a real GitHub GraphQL schema change rolls out, the developer runs the suite with the env var, diffs the resulting JSON in the PR review, and lands the fixture diff alongside any code changes. The runbook documents this end-to-end. There is no write-if-missing behaviour — fixture must exist or the test fails loudly with a "run with capture env var" hint.

## 8. CI workflow

New file `.github/workflows/integration-tests.yml`:

```yaml
name: Integration tests (live GitHub)
on:
  workflow_dispatch:
  schedule:
    - cron: '17 4 * * *'   # 04:17 UTC nightly — off-hours, off-the-hour
jobs:
  integration:
    runs-on: windows-latest   # matches the main `ci.yml` runner for consistency
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-dotnet@v4
        with: { dotnet-version: '10.0.x' }   # matches Directory.Build.props TargetFramework=net10.0
      - run: dotnet test tests/PRism.GitHub.Tests.Integration --configuration Release --filter "Category=Integration" --logger "console;verbosity=detailed"
        env:
          PRISM_INTEGRATION_PAT: ${{ secrets.PRISM_INTEGRATION_PAT }}
```

Secret setup is one-time: the repo owner creates `PRISM_INTEGRATION_PAT` (fine-grained PAT, `metadata:read + pull_requests:read`, scoped to `prpande/PRism` only) before the first scheduled run. Failure routes through GitHub's default failure surface (UI + email if the user has notifications on). No Slack/Discord integration in scope.

## 9. Operator runbook (`docs/contract-tests.md`)

Living doc for engineers expanding the corpus. Sections:

1. **What this suite is for** — one paragraph; pointer back to this spec.
2. **Prereqs** — local: `gh auth login --scopes "repo,read:org"`. CI: `PRISM_INTEGRATION_PAT` secret (owner-managed).
3. **Running locally** — `dotnet test --filter "Category=Integration"` from repo root.
4. **Test PR corpus** — table of the 5 PRs with shape rationale (mirrored from § 4 above for the audience that lands here without reading the spec first).
5. **Adding a new test PR** — checklist:
   - Pick on shape criteria (commit count, time gaps, `authoredDate` vs `committedDate` divergence). Do **not** run the algorithm first.
   - Capture the PR head SHA: `gh pr view <N> --json commits | jq '.commits[-1].oid'`.
   - Lock the conversation: `gh api -X PUT /repos/prpande/PRism/issues/{N}/lock`.
   - Add a new static field to `FrozenPrCorpus` and append it to `All()`.
   - Document the shape category in this runbook.
6. **Refreshing the GraphQL fixture** — when an intentional GitHub schema change lands: `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1 dotnet test --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"`; commit the fixture diff alongside any related code edits.
7. **Triaging a shape-drift failure** — read the structural diff in the test output; check the GitHub changelog; decide intentional-update-vs-real-break.
8. **Unlocking a test PR** — `gh api -X DELETE /repos/prpande/PRism/issues/{N}/lock` if anyone needs to re-comment.

Runbook is named `docs/contract-tests.md` (general) rather than `docs/frozen-pr-tests.md` (specific) so a future second contract-style suite can fold in without rename or split. Today it's single-suite.

## 10. Risks & coverage gaps

- **Force-push category gap.** Sweep of all 56 merged PRs found zero `HeadRefForcePushedEvent` entries. Pratyush's workflow is fix-on-top, never amend. **Decision: accept the gap, document it here, do not add an out-of-repo PR to close it.** Rationale: a single out-of-repo PR breaks the "single target repo, no manual authoring" property the redirect is buying — paying a structural cost for a single-shape gain. Compensation: the force-push amplification path of `ForcePushMultiplier` is exercised at unit level by `tests/PRism.Core.Tests/Iterations/ForcePushMultiplierTests.cs` (`Force_push_after_long_gap_returns_one_point_five`, `Force_push_with_null_shas_positions_by_occurredAt_in_window`, `Multiple_force_pushes_in_window_apply_at_most_once`). The integration suite does not duplicate this coverage.
- **Comment drift on closed-not-locked PRs.** Closed PRs accept new comments until locked. Mitigation: the implementation PR locks all 5 corpus PRs (#1, #16, #19, #22, #28) via `gh api -X PUT` calls performed by the implementing agent. Subset assertions for comments (test 7c) defend against accidental drift between lock-time and runtime — a new comment is not a failure unless it displaces an expected one.
- **Rate-limit budget.** Five PRs × ~3 GraphQL calls per test × 7 tests ≈ 105 requests per run, well under the 5000/hr authenticated budget. Nightly cadence + manual dispatch means the daily ceiling is ~1000 requests on heavy days, still trivial against the budget.
- **Self-referential bias.** All five picks pre-date S4 (numbers ≤ 28, merged before 2026-05-09 when the iteration-clustering core was being built). Picks made on objective shape metrics without running the algorithm first. The runbook's "adding a new test PR" checklist reinforces this for future expansions.
- **Disjoint-not-overlapping with the real-flow Playwright suite.** The two live-GitHub suites overlap on neither runner nor surface:

  | Surface | Frozen-PR (this spec) | Real-flow Playwright (`2026-05-18-real-flow-e2e-playwright-design.md`) |
  |---|---|---|
  | Runner | xUnit | Playwright |
  | Stack layer | Backend-only (`GitHubReviewService` instantiated directly) | Full-stack browser (PRism.Web booted, browser-driven) |
  | Target repo | `prpande/PRism` (real merged history) | `prpande/prism-sandbox` (fixture PRs per teammate) |
  | GraphQL surface | Read queries (`pullRequest`, timeline, reviews) | Write mutations (`addPullRequestReview*`, `submit*`, `delete*`) |
  | Failure class caught | Parsing / derivation drift, GraphQL shape drift on read paths | FE→BE wire-up regressions, mutation-shape acceptance on write paths |
  | CI gate | `workflow_dispatch` + nightly | Local-dev / pre-release; not in CI |

  The two suites are deliberately complementary — neither's coverage subsumes the other's. New readers should see this table; existing real-flow consumers don't need to update their model. Per a user decision during brainstorming, real-flow's spec is not edited to add a cross-reference back; this spec carries the relationship statement.

- **Algorithm coefficient drift.** If `IterationClusteringCoefficients.ForcePushLongGapSeconds`, `MadThresholdSigmas`, etc. are tuned in a future PR, iteration counts on #16/#19/#22/#28 may shift. Range assertions on #16 and #19 absorb small tuning moves; equality assertions on #22 and #28 will fail loudly. Treat such failures as a signal to either (a) revisit the picks (does the new coefficient set still cluster these shapes correctly?) or (b) update the expected counts with explicit reasoning in the PR. The runbook calls this out under "triaging".

## 11. Definition of Done

- [ ] All five corpus PRs (#1, #16, #19, #22, #28) locked via `gh api -X PUT /repos/prpande/PRism/issues/{N}/lock` by the implementing agent.
- [ ] `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` exists and is added to `PRism.sln`.
- [ ] All seven tests pass against pinned SHAs locally (`dotnet test --filter "Category=Integration"`) and via `workflow_dispatch` on the new CI job.
- [ ] `Frozen_pr_graphql_shape_unchanged` fixture (`Fixtures/pr19-graphql-response.json`) committed.
- [ ] `GraphQLShapeDiff` covered by unit tests (synthetic inputs; not category-Integration).
- [ ] New repo-root `.runsettings` excludes `Category=Integration` from default `dotnet test`. Verified by running `dotnet test` (no `--filter`) and observing zero integration tests in the run output.
- [ ] `docs/contract-tests.md` runbook lands in the same PR with the sections in § 9.
- [ ] `.github/workflows/integration-tests.yml` lands; `PRISM_INTEGRATION_PAT` secret created in the repo settings before the first scheduled run.
- [ ] README addition pointing developers at the local-run command.
- [ ] `docs/specs/README.md` updated: this spec moves to the "In progress" group during impl and to "Implemented" once the impl PR lands.
- [ ] Memory `project_s3_task11_open` updated post-merge: replace with "S3 Task 11 redirected + shipped" entry naming this spec and the impl PR.

## 12. Files created and changed

| Path | Change |
|---|---|
| `tests/PRism.GitHub.Tests.Integration/PRism.GitHub.Tests.Integration.csproj` | NEW |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/FrozenPrCorpus.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GhCliPat.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiff.cs` | NEW |
| `tests/PRism.GitHub.Tests.Integration/Helpers/GraphQLShapeDiffTests.cs` | NEW (unit-test coverage for the differ; no `Category` trait, so default `dotnet test` picks it up) |
| `PRism.sln` | + new test project |
| `.runsettings` | NEW — exclude `Category=Integration` from default `dotnet test` |
| `.github/workflows/integration-tests.yml` | NEW |
| `docs/contract-tests.md` | NEW |
| `README.md` | + brief integration-suite local-run section |
| `docs/specs/README.md` | + entry under "In progress" → "Implemented" on impl merge |

## 13. Open during implementation

These are mechanical capture steps the implementation PR resolves; the spec does not pre-commit values:

- **Pinned head SHAs** for each of the five corpus PRs. Capture via `gh pr view <N> --json commits`.
- **Expected files list** per PR. Capture via `gh pr view <N> --json files`.
- **Expected comment-anchor tuples** for PR #19. Capture via `gh api /repos/prpande/PRism/pulls/19/comments` and filter to the relevant subset.
- **Expected PAT scope set** for test 7e. The PAT used (local: `gh auth token`; CI: `PRISM_INTEGRATION_PAT`) is configured with `metadata:read + pull_requests:read` per § 3 and § 8; test 7e asserts that `IReviewService.ValidateCredentialsAsync` correctly reports that scope set. If `gh auth token` returns a PAT with broader scopes (the developer used `gh auth login --scopes "repo,read:org"` for general work), the test may need to assert SUPERSET rather than EQUALITY — the implementation step decides based on whether the local + CI scope sets converge or diverge. Equality is preferred; superset is the fallback.
