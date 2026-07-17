# #773 Outdated-Thread Wire Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the GitHub review-thread fields that make outdated threads representable (`isOutdated`, `originalLine`, `originalStartLine`, `subjectType`, first-comment `diffHunk` + parent-review `databaseId`), make `LineNumber` honestly nullable end-to-end, remove the dead `AnchorSha`, and stop the file-tree comment indicator counting threads the user cannot find in the diff.

**Architecture:** Slice 1 of `docs/specs/2026-07-17-review-threads-timeline-residency-design.md`. One GraphQL query gains thread/comment fields; `ReviewThreadDto` changes shape; `GitHubPrParser` maps GitHub nulls faithfully instead of coercing to `0`; the frozen PR #19 fixture is re-captured with the new scalar fields allowlisted; the frontend mirrors the type and filters the indicator to anchored threads. No display of outdated threads yet — that is slice 2 (#774).

**Tech Stack:** .NET 10 minimal API + System.Text.Json manual parsing (xunit + FluentAssertions), React + TypeScript + Vite (vitest + Testing Library), Playwright e2e, frozen-fixture contract tests (`tests/PRism.GitHub.Tests.Integration`).

## Global Constraints

- **TDD, red → green → refactor, every behavior change** (`.ai/docs/development-process.md`). Pure deletions/refactors lean on the existing suite instead of new tests.
- **PR size cap: 10–15 changed files.** This plan therefore ships as **three serial PRs** (A → B → C below); check `git diff --stat` before each `gh pr create`.
- **Spec fidelity:** only fields the DTO carries are fetched — `startLine` / `startDiffSide` / `diffSide` are **not** added to the query. `DiffHunk` is projected thread-level from the **first** comment; per-comment hunks stay off the wire.
- **Fixture rules:** `diffHunk` stays **stripped (nulled)** in the fixture — the stripper's contract nulls freeform values; only the four scalars `isOutdated originalLine originalStartLine subjectType` join the allowlist. Capture mode (`PRISM_FROZEN_PR_CAPTURE_FIXTURE=1`) runs **locally only**, never in CI, and never from a shell profile.
- **Backend test runs use `--settings .runsettings`** for full-suite runs (it excludes `Category=Integration` and `Canonical=Strict`, mirroring CI). Targeted `--filter` runs on the Integration project deliberately omit it.
- **Run one build/test command at a time, foreground, timeout ≥ 300000 ms.**
- **Commit-message discipline:** `fix(#773):` auto-closes the issue on merge to main — use it **only** in PR C (the closing PR). PRs A and B use `refactor(#773):` / `feat(#773):` / `test(#773):` / `docs(#773):` prefixes and "Part of #773" in the PR body; PR C's body says "Closes #773".
- **New/changed frontend files:** run prettier via the real binary before committing (`cd frontend && node ./node_modules/prettier/bin/prettier.cjs --write <files>`); `npm run lint` includes `prettier --check`.
- **Comment minimalism:** no narration comments; keep/extend existing doc-comment style only where a non-obvious decision needs recording.
- **After any local Playwright run:** `git checkout -- review-assets/` before staging (e2e runs dirty committed PNGs).
- **Pre-push checklist (steps 1–4 + conditional 6) verbatim before every push** — see Task 3/7/10 verify steps.

## PR decomposition (plan-level deviation, recorded here)

The spec's rollout section says "#773 first, then #774" without sub-splitting #773. A single #773 PR touches ~28 files — the union of every task's Files list: 10 backend, 16 frontend (the `AnchorSha` removal alone fans into 9 test fixtures), 2 docs — breaching the 10–15 file cap. #773 therefore ships as three serial PRs, each independently green:

| PR | Content | Files | Closes |
|----|---------|-------|--------|
| **A** | Remove dead `AnchorSha`/`anchorSha` end-to-end (pure deletion; no behavior change) | ~14 | — (Part of #773) |
| **B** | Backend wire change: query fields, DTO shape, parser, fixture regen, backend consumer fixes. Carries the spec + this plan doc. | ~12 | — (Part of #773) |
| **C** | Frontend consumers: `types.ts` mirror, indicator filter (the ghost-glyph fix), type-honesty sweep | 7 | #773 |

Wire-shape rule note for PR B: after B merges (before C), the wire carries `lineNumber: null` for outdated threads plus the new keys, while the frontend type still says `lineNumber: number`. This is runtime-safe — verified: the only frontend readers of `thread.lineNumber` are `DiffPane.tsx`'s `threadsByLine` join (a `Map` keyed by line; `null` never matches a diff row — same invisibility as today's `0`) and two aria-label strings unreachable for unanchored threads; unknown JSON keys are ignored. PR B's body documents this shield explicitly, per the cross-tier rule's "documented compat shim" clause. The user-visible fix (glyph) lands in C; hold B and C close together.

Branching: each PR branches from the then-current `origin/main` (serial; the repo's required check is strict, so merges are serial anyway). Branch names: `773-anchorsha-cleanup`, `773-outdated-thread-wire-data`, `773-indicator-anchored-only`. Repo squash-merge is disabled — merge with `--merge`.

---

## PR A — remove dead `AnchorSha` (pure deletion)

### Task 1: Backend `AnchorSha` removal

**Files:**
- Modify: `PRism.Core.Contracts/ReviewThreadDto.cs:5-11`
- Modify: `PRism.GitHub/GitHubPrParser.cs:235-243`
- Modify: `tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs:122-128`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `ReviewThreadDto(string ThreadId, string FilePath, int LineNumber, bool IsResolved, IReadOnlyList<ReviewCommentDto> Comments)` — the 5-component record Tasks 2–3 and PR B build on. The wire JSON loses the `anchorSha` key.

This is a refactor (dead field, always `""`, zero readers — verified by grep: the only `AnchorSha` occurrences in `*.cs` are these three files). Per the repo's TDD rules, refactors lean on the existing suite; no new tests.

- [ ] **Step 1: Branch from main**

```bash
git fetch origin && git switch -c 773-anchorsha-cleanup origin/main
```

- [ ] **Step 2: Remove the record component**

In `PRism.Core.Contracts/ReviewThreadDto.cs`, delete the `string AnchorSha,` line:

```csharp
public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int LineNumber,
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);
```

- [ ] **Step 3: Update the parser construction site**

In `PRism.GitHub/GitHubPrParser.cs` (`ParseReviewThreads`, ~line 235), delete the entire 8-line "AnchorSha is intentionally empty here…" comment block and change the construction to:

```csharp
            result.Add(new ReviewThreadDto(threadId, path, line, IsResolved: resolved, Comments: comments));
```

- [ ] **Step 4: Update the test-helper construction site**

In `tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs` (`MakeDetail()`, ~line 126), delete the `AnchorSha: "head1",` argument line.

- [ ] **Step 5: Build and run the backend suite**

Run (repo root, foreground, ≥300s timeout):
```
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: build succeeds with 0 errors; all tests PASS (no behavior changed).

- [ ] **Step 6: Commit**

```bash
git add PRism.Core.Contracts/ReviewThreadDto.cs PRism.GitHub/GitHubPrParser.cs tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs
git commit -m "refactor(#773): drop dead ReviewThreadDto.AnchorSha from the backend"
```

### Task 2: Frontend `anchorSha` removal

**Files:**
- Modify: `frontend/src/api/types.ts:331` (delete `anchorSha: string;` from `ReviewThreadDto`)
- Modify (delete one `anchorSha: '…',` fixture line each):
  - `frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts:13`
  - `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.test.tsx:45`
  - `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.threadHighlight.test.tsx:31`
  - `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.rowMemo.perf.test.tsx:52`
  - `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.optimistic.test.tsx:26`
  - `frontend/src/components/PrDetail/FilesTab/FilesTab.renderCount.perf.test.tsx:96`
  - `frontend/src/components/PrDetail/FilesTab/FilesTab.viewPreservation.test.tsx:157`
  - `frontend/__tests__/FilesTabOptimisticEviction.test.tsx:88`
  - `frontend/__tests__/OverviewTab.test.tsx:70,78,86` (three literals)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx:31` — comment text only: `// cast satisfies the omitted editedAt/anchorSha fields — keep it.` → `// cast satisfies the omitted editedAt field — keep it.`

**Interfaces:**
- Consumes: the 5-component backend record from Task 1 (same PR — wire and type change together).
- Produces: `ReviewThreadDto` TS interface without `anchorSha`; every thread fixture literal compiles against it.

Do **not** touch `FilesTab.tsx`'s local `anchorSha` variable (line 168) or `useInlineComposer`'s `anchorSha` — those are the draft-anchoring seam (`anchorShaForRange`, #723), unrelated to the DTO field.

- [ ] **Step 1: Delete the interface field**

`frontend/src/api/types.ts` — `ReviewThreadDto` becomes:

```ts
export interface ReviewThreadDto {
  threadId: string;
  filePath: string;
  lineNumber: number;
  isResolved: boolean;
  comments: ReviewCommentDto[];
}
```

- [ ] **Step 2: Delete every fixture's `anchorSha` line**

Remove the single `anchorSha: '…',` property line at each location listed above, and reword the `ExistingCommentWidget.test.tsx:31` comment. To verify completeness, grep for the property-literal `anchorSha:` (with the colon) under `frontend/` — expect zero remaining matches. A bare `anchorSha` grep is the wrong check: it also matches the unrelated `anchorShaForRange` draft-anchoring seam (`range.ts`, `range.test.ts`, `FilesTab.tsx`, `useInlineComposer.ts`/`.test.tsx`, and comment mentions in `gutter.tsx`/`DiffLineRow.tsx`) — leave all of those untouched.

- [ ] **Step 3: Lint, typecheck, test**

Run (from `frontend/`, foreground):
```
npm run lint
npm run build
npm test
```
Expected: all three PASS. (`npm run build` runs `tsc -b`, the real typecheck — it is what catches a missed fixture.)

- [ ] **Step 4: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/components/PrDetail/FilesTab frontend/__tests__
git commit -m "refactor(#773): drop dead anchorSha from the frontend ReviewThreadDto mirror"
```

### Task 3: PR A verify and raise

- [ ] **Step 1: Full pre-push checklist** (steps 1–4; step 6 e2e applies — the wire shape changed):

```
cd frontend && npm run lint && npm run build && npm test
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
cd frontend && npx playwright test
```
Expected: everything green (read the Playwright reporter summary — `N passed`, not the artifact dirs). Then `git checkout -- review-assets/` if dirty.

- [ ] **Step 2: Push and raise the PR**

```bash
git push -u origin 773-anchorsha-cleanup
gh pr create --title "refactor(#773): remove dead ReviewThreadDto.AnchorSha end-to-end" --body-file <body>
```
Body content: what/why (dead since S3 — the loader never stamped it; zero runtime readers on either tier, verified by grep), "Part of #773 — first of three slices (cleanup → wire data → frontend consumers)", wire note (the `anchorSha` JSON key disappears; no frontend consumer reads it), proof section with the checklist results. No local file paths in the body.

- [ ] **Step 3: Merge gate** — follow the repo's bot-review loop (`@claude review` if needed); merge per the bounded self-merge envelope **only if all six conditions hold** (this PR is mechanical deletion — likely eligible); otherwise hand to the owner. Repo auto-deletes the head branch on merge; clean up local branch.

---

## PR B — backend wire change

### Task 4: `ReviewThreadDto` new shape + parser mapping (TDD)

**Files:**
- Modify: `PRism.Core.Contracts/ReviewThreadDto.cs`
- Modify: `PRism.GitHub/GitHubPrParser.cs:202-246` (`ParseReviewThreads`)
- Modify: `tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs` (`MakeDetail()`)
- Modify: `tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs:79-81` (`Frozen_pr_existing_comments_have_expected_anchors`)
- Create: `tests/PRism.GitHub.Tests/ParseReviewThreadsOutdatedFieldsTests.cs`

**Interfaces:**
- Consumes: the 5-component record from PR A (branch from main after A merges).
- Produces: the spec's final record — later tasks and slice 2 depend on these exact names/types:

```csharp
public sealed record ReviewThreadDto(
    string ThreadId,
    string FilePath,
    int? LineNumber,          // null = outdated or file-level (no 0 sentinel)
    bool IsOutdated,
    int? OriginalLine,
    int? OriginalStartLine,   // multi-line ranges; null for single-line
    string SubjectType,       // "LINE" | "FILE"
    string? DiffHunk,         // first comment's hunk; null if unavailable
    long? ReviewDatabaseId,   // first comment's parent review; timeline join key
    bool IsResolved,
    IReadOnlyList<ReviewCommentDto> Comments);
```

- [ ] **Step 1: Branch from main** (after PR A merges)

```bash
git fetch origin && git switch -c 773-outdated-thread-wire-data origin/main
```

- [ ] **Step 2: Change the record to the shape above** (exact code above; keep `ReviewCommentDto` untouched).

- [ ] **Step 3: Compile-fix the three construction/consumption sites with inert values** (scaffolding so the failing tests can compile — behavior unchanged):

`PRism.GitHub/GitHubPrParser.cs` construction (line mapping still the old `0` fallback for now):

```csharp
            result.Add(new ReviewThreadDto(
                threadId, path, line,
                IsOutdated: false, OriginalLine: null, OriginalStartLine: null, SubjectType: "LINE",
                DiffHunk: null, ReviewDatabaseId: null,
                IsResolved: resolved, Comments: comments));
```
(`line` is still `int` here; it converts to `int?` implicitly.)

`tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs` `MakeDetail()`:

```csharp
                new ReviewThreadDto(
                    ThreadId: KnownThreadId,
                    FilePath: "src/Foo.cs",
                    LineNumber: 10,
                    IsOutdated: false,
                    OriginalLine: 10,
                    OriginalStartLine: null,
                    SubjectType: "LINE",
                    DiffHunk: null,
                    ReviewDatabaseId: null,
                    IsResolved: false,
                    Comments: Array.Empty<ReviewCommentDto>()),
```

`tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs:79-81` — `CommentAnchor(string Path, int Line)` no longer accepts `int?`; anchors are by definition anchored threads:

```csharp
        var actualAnchors = snap!.Detail.ReviewComments
            .Where(t => t.LineNumber is not null)
            .Select(t => new CommentAnchor(t.FilePath, t.LineNumber!.Value))
            .ToHashSet();
```

- [ ] **Step 4: Confirm the tree compiles and existing tests stay green**

```
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: PASS (inert values, no behavior change). Note: `GitHubReviewServicePrDetailTests` line 193 asserts `dto.ReviewComments[0].LineNumber.Should().Be(42)` — FluentAssertions compares `int?` to `42` fine; no edit needed.

- [ ] **Step 5: Write the failing parser tests**

Create `tests/PRism.GitHub.Tests/ParseReviewThreadsOutdatedFieldsTests.cs` (modeled on `ParseReviewThreadsDatabaseIdTests.cs` — synthetic payloads, xunit `Assert`):

```csharp
using System.Text.Json;
namespace PRism.GitHub.Tests;

public class ParseReviewThreadsOutdatedFieldsTests
{
    private static IReadOnlyList<PRism.Core.Contracts.ReviewThreadDto> Parse(string json)
    {
        using var doc = JsonDocument.Parse(json);
        return GitHubPrParser.ParseReviewThreads(doc.RootElement);
    }

    [Fact]
    public void Outdated_thread_maps_null_line_and_anchor_fields()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_1","path":"a.cs","line":null,
          "isOutdated":true,"originalLine":592,"originalStartLine":588,"subjectType":"LINE","isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_1","databaseId":1,
            "author":{"login":"octocat","avatarUrl":null},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null,
            "diffHunk":"@@ -588,9 +588,9 @@ ctx","pullRequestReview":{"databaseId":777}}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Null(t.LineNumber);
        Assert.True(t.IsOutdated);
        Assert.Equal(592, t.OriginalLine);
        Assert.Equal(588, t.OriginalStartLine);
        Assert.Equal("LINE", t.SubjectType);
        Assert.Equal("@@ -588,9 +588,9 @@ ctx", t.DiffHunk);
        Assert.Equal(777L, t.ReviewDatabaseId);
    }

    [Fact]
    public void Anchored_thread_keeps_line_and_projects_first_comment_fields()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_2","path":"b.cs","line":42,
          "isOutdated":false,"originalLine":40,"originalStartLine":null,"subjectType":"LINE","isResolved":true,
          "comments":{"nodes":[
            {"id":"PRRC_2","databaseId":2,"author":{"login":"octocat","avatarUrl":null},
             "createdAt":"2026-01-01T00:00:00Z","body":"first","lastEditedAt":null,
             "diffHunk":"@@ -40,3 +40,3 @@ first-hunk","pullRequestReview":{"databaseId":888}},
            {"id":"PRRC_3","databaseId":3,"author":{"login":"hubot","avatarUrl":null},
             "createdAt":"2026-01-02T00:00:00Z","body":"second","lastEditedAt":null,
             "diffHunk":"@@ -40,3 +40,3 @@ second-hunk","pullRequestReview":{"databaseId":999}}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Equal(42, t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Equal("@@ -40,3 +40,3 @@ first-hunk", t.DiffHunk);   // FIRST comment wins
        Assert.Equal(888L, t.ReviewDatabaseId);                     // FIRST comment wins
    }

    [Fact]
    public void File_level_thread_maps_null_line_and_file_subject()
    {
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_3","path":"c.cs","line":null,
          "isOutdated":false,"originalLine":null,"originalStartLine":null,"subjectType":"FILE","isResolved":false,
          "comments":{"nodes":[]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Null(t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Equal("FILE", t.SubjectType);
        Assert.Null(t.DiffHunk);
        Assert.Null(t.ReviewDatabaseId);
    }

    [Fact]
    public void Pre_capture_payload_without_new_fields_parses_tolerantly()
    {
        // Shape of payloads captured before this change (and of test fakes) — absent
        // fields must default, not throw, so replaying old captures still works.
        const string json = """
        {"reviewThreads":{"nodes":[{"id":"PRRT_4","path":"d.cs","line":3,"isResolved":false,
          "comments":{"nodes":[{"id":"PRRC_4","databaseId":4,
            "author":{"login":"octocat","avatarUrl":null},
            "createdAt":"2026-01-01T00:00:00Z","body":"hi","lastEditedAt":null}]}}]}}
        """;
        var t = Assert.Single(Parse(json));
        Assert.Equal(3, t.LineNumber);
        Assert.False(t.IsOutdated);
        Assert.Null(t.OriginalLine);
        Assert.Null(t.OriginalStartLine);
        Assert.Equal("LINE", t.SubjectType);
        Assert.Null(t.DiffHunk);
        Assert.Null(t.ReviewDatabaseId);
    }
}
```

- [ ] **Step 6: Run them — verify RED for behavioral reasons**

```
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~ParseReviewThreadsOutdatedFields"
```
Expected: FAIL — `Outdated_thread_maps_null_line_and_anchor_fields` fails on `Assert.Null(t.LineNumber)` (parser still coerces to `0`) and `Assert.True(t.IsOutdated)`; the tolerance test PASSES already (inert defaults). Not a compile failure.

- [ ] **Step 7: Implement the parser mapping**

In `ParseReviewThreads` replace the `line` mapping and the construction:

```csharp
            int? line = t.TryGetProperty("line", out var ln) && ln.ValueKind == JsonValueKind.Number ? ln.GetInt32() : null;
            var isOutdated = t.TryGetProperty("isOutdated", out var od) && od.ValueKind == JsonValueKind.True;
            int? originalLine = t.TryGetProperty("originalLine", out var ol) && ol.ValueKind == JsonValueKind.Number ? ol.GetInt32() : null;
            int? originalStartLine = t.TryGetProperty("originalStartLine", out var osl) && osl.ValueKind == JsonValueKind.Number ? osl.GetInt32() : null;
            var subjectType = t.TryGetProperty("subjectType", out var st) && st.ValueKind == JsonValueKind.String ? st.GetString() ?? "LINE" : "LINE";
```

After the existing comments loop (still inside the thread loop), project from the first comment node:

```csharp
            string? diffHunk = null;
            long? reviewDatabaseId = null;
            if (t.TryGetProperty("comments", out var csProj) &&
                csProj.TryGetProperty("nodes", out var cn) &&
                cn.ValueKind == JsonValueKind.Array && cn.GetArrayLength() > 0)
            {
                var firstComment = cn[0];
                if (firstComment.TryGetProperty("diffHunk", out var dh) && dh.ValueKind == JsonValueKind.String)
                    diffHunk = dh.GetString();
                if (firstComment.TryGetProperty("pullRequestReview", out var prr) && prr.ValueKind == JsonValueKind.Object &&
                    prr.TryGetProperty("databaseId", out var rdb) && rdb.ValueKind == JsonValueKind.Number)
                    reviewDatabaseId = rdb.GetInt64();
            }

            result.Add(new ReviewThreadDto(
                threadId, path, line,
                IsOutdated: isOutdated, OriginalLine: originalLine, OriginalStartLine: originalStartLine,
                SubjectType: subjectType, DiffHunk: diffHunk, ReviewDatabaseId: reviewDatabaseId,
                IsResolved: resolved, Comments: comments));
```
(Refactor freely — e.g. reuse the existing `cs`/`cnodes` locals from the comments loop instead of re-fetching — as long as first-comment projection and tolerance hold.)

- [ ] **Step 8: Verify GREEN, then run the full suite**

```
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~ParseReviewThreadsOutdatedFields"
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: targeted PASS; full suite PASS (the `line: null → 0` sentinel had no test pinning it — the fixture-replay coverage arrives in Task 6).

- [ ] **Step 9: Commit**

```bash
git add PRism.Core.Contracts/ReviewThreadDto.cs PRism.GitHub/GitHubPrParser.cs tests/PRism.GitHub.Tests/ParseReviewThreadsOutdatedFieldsTests.cs tests/PRism.Web.Tests/TestHelpers/PrReviewThreadEndpointsTestContext.cs tests/PRism.GitHub.Tests.Integration/FrozenPrismPrTests.cs
git commit -m "feat(#773): map outdated-thread fields and nullable line in ReviewThreadDto"
```

### Task 5: GraphQL query + byte-identity lockstep (TDD)

**Files:**
- Modify: `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs:24-25` (`ExpectedPrDetail`)
- Modify: `PRism.GitHub/GitHubReviewService.cs:53-55` (`PrDetailGraphQLQuery`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the production query fetches `isOutdated originalLine originalStartLine subjectType` (thread level) and `diffHunk pullRequestReview{databaseId}` (comment level). Task 6's live capture depends on this.

The byte-identity test pins the exact query string; changing the expected string FIRST is the failing test.

- [ ] **Step 1: Update `ExpectedPrDetail` in the test** — replace lines 24–25 with:

```csharp
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isOutdated originalLine originalStartLine subjectType isResolved " +
        "comments(first:100){pageInfo{hasNextPage} nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt diffHunk pullRequestReview{databaseId}}}}}" +
```

- [ ] **Step 2: Run — verify RED**

```
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~PrDetailGraphQLQuery_is_byte_identical"
```
Expected: FAIL (expected string ≠ production constant).

- [ ] **Step 3: Update the production constant** — in `GitHubReviewService.cs` replace lines 53–55 with (the `// #604 Part A` comment stays between the two string segments):

```csharp
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isOutdated originalLine originalStartLine subjectType isResolved " +
        // #604 Part A: nested thread comments(first:100) is forward pagination → hasNextPage.
        "comments(first:100){pageInfo{hasNextPage} nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt diffHunk pullRequestReview{databaseId}}}}}" +
```

- [ ] **Step 4: Verify GREEN + full backend suite**

```
dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GraphQlByteIdentityTests"
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: PASS. (`TimelineQuery` shares only `TimelineNodes`, which is untouched.)

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs
git commit -m "feat(#773): fetch outdated-thread fields in the PR-detail GraphQL query"
```

### Task 6: Allowlist, fixture-replay test, fixture regeneration (TDD; live capture)

**Files:**
- Modify: `tests/PRism.GitHub.Tests.Integration/Helpers/FixtureStripAllowlist.cs:33-52`
- Create: `tests/PRism.GitHub.Tests.Integration/FixtureReviewThreadsTests.cs`
- Regenerate: `tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json`

**Interfaces:**
- Consumes: parser from Task 4, query from Task 5 (capture replays the production query).
- Produces: a fixture whose 3 outdated threads carry real `isOutdated`/`originalLine` values, and an **offline** replay test (no `Category=Integration` trait → runs in CI under `.runsettings`, like `GraphQLShapeDiffTests`).

Prereqs for the capture step: local only (never CI), `gh auth login` state or `PRISM_INTEGRATION_PAT` set (the fixture resolves the PAT via `gh auth token` fallback — `GhCliPat.cs`). If you set `PRISM_INTEGRATION_PAT` manually, unset it immediately after the run, same as the capture flag. PR #19 is a locked corpus PR, so thread counts/lines are stable across captures.

- [ ] **Step 1: Add the four scalars to the allowlist**

In `FixtureStripAllowlist.cs` `AllowedFieldNames`, extend two groups (and mirror them in the doc comment's category bullets):

```csharp
        // Enum-valued and boolean structural fields
        "state", "reviewType", "mergeable", "mergeStateStatus", "isDraft", "isResolved",
        "hasNextPage", "isOutdated", "subjectType",
        // Count/numeric structural fields
        "totalCount", "changedFiles", "additions", "deletions", "number", "line",
        "originalLine", "originalStartLine",
```
`diffHunk` and `pullRequestReview` are deliberately **not** added: freeform text and an identity-bearing container respectively — the stripper nulls both, on the fixture and on the live side symmetrically, so the shape diff stays clean while the values never land in the repo.

- [ ] **Step 2: Write the offline fixture-replay test**

Create `tests/PRism.GitHub.Tests.Integration/FixtureReviewThreadsTests.cs`:

```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.GitHub.Tests.Integration.Helpers;

namespace PRism.GitHub.Tests.Integration;

/// <summary>
/// Offline replay of the frozen PR #19 capture through the production parser. No
/// Integration trait — this runs in the default (CI) filter; the fixture ships with
/// the test bin. PR #19 is a locked corpus PR, so its thread population is stable.
/// </summary>
public class FixtureReviewThreadsTests
{
    private static JsonElement LoadPull()
    {
        var path = FixturePathResolver.GetFixturePath("pr19-graphql-response.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.GetProperty("data").GetProperty("repository").GetProperty("pullRequest").Clone();
    }

    [Fact]
    public void Outdated_threads_surface_null_line_isOutdated_and_originalLine()
    {
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Should().HaveCount(6);
        var outdated = threads.Where(t => t.LineNumber is null).ToList();
        outdated.Should().HaveCount(3);
        outdated.Should().OnlyContain(t => t.IsOutdated && t.OriginalLine != null,
            "GitHub returns line:null exactly for outdated LINE-subject threads, with originalLine populated");
    }

    [Fact]
    public void Anchored_threads_keep_their_line_numbers()
    {
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Where(t => t.LineNumber is not null).Select(t => t.LineNumber!.Value)
            .Should().BeEquivalentTo(new[] { 390, 548, 56 });
    }

    [Fact]
    public void Fixture_never_carries_freeform_hunks_or_review_ids()
    {
        // Leak guard for FixtureStripAllowlist edits: diffHunk (freeform code text) and
        // pullRequestReview{databaseId} must stay stripped in the committed capture. The
        // shape-drift test cannot catch an over-broad allowlist — it re-strips the live
        // response with the same allowlist, so a mis-edit is self-consistent there. This
        // assertion is the permanent CI gate.
        var threads = GitHubPrParser.ParseReviewThreads(LoadPull());
        threads.Should().OnlyContain(t => t.DiffHunk == null && t.ReviewDatabaseId == null);
    }
}
```

- [ ] **Step 3: Run — verify RED**

```
dotnet test tests/PRism.GitHub.Tests.Integration --filter "FullyQualifiedName~FixtureReviewThreads"
```
Expected: `Outdated_threads_surface_null_line_isOutdated_and_originalLine` FAILS on `OnlyContain` — the committed fixture predates the query change, so `isOutdated` is absent and defaults to `false`. `Anchored_threads_keep_their_line_numbers` PASSES (line values are already in the old fixture). `Fixture_never_carries_freeform_hunks_or_review_ids` PASSES before and after regeneration — it is the leak guard, not part of the red arc.

- [ ] **Step 4: Regenerate the fixture (capture mode — local, live GitHub)**

PowerShell, repo root:
```powershell
$env:PRISM_FROZEN_PR_CAPTURE_FIXTURE='1'
dotnet test tests/PRism.GitHub.Tests.Integration --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged"
Remove-Item Env:PRISM_FROZEN_PR_CAPTURE_FIXTURE
```
Expected: PASS with stdout `Captured fixture for PR #19 -> …`. **Unset the env var immediately** — never persist it.

- [ ] **Step 5: Sanity-check the regenerated fixture before committing it**

```powershell
python -c "import json,io; d=json.load(io.open(r'tests/PRism.GitHub.Tests.Integration/Fixtures/pr19-graphql-response.json',encoding='utf-8')); ns=d['data']['repository']['pullRequest']['reviewThreads']['nodes']; print(len(ns),[ (t['line'],t['isOutdated'],t['originalLine'],t['subjectType']) for t in ns]); c0=ns[0]['comments']['nodes'][0]; print('diffHunk:',c0['diffHunk'],'pullRequestReview:',c0['pullRequestReview'])"
```
Expected: 6 threads; 3 with `line=None, isOutdated=True, originalLine=<int>`; `subjectType='LINE'` on all; `diffHunk: None` and `pullRequestReview: None` (stripped). If `diffHunk` carries text, the allowlist was edited wrong — stop and fix before committing. Also eyeball `git diff` on the fixture: changes should be confined to the new keys (plus GitHub-side cursor churn at most).

- [ ] **Step 6: Verify GREEN — replay test, then live assert mode, then full suite**

```
dotnet test tests/PRism.GitHub.Tests.Integration --filter "FullyQualifiedName~FixtureReviewThreads"
dotnet test tests/PRism.GitHub.Tests.Integration --filter "FullyQualifiedName~Frozen_pr_graphql_shape_unchanged|FullyQualifiedName~Frozen_pr_existing_comments_have_expected_anchors"
dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: all PASS — the second command runs live: the shape-drift detector in assert mode (fixture ≡ live shape under the new query) plus the rewritten anchors assertion from Task 4, which is Integration-category and would otherwise never execute against real data in this plan.

- [ ] **Step 7: Commit (fixture + allowlist + test together), and add the spec/plan docs to this PR's branch**

```bash
git add tests/PRism.GitHub.Tests.Integration
git commit -m "test(#773): allowlist outdated-thread scalars and re-capture the PR #19 fixture"
git checkout worktree-774-thread-timeline-residency-spec -- docs/specs/2026-07-17-review-threads-timeline-residency-design.md docs/plans/2026-07-17-773-outdated-thread-wire-data.md
git add docs/specs docs/plans
git commit -m "docs(#773): spec and implementation plan for thread-residency slice 1"
```

### Task 7: PR B verify and raise

- [ ] **Step 1: Full pre-push checklist** (steps 1–4; frontend untouched but run anyway — it is cheap insurance and mirrors CI):

```
cd frontend && npm run lint && npm run build && npm test
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
```
Expected: green. No Playwright needed here IF PR C follows immediately (the wire additions are ignored by the current frontend; the shield is documented) — run `cd frontend && npx playwright test` anyway if PR C might lag, then `git checkout -- review-assets/`.

- [ ] **Step 2: Check the file count** — `git diff --stat origin/main` should list ~12 files (9 code/test + fixture + 2 docs). Over 15 → stop and re-split.

- [ ] **Step 3: Push and raise**

```bash
git push -u origin 773-outdated-thread-wire-data
gh pr create --title "feat(#773): wire outdated-thread fields through the PR-detail pipeline" --body-file <body>
```
Body: the wire-shape section documents the compat shield verbatim (frontend readers of `thread.lineNumber` are the `DiffPane` line-keyed join — `null` never matches a row, same invisibility as today's `0` — plus aria strings unreachable for unanchored threads; new JSON keys are ignored until PR C). "Part of #773; frontend consumers + the indicator fix land in the immediate follow-up." Proof section: checklist output, capture/assert-mode results, replay-test red→green.

- [ ] **Step 4: Merge gate** — same envelope check as Task 3. After merge, delete local branch, `git fetch origin`.

---

## PR C — frontend consumers (closes #773)

### Task 8: Indicator counts anchored threads only (TDD)

**Files:**
- Modify: `frontend/src/api/types.ts:327-334` (`ReviewThreadDto`)
- Test: `frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts`
- Modify: `frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts:13,37`

**Interfaces:**
- Consumes: PR B's wire shape.
- Produces: the TS mirror slice 2 (#774) codes against, and `deriveCommentStateByPath` / `deriveCommentCountsByPath` that skip `lineNumber == null` threads:

```ts
export interface ReviewThreadDto {
  threadId: string;
  filePath: string;
  lineNumber: number | null; // null = outdated or file-level (#773)
  isOutdated?: boolean;
  originalLine?: number | null;
  originalStartLine?: number | null;
  subjectType?: 'LINE' | 'FILE';
  diffHunk?: string | null;
  reviewDatabaseId?: number | null;
  isResolved: boolean;
  comments: ReviewCommentDto[];
}
```

The six new fields are optional-with-`?` following the `databaseId?: number | null` precedent (#302) — the backend always sends them, but optional keeps the dozens of existing thread fixtures compiling; slice 2 consumers read them with nullish defaults. `lineNumber` is required `number | null` (a type change, not an addition — existing numeric fixtures stay valid).

- [ ] **Step 1: Branch from main** (after PR B merges): `git fetch origin && git switch -c 773-indicator-anchored-only origin/main`

- [ ] **Step 2: Update `types.ts`** to the interface above (vitest does not typecheck, so tests in the next step run regardless; `npm run build` comes in Task 9).

- [ ] **Step 3: Write the failing tests** — append to `commentIndicatorState.test.ts` (the existing `thread(filePath, isResolved)` factory at the top of the file stays; it already compiles against the new type):

```ts
const outdated = (filePath: string, isResolved: boolean): ReviewThreadDto => ({
  ...thread(filePath, isResolved),
  threadId: `${filePath}:outdated:${isResolved}`,
  lineNumber: null,
  isOutdated: true,
});

describe('unanchored threads are excluded (#773)', () => {
  it('a file with only outdated unresolved threads shows nothing', () => {
    expect(deriveCommentStateByPath([outdated('a.ts', false)]).size).toBe(0);
  });

  it('an outdated open thread cannot upgrade a resolved file to unresolved', () => {
    const m = deriveCommentStateByPath([thread('a.ts', true), outdated('a.ts', false)]);
    expect(m.get('a.ts')).toBe('resolved');
  });

  it('outdated threads are excluded from tooltip counts', () => {
    const m = deriveCommentCountsByPath([thread('a.ts', false), outdated('a.ts', false)]);
    expect(m.get('a.ts')).toEqual({ open: 1, resolved: 0 });
  });

  it('a file with only outdated threads has no count entry at all', () => {
    expect(deriveCommentCountsByPath([outdated('a.ts', true)]).size).toBe(0);
  });
});
```

- [ ] **Step 4: Run — verify RED**

```
cd frontend && npm test -- commentIndicatorState
```
Expected: the four new tests FAIL (unanchored threads are still counted); existing tests PASS.

- [ ] **Step 5: Implement the filter** — first line inside each loop body in `commentIndicatorState.ts`:

```ts
  for (const t of threads) {
    if (t.lineNumber == null) continue; // unanchored (outdated/file-level) — not findable in this file's diff (#773)
```
(one guard in `deriveCommentStateByPath`, one in `deriveCommentCountsByPath`; update the two derivation doc comments to mention the anchored-only rule).

- [ ] **Step 6: Verify GREEN**

```
cd frontend && npm test -- commentIndicatorState
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts
git commit -m "fix(#773): file-tree comment indicator counts anchored threads only"
```
(`fix(#773)` is intentional here — this is the closing PR.)

### Task 9: Type-honesty sweep for nullable `lineNumber` (TDD where behavior changes)

**Files:**
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.tsx:14,64`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx:240`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:317-326`

**Interfaces:**
- Consumes: `lineNumber: number | null` from Task 8.
- Produces: `ThreadDisclosureHeaderProps.lineNumber: number | null`; `threadsByLine: Map<number, ReviewThreadDto[]>` unchanged in type (`diffBodyProps.ts` untouched).

Unanchored threads never reach these components today (the diff join drops them), so the aria-label null branches are defensive; the disclosure-header case still gets a unit test because it is an observable contract of a shared component.

- [ ] **Step 1: Write the failing aria test** — append to `ThreadDisclosureHeader.test.tsx` (uses the existing `props()` factory):

```tsx
  it('omits the line fragment when the thread is unanchored (lineNumber null)', () => {
    render(<ThreadDisclosureHeader {...props({ lineNumber: null })} />);
    expect(screen.getByTestId('thread-disclosure')).toHaveAccessibleName('Expand thread on src/Calc.cs');
  });
```

- [ ] **Step 2: Run — verify RED**

```
cd frontend && npm test -- ThreadDisclosureHeader
```
Expected: FAIL — accessible name is currently `Expand thread on src/Calc.cs line null`.

- [ ] **Step 3: Widen the prop and fix the label** — `ThreadDisclosureHeader.tsx`:

```ts
  lineNumber: number | null;
```
```ts
  const location = lineNumber == null ? filePath : `${filePath} line ${lineNumber}`;
  const ariaLabel = `${collapsed ? 'Expand' : 'Collapse'} thread on ${location}`;
```

- [ ] **Step 4: Same treatment for the reply affordance** — `ExistingCommentWidget.tsx:240`:

```tsx
                  ariaLabel={`Reply to thread on ${thread.filePath}${thread.lineNumber == null ? '' : ` line ${thread.lineNumber}`}`}
```

- [ ] **Step 5: Make the `threadsByLine` null-skip explicit** — `DiffPane.tsx:317-326` (type-driven: the guard narrows `t.lineNumber` to `number`, keeping `Map<number, ReviewThreadDto[]>` sound; behavior is unchanged — a `null` key never matched any diff row — so no new test, the existing DiffPane suite is the net):

```ts
  const threadsByLine = useMemo(() => {
    const map = new Map<number, ReviewThreadDto[]>();
    for (const t of reviewThreads) {
      if (t.filePath !== selectedPath) continue;
      if (t.lineNumber == null) continue; // unanchored — no diff row to attach to (#773)
      const existing = map.get(t.lineNumber);
      if (existing) existing.push(t);
      else map.set(t.lineNumber, [t]);
    }
    return map;
  }, [reviewThreads, selectedPath]);
```

- [ ] **Step 6: Verify GREEN + full frontend gate**

```
cd frontend && npm test -- ThreadDisclosureHeader
npm run lint
npm run build
npm test
```
Expected: all PASS. `npm run build` (`tsc -b`) is the proof that no other `thread.lineNumber` consumer breaks — if it errors elsewhere, that file was missed by the sweep: fix it the same way and note it in the PR.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane
git commit -m "fix(#773): handle nullable thread lineNumber in DiffPane join and thread aria labels"
```

### Task 10: PR C verify, live check, raise (closes #773)

- [ ] **Step 1: Full pre-push checklist including Playwright** (wire-consumer change):

```
cd frontend && npm run lint && npm run build && npm test
cd .. && dotnet build --configuration Release
dotnet test --no-build --configuration Release --settings .runsettings
cd frontend && npx playwright test
```
Expected: green (read the reporter summary line). Then `git checkout -- review-assets/`. Risk noted in the spec: if the Overview/Files parity baseline shifts beyond the 2% tolerance, regenerate the Linux baseline from the CI artifact and commit it into this PR before merge.

- [ ] **Step 2: Live visual verification of the glyph fix** — launch against the real data store (never `-Reset`): `scripts\serve-detached.ps1` on a private port with the real DataDir, open a real PR that has outdated threads (e.g. the BFF corpus PR used previously), and screenshot the file tree before/after context: a file whose only unresolved threads are outdated shows **no** unresolved glyph; a file with an anchored unresolved thread still shows it. Post the before/after screenshots (both themes) on the PR via the `review-assets/pr-N` throwaway-branch pattern.

- [ ] **Step 3: Push and raise**

```bash
git push -u origin 773-indicator-anchored-only
gh pr create --title "fix(#773): stop the file-tree indicator counting unanchored review threads" --body-file <body>
```
Body: "Closes #773", the behavior change (ghost glyph gone), the type mirror, screenshots, proof section. Check `git diff --stat origin/main` ≤ 15 files first.

- [ ] **Step 4: Merge gate** — this PR changes user-visible UI state (indicator behavior); treat it as **gated (B1)** unless the owner has explicitly said otherwise: request owner review rather than self-merging. After merge, #773 auto-closes; verify with `gh issue view 773 --json state`. Clean up local branches; #774 (slice 2) proceeds on its own spec→plan cycle.

---

## Self-review notes (spec-coverage check)

- Spec §Slice-1 GraphQL → Task 5. §DTO → Task 4. §Parser → Task 4. §Indicator → Task 8. §Consumer sweep → PR A (anchorSha fixtures), Task 4 (backend ctor sites + `FrozenPrismPrTests` — a compile-breaking consumer found in plan research, additive to the spec's named sweep), Task 9 (frontend `lineNumber` readers), Task 10 (Playwright smoke). §Testing → Tasks 4 (synthetic parser incl. `diffHunk`/`reviewDatabaseId`), 6 (fixture regen + replay asserting the 3 real outdated threads), 8 (indicator).
- Deviations from the spec, recorded: (1) three PRs instead of one for #773 — PR file cap; (2) `FrozenPrismPrTests.cs` and `GraphQlByteIdentityTests.cs` added to the consumer sweep — found by exhaustive grep during planning; (3) TS mirror uses optional `?` fields for the six additions per the `databaseId` precedent (`lineNumber` stays required `number | null`).
