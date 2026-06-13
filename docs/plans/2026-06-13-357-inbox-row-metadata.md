# Inbox Row Metadata: Commit Count + Files Changed (#357) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the misleading "iter N" inbox label with an honest "N commits" count and add a files-changed glyph+count to the tail metrics cluster — both sourced from data already fetched.

**Architecture:** Two self-contained commits in one PR. Commit 1 is a pure rename+relabel (no new data). Commit 2 adds `ChangedFiles` through the full stack (enricher parse → raw record → contract → orchestrator → frontend type → React render + CSS). Each commit is independently revertible.

**Tech Stack:** C# 13 positional records, System.Text.Json, ASP.NET Core 10, React 19, TypeScript 5, CSS Modules, Vitest, xUnit, Playwright.

---

## File Map

**Modified — Commit 1 (rename only):**
- `PRism.Core/Inbox/RawPrInboxItem.cs` — `IterationNumberApprox` → `CommitCount`
- `PRism.Core.Contracts/PrInboxItem.cs` — `IterationNumber` → `CommitCount`
- `PRism.GitHub/Inbox/GitHubPrEnricher.cs` — with-expression field name
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — `r.IterationNumberApprox` → `r.CommitCount`
- `PRism.Web/TestHooks/FakeSectionQueryRunner.cs` — named arg rename
- `PRism.Web/TestHooks/FakePrDiscovery.cs` — named arg rename
- `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs` — assertion rename
- `frontend/src/api/types.ts` — `iterationNumber` → `commitCount`
- `frontend/src/components/Inbox/InboxRow.tsx` — aria-label + visible render
- 13 frontend fixture files (test + e2e) — `iterationNumber:` → `commitCount:`

**Modified — Commit 2 (new field):**
- `PRism.GitHub/Inbox/GitHubPrEnricher.cs` — parse `changed_files` + pass to with
- `PRism.Core/Inbox/RawPrInboxItem.cs` — add `int ChangedFiles` at position 12
- `PRism.Core.Contracts/PrInboxItem.cs` — add `int ChangedFiles` at position 8
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — pass `r.ChangedFiles`
- `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs` — add `0` placeholder
- `PRism.Web/TestHooks/FakeSectionQueryRunner.cs` — add `ChangedFiles: 0`
- `PRism.Web/TestHooks/FakePrDiscovery.cs` — add `ChangedFiles: 0`
- 5 `RawPrInboxItem` positional call sites in tests (add `0` at position 12)
- 4 `PrInboxItem` positional call sites in tests (add `0` at position 8)
- `frontend/src/api/types.ts` — add `changedFiles: number`
- `frontend/src/components/Inbox/InboxRow.tsx` — add `.filesSlot` render
- `frontend/src/components/Inbox/InboxRow.module.css` — `.filesSlot` styles + `--inbox-tail-w`
- 13 frontend fixture files — add `changedFiles: 0`

---

## Task 0: Create worktree

**Files:** none (git operation)

- [ ] **Step 1: Create the feature worktree**

```bash
git worktree add ../PRism-357-inbox-metadata -b feature/357-inbox-row-metadata
```

Expected: `Preparing worktree (new branch 'feature/357-inbox-row-metadata')` — no errors.

- [ ] **Step 2: Verify worktree is on the new branch**

```bash
git -C ../PRism-357-inbox-metadata branch --show-current
```

Expected output: `feature/357-inbox-row-metadata`

---

## Task 1: Rename `IterationNumberApprox`/`IterationNumber` → `CommitCount` in backend records

**Files:**
- Modify: `PRism.Core/Inbox/RawPrInboxItem.cs`
- Modify: `PRism.Core.Contracts/PrInboxItem.cs`

- [ ] **Step 1: Read both record files to confirm current parameter names**

Read `PRism.Core/Inbox/RawPrInboxItem.cs` and `PRism.Core.Contracts/PrInboxItem.cs`.

- [ ] **Step 2: Rename in `RawPrInboxItem.cs`**

Find the parameter `int IterationNumberApprox` and rename it to `int CommitCount`. The declaration order stays the same — it sits between `HeadSha` and `MergedAt?`.

- [ ] **Step 3: Rename in `PrInboxItem.cs`**

Find the parameter `int IterationNumber` and rename it to `int CommitCount`. It sits between `PushedAt` and `CommentCount`.

- [ ] **Step 4: Verify no remaining references to old names in these two files**

```bash
grep -n "IterationNumber" PRism.Core/Inbox/RawPrInboxItem.cs PRism.Core.Contracts/PrInboxItem.cs
```

Expected: no output.

---

## Task 2: Update all backend call sites — rename to `CommitCount`

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Modify: `PRism.Web/TestHooks/FakeSectionQueryRunner.cs`
- Modify: `PRism.Web/TestHooks/FakePrDiscovery.cs`
- Modify: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`

- [ ] **Step 1: Enumerate all remaining `IterationNumber` references in the repo**

```bash
grep -rn "IterationNumber" --include="*.cs" .
```

Every line in the output is a call site that needs updating. Fix each one.

- [ ] **Step 2: Update `GitHubPrEnricher.cs`**

In the `raw with { … }` expression, change `IterationNumberApprox = commits` to `CommitCount = commits`.

- [ ] **Step 3: Update `InboxRefreshOrchestrator.cs`**

Find the call to `new PrInboxItem(…)` (around line 296–302). Change `r.IterationNumberApprox` to `r.CommitCount`.

- [ ] **Step 4: Update `FakeSectionQueryRunner.cs`**

Change the named arg `IterationNumberApprox: _store.Iterations.Count` to `CommitCount: _store.Iterations.Count`.

- [ ] **Step 5: Update `FakePrDiscovery.cs`**

Change the named arg `IterationNumber: _store.Iterations.Count` to `CommitCount: _store.Iterations.Count`.

- [ ] **Step 6: Update `GitHubPrEnricherTests.cs`**

Change the assertion `.IterationNumberApprox.Should().Be(3)` to `.CommitCount.Should().Be(3)`.

- [ ] **Step 7: Verify no remaining `IterationNumber` references in C#**

```bash
grep -rn "IterationNumber" --include="*.cs" .
```

Expected: no output.

---

## Task 3: Update frontend type + `InboxRow.tsx` render (commit 1)

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`

- [ ] **Step 1: Read the files to see current structure**

Read `frontend/src/api/types.ts` around line 114 and `frontend/src/components/Inbox/InboxRow.tsx` around lines 87–88 and 148.

- [ ] **Step 2: Rename in `types.ts`**

Change `iterationNumber: number` to `commitCount: number` in the `PrInboxItem` interface.

- [ ] **Step 3: Update aria-label in `InboxRow.tsx`**

Find the aria-label that includes `iteration ${pr.iterationNumber}` (around lines 87–88). Replace with:

```tsx
`${pr.commitCount} commit${pr.commitCount === 1 ? '' : 's'}`
```

- [ ] **Step 4: Update visible render in `InboxRow.tsx`**

Find the visible render `iter {pr.iterationNumber}` (around line 148). Replace with:

```tsx
{pr.commitCount} {pr.commitCount === 1 ? 'commit' : 'commits'}
```

- [ ] **Step 5: Verify no remaining `iterationNumber` references in frontend source (non-test)**

```bash
grep -rn "iterationNumber" frontend/src --include="*.ts" --include="*.tsx" --exclude-dir=__tests__ --exclude="*.test.*"
```

Expected: no output (test files are updated in the next task).

---

## Task 4: Update all 13 frontend fixture files — `iterationNumber` → `commitCount`

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.test.tsx`
- Modify: `frontend/src/components/Inbox/InboxSection.test.tsx`
- Modify: `frontend/src/components/Inbox/InboxSection.grouping.test.tsx`
- Modify: `frontend/src/components/Inbox/RepoGroupAccordion.test.tsx`
- Modify: `frontend/src/components/Inbox/groupByRepo.test.ts`
- Modify: `frontend/src/components/Inbox/filters/useInboxFilters.test.ts`
- Modify: `frontend/src/components/Inbox/filters/applyInboxFilters.test.ts`
- Modify: `frontend/src/components/Inbox/filters/FilterBar.test.tsx`
- Modify: `frontend/src/pages/InboxPage.test.tsx`
- Modify: `frontend/e2e/inbox.spec.ts`
- Modify: `frontend/e2e/inbox-filter.spec.ts`
- Modify: `frontend/e2e/a11y-audit.spec.ts`
- Modify: `frontend/e2e/ai-gating-sweep.spec.ts`

- [ ] **Step 1: Find every `iterationNumber` occurrence across all fixture files**

```bash
grep -rn "iterationNumber" frontend/src frontend/e2e --include="*.ts" --include="*.tsx"
```

Each line is a replacement needed.

- [ ] **Step 2: Replace `iterationNumber:` with `commitCount:` in every fixture**

For each file found above, rename the property. The value (typically `1` or `0`) does not change. Example — before:

```ts
iterationNumber: 1,
```

After:

```ts
commitCount: 1,
```

- [ ] **Step 3: Verify no remaining `iterationNumber` references in frontend**

```bash
grep -rn "iterationNumber" frontend/src frontend/e2e --include="*.ts" --include="*.tsx"
```

Expected: no output.

---

## Task 5: Build and run tests — commit 1 verification

**Files:** none (verification only)

- [ ] **Step 1: Build the backend (from worktree root)**

Run from `../PRism-357-inbox-metadata`:

```
dotnet build PRism.sln
```

Expected: `Build succeeded. 0 Error(s)`. If any error mentions `IterationNumber`, go back and fix the missed reference.

- [ ] **Step 2: Run backend tests**

```
dotnet test PRism.sln --no-build
```

Expected: all tests pass. If a test mentions `IterationNumber`/`IterationNumberApprox`, fix it.

- [ ] **Step 3: Run frontend type-check**

```
cd frontend && npx tsc -b --noEmit
```

Expected: no errors. Any `iterationNumber` type error points to a missed fixture rename.

- [ ] **Step 4: Run frontend unit tests**

```
cd frontend && npm test -- --run
```

Expected: all tests pass.

---

## Task 6: Commit 1 — rename + relabel

**Files:** all files modified in Tasks 1–4

- [ ] **Step 1: Stage all modified files**

```bash
git -C ../PRism-357-inbox-metadata add \
  PRism.Core/Inbox/RawPrInboxItem.cs \
  PRism.Core.Contracts/PrInboxItem.cs \
  PRism.GitHub/Inbox/GitHubPrEnricher.cs \
  PRism.Core/Inbox/InboxRefreshOrchestrator.cs \
  PRism.Web/TestHooks/FakeSectionQueryRunner.cs \
  PRism.Web/TestHooks/FakePrDiscovery.cs \
  tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs \
  frontend/src/api/types.ts \
  frontend/src/components/Inbox/InboxRow.tsx \
  frontend/src/components/Inbox/InboxRow.test.tsx \
  frontend/src/components/Inbox/InboxSection.test.tsx \
  frontend/src/components/Inbox/InboxSection.grouping.test.tsx \
  frontend/src/components/Inbox/RepoGroupAccordion.test.tsx \
  frontend/src/components/Inbox/groupByRepo.test.ts \
  frontend/src/components/Inbox/filters/useInboxFilters.test.ts \
  frontend/src/components/Inbox/filters/applyInboxFilters.test.ts \
  frontend/src/components/Inbox/filters/FilterBar.test.tsx \
  frontend/src/pages/InboxPage.test.tsx \
  frontend/e2e/inbox.spec.ts \
  frontend/e2e/inbox-filter.spec.ts \
  frontend/e2e/a11y-audit.spec.ts \
  frontend/e2e/ai-gating-sweep.spec.ts
```

- [ ] **Step 2: Verify no secrets or unintended files are staged**

```bash
git -C ../PRism-357-inbox-metadata diff --cached --name-only
```

Only the files listed above should appear. Inspect any unexpected file.

- [ ] **Step 3: Commit**

```bash
git -C ../PRism-357-inbox-metadata commit -m "$(cat <<'EOF'
fix(inbox): relabel iter→commit count, rename IterationNumber→CommitCount (#357)

Raw GitHub commit count was never an iteration count — the clustering
only runs in the PR-detail view. Rename the field throughout the stack
for honesty and display "N commits" (singular-aware) instead of
"iter N".

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add `int ChangedFiles` to `RawPrInboxItem` — parse in enricher

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Modify: `PRism.Core/Inbox/RawPrInboxItem.cs`

- [ ] **Step 1: Read `GitHubPrEnricher.cs` to find the diff-stat parsing block**

Look for the lines that read `additions`, `deletions`, and `commits` from `doc.RootElement`.

- [ ] **Step 2: Write a failing test for `ChangedFiles` parsing — RED**

In `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`:

Add `"changed_files": 7` to the `PullsResponse` const (alongside `"additions": 5` etc):

```json
{
  "head": {
    "sha": "abc123",
    "repo": { "pushed_at": "2026-05-06T09:50:00Z" }
  },
  "additions": 5,
  "deletions": 2,
  "commits": 3,
  "changed_files": 7,
  "updated_at": "2026-05-06T10:00:00Z"
}
```

In the existing `Adds_head_sha_and_diff_stats` test, add after the existing assertions:

```csharp
item.ChangedFiles.Should().Be(7);
```

- [ ] **Step 3: Run the test — confirm RED**

```
dotnet test tests/PRism.GitHub.Tests --filter "Adds_head_sha_and_diff_stats"
```

Expected: compile error (field `ChangedFiles` doesn't exist yet) or test failure.

- [ ] **Step 4: Add `int ChangedFiles` to `RawPrInboxItem.cs`**

Insert `int ChangedFiles` at position 12 (after `int CommitCount`, before `DateTimeOffset? MergedAt = null`):

```csharp
public sealed record RawPrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    int CommitCount,
    int ChangedFiles,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
```

- [ ] **Step 5: Parse `changed_files` in `GitHubPrEnricher.cs`**

Alongside the existing `commits`/`additions`/`deletions` reads, add:

```csharp
var changedFiles = doc.RootElement.TryGetProperty("changed_files", out var cf) ? cf.GetInt32() : 0;
```

Then in the `raw with { … }` expression, add `ChangedFiles = changedFiles,` after `CommitCount = commits,`:

```csharp
return raw with
{
    HeadSha = head,
    Additions = additions,
    Deletions = deletions,
    CommitCount = commits,
    ChangedFiles = changedFiles,
    PushedAt = pushedAt,
    MergedAt = mergedAt,
    ClosedAt = closedAt,
};
```

- [ ] **Step 6: Run the test — confirm GREEN**

```
dotnet test tests/PRism.GitHub.Tests --filter "Adds_head_sha_and_diff_stats"
```

Expected: PASS.

---

## Task 8: Fix all `RawPrInboxItem` positional call sites — add `ChangedFiles: 0` placeholder

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`
- Modify: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs` (Raw helper + Preserves_avatar_url)
- Modify: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`
- Modify: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`
- Modify: `tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs`
- Modify: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`

- [ ] **Step 1: Enumerate all `RawPrInboxItem` construction sites**

```bash
grep -rn "new RawPrInboxItem(" --include="*.cs" .
```

Every call site that passes 11+ positional required args will fail to compile after the new required `int ChangedFiles` was added.

- [ ] **Step 2: Update `GitHubSectionQueryRunner.cs` (~line 139–147)**

Add `0,    // ChangedFiles` after the `1,    // CommitCount` line:

```csharp
result.Add(new RawPrInboxItem(
    new PrReference(path[0], path[1], n),
    title, login, repo,
    updated, updated,
    comments, 0, 0, "",
    1,           // CommitCount
    0,           // ChangedFiles (not in Search API; enricher fills it)
    AvatarUrl: avatarUrl));
```

- [ ] **Step 3: Update `GitHubPrEnricherTests.cs` — `Raw()` helper (lines 19–23)**

Add `0` as the 12th positional argument (after `1` for CommitCount):

```csharp
return new RawPrInboxItem(
    new PrReference(parts[0], parts[1], n),
    $"PR #{n}", "author", repo,
    ts, ts,
    0, 0, 0, "", 1, 0);
```

- [ ] **Step 4: Update `GitHubPrEnricherTests.cs` — `Preserves_avatar_url_through_enrichment` test (~line 245–250)**

The explicit construction has `0, 0, 0, "", 1` followed by `AvatarUrl:` named arg. Insert `0` before `AvatarUrl:`:

```csharp
var raw = new RawPrInboxItem(
    new PrReference("acme", "api", 1),
    "PR #1", "author", "acme/api",
    DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
    0, 0, 0, "", 1, 0,
    AvatarUrl: "https://avatars.githubusercontent.com/u/1?v=4");
```

- [ ] **Step 5: Update `GitHubCiFailingDetectorTests.cs` — `Raw()` helper (~lines 18–23)**

Read the file. Find the `Raw()` helper's `new RawPrInboxItem(…)` call. Add `0` after the CommitCount arg (the last required positional before optional params).

- [ ] **Step 6: Update `GitHubAwaitingAuthorFilterTests.cs` — `Raw()` helper (~lines 29–33)**

Same pattern — add `0` for ChangedFiles.

- [ ] **Step 7: Update `RawPrInboxItemTests.cs` — all constructions (~lines 12–14, 24–27)**

Read the file. For each `new RawPrInboxItem(…)` call, add `0` at position 12.

- [ ] **Step 8: Update `InboxRefreshOrchestratorTests.cs` — `RawPr`/`RawClosed`/`RawClosedRepo` helpers (~lines 26, 30, 42)**

Read the file. Each helper that constructs `RawPrInboxItem` positionally needs `0` added at position 12. Example:

Before: `... 0, 0, 0, "", 1)`  
After: `... 0, 0, 0, "", 1, 0)`

- [ ] **Step 9: Build to verify no remaining `RawPrInboxItem` compile errors**

```
dotnet build PRism.sln
```

Any remaining errors point to missed call sites.

---

## Task 9: Add `int ChangedFiles` to `PrInboxItem` and wire through orchestrator + fakes

**Files:**
- Modify: `PRism.Core.Contracts/PrInboxItem.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`
- Modify: `PRism.Web/TestHooks/FakeSectionQueryRunner.cs`
- Modify: `PRism.Web/TestHooks/FakePrDiscovery.cs`

- [ ] **Step 1: Add `int ChangedFiles` to `PrInboxItem.cs`**

Insert `int ChangedFiles` at position 8 (after `int CommitCount`, before `int CommentCount`):

```csharp
public sealed record PrInboxItem(
    PrReference Reference,
    string Title,
    string Author,
    string Repo,
    DateTimeOffset UpdatedAt,
    DateTimeOffset PushedAt,
    int CommitCount,
    int ChangedFiles,
    int CommentCount,
    int Additions,
    int Deletions,
    string HeadSha,
    CiStatus Ci,
    string? LastViewedHeadSha,
    long? LastSeenCommentId,
    DateTimeOffset? MergedAt = null,
    DateTimeOffset? ClosedAt = null,
    string? AvatarUrl = null);
```

- [ ] **Step 2: Update `InboxRefreshOrchestrator.cs` — pass `r.ChangedFiles`**

In the `new PrInboxItem(…)` construction, add `r.ChangedFiles` after `r.CommitCount` and use named args for all fields to prevent future silent-shift bugs:

```csharp
return new PrInboxItem(
    Reference: r.Reference,
    Title: r.Title,
    Author: r.Author,
    Repo: r.Repo,
    UpdatedAt: r.UpdatedAt,
    PushedAt: r.PushedAt,
    CommitCount: r.CommitCount,
    ChangedFiles: r.ChangedFiles,
    CommentCount: r.CommentCount,
    Additions: r.Additions,
    Deletions: r.Deletions,
    HeadSha: r.HeadSha,
    Ci: ci,
    LastViewedHeadSha: lastViewedHeadSha,
    LastSeenCommentId: lastSeenCommentId,
    MergedAt: r.MergedAt,
    ClosedAt: r.ClosedAt,
    AvatarUrl: r.AvatarUrl);
```

- [ ] **Step 3: Update `FakeSectionQueryRunner.cs`**

Add `ChangedFiles: 0,` after `CommitCount: _store.Iterations.Count,`.

- [ ] **Step 4: Update `FakePrDiscovery.cs`**

Add `ChangedFiles: 0,` after `CommitCount: _store.Iterations.Count,`.

---

## Task 10: Fix all `PrInboxItem` positional call sites — add `0` for `ChangedFiles`

**Files:**
- Modify: `tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs`
- Modify: `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs`
- Modify: `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs`

- [ ] **Step 1: Enumerate all `PrInboxItem` construction sites**

```bash
grep -rn "new PrInboxItem(" --include="*.cs" .
```

Every positional call site with 8+ args will fail after the new required `int ChangedFiles` was inserted at position 8.

- [ ] **Step 2: Update `InboxDeduplicatorTests.cs` (~lines 12–16, 57–58)**

Read the file. For each `new PrInboxItem(…)`, insert `0` after the `CommitCount` arg (first `1` in the numeric run) and before `CommentCount`. Use named args or a comment to mark the position.

Example — before:
```csharp
new PrInboxItem(ref, title, author, repo, updatedAt, pushedAt,
    1, 0, 0, 0, $"sha{n}", CiStatus.None, null, null)
```
After:
```csharp
new PrInboxItem(ref, title, author, repo, updatedAt, pushedAt,
    1, 0, 0, 0, 0, $"sha{n}", CiStatus.None, null, null)
//  ^CommitCount ^ChangedFiles ^CommentCount
```

- [ ] **Step 3: Update `NoopSeamTests.cs` (~lines 76–79)**

Same pattern. Before:
```csharp
1, 0, 0, 0, "abc", CiStatus.None, null, null
```
After:
```csharp
1, 0, 0, 0, 0, "abc", CiStatus.None, null, null
```

- [ ] **Step 4: Update `InboxEndpointsTests.cs` (~lines 263–267)**

Read the file. Before (positions 7–12 = CommitCount, CommentCount, Additions, Deletions, HeadSha, Ci):
```csharp
1, 0, 1, 0, "HEAD", CiStatus.None
```
After (insert `0` for ChangedFiles at position 8, pushing CommentCount to 9):
```csharp
1, 0, 0, 1, 0, "HEAD", CiStatus.None
// CommitCount=1, ChangedFiles=0, CommentCount=0, Additions=1, Deletions=0
```

- [ ] **Step 5: Build to verify no remaining `PrInboxItem` compile errors**

```
dotnet build PRism.sln
```

Expected: `Build succeeded. 0 Error(s)`.

---

## Task 11: Run backend tests — commit 2 backend verification

- [ ] **Step 1: Run all backend tests**

```
dotnet test PRism.sln --no-build
```

Expected: all tests pass. Fix any failures before proceeding.

---

## Task 12: Add `changedFiles` to frontend type + TDD `filesSlot` in `InboxRow` — RED

**Files:**
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Add `changedFiles: number` to `types.ts`**

In the `PrInboxItem` interface, add `changedFiles: number;` after `commitCount: number`.

- [ ] **Step 2: Write a failing test for the files slot in `InboxRow.test.tsx`**

Read the existing test file to understand the fixture pattern. The PR fixture probably looks like:

```ts
const PR: PrInboxItem = {
  // ... existing fields
  commitCount: 1,
  changedFiles: 0,   // you already added this in Task 4
  // ...
};
```

Add a new test (or augment an existing render test) that sets `changedFiles: 5` and asserts the count appears. Since the slot is `aria-hidden` for the SVG but the count is plain text, query by the number:

```tsx
it('renders changed-files count in the tail metrics', () => {
  const pr = { ...makePr(), changedFiles: 5 };
  render(<InboxRow pr={pr} ... />);
  expect(screen.getByText('5')).toBeInTheDocument();
});

it('hides files slot when changedFiles is 0', () => {
  const pr = { ...makePr(), changedFiles: 0 };
  render(<InboxRow pr={pr} ... />);
  // The count "0" must not appear in the tail
  expect(screen.queryByTestId('files-slot')).not.toHaveTextContent('0');
});
```

Adjust the test to match the existing fixture helpers in the file (`makePr()`, inline objects, etc.).

- [ ] **Step 3: Run the new tests — confirm RED**

```
cd frontend && ./node_modules/.bin/vitest run src/components/Inbox/InboxRow.test.tsx
```

Expected: FAIL — element not found.

---

## Task 13: Implement `filesSlot` in `InboxRow.tsx` + CSS — GREEN

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`

- [ ] **Step 1: Read `InboxRow.tsx` to find the metrics cluster and `.commentSlot` region**

Locate the `.metrics` container and the existing `.commentSlot` / `.comments` span structure.

- [ ] **Step 2: Add `.filesSlot` after `.commentSlot` in `InboxRow.tsx`**

```tsx
<span className={styles.filesSlot}>
  {pr.changedFiles > 0 && (
    <span className={styles.files}>
      <svg
        className={styles.fileIcon}
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="currentColor"
        aria-hidden="true"
      >
        {/* Octicon file-16 */}
        <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
      </svg>
      {pr.changedFiles}
    </span>
  )}
</span>
```

- [ ] **Step 3: Read `InboxRow.module.css` to find `--inbox-tail-w` and `.commentSlot`/`.comments` styles**

Note the current `--inbox-tail-w` value (likely on `.row`) and the `.commentSlot` / `.comments` rules to mirror.

- [ ] **Step 4: Add `.filesSlot` and `.files` CSS rules**

Mirror `.commentSlot`/`.comments` exactly, then add `.fileIcon` color:

```css
.filesSlot {
  flex: none;
  width: 52px;
  display: flex;
  justify-content: flex-end;
}

.files {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  color: var(--text-3);
}

.fileIcon {
  flex: none;
  color: var(--accent);
}

.row:hover .files {
  background: var(--row-hover-pill);
}
```

- [ ] **Step 5: Widen `--inbox-tail-w`**

Find the CSS comment in `.row` that documents the tail slot widths and running total. Update it and the `--inbox-tail-w` value to include the new 52px filesSlot + 12px gap (+64px total). Example:

Before (hypothetical):
```css
/* tail: 64 diff + 72 counts + 52 comments + 2×12 gap = 212 */
--inbox-tail-w: 224px;
```

After:
```css
/* tail: 64 diff + 72 counts + 52 comments + 52 files + 3×12 gap = 276 */
--inbox-tail-w: 288px;
```

If there is a narrow-breakpoint override (`@container inbox-sections (max-width: 560px)`), update that value too by the same +64px.

**Important:** Read the actual current values from the file before editing. The numbers in the example above are derived from the spec but the file is the source of truth for the exact current value.

- [ ] **Step 6: Run the new tests — confirm GREEN**

```
cd frontend && ./node_modules/.bin/vitest run src/components/Inbox/InboxRow.test.tsx
```

Expected: all tests PASS.

---

## Task 14: Update all 13 frontend fixture files — add `changedFiles: 0`

**Files:** same 13 files as Task 4

- [ ] **Step 1: Find fixture files that are now missing `changedFiles`**

```bash
cd frontend && npx tsc -b --noEmit 2>&1 | grep "changedFiles"
```

Every type error points to a file that needs `changedFiles: 0` added. Alternatively, grep for all `PrInboxItem`-shaped fixture objects:

```bash
grep -rn "commitCount:" frontend/src frontend/e2e --include="*.ts" --include="*.tsx"
```

Each hit is a fixture that also needs `changedFiles: 0` added.

- [ ] **Step 2: Add `changedFiles: 0` to each fixture that is missing it**

For each file found, add `changedFiles: 0,` immediately after `commitCount: N,`. Example:

```ts
commitCount: 1,
changedFiles: 0,
```

For the `InboxRow.test.tsx` fixture that tests the files slot (Task 12), use the non-zero value you already set (`changedFiles: 5`).

- [ ] **Step 3: Verify no remaining type errors**

```
cd frontend && npx tsc -b --noEmit
```

Expected: no output (0 errors).

---

## Task 15: Run all frontend tests — commit 2 frontend verification

- [ ] **Step 1: Run all frontend unit tests**

```
cd frontend && npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 2: Run frontend type-check one more time**

```
cd frontend && npx tsc -b --noEmit
```

Expected: clean.

---

## Task 16: Commit 2 — `ChangedFiles` field + tail render

**Files:** all files modified in Tasks 7–15 (not already in commit 1)

- [ ] **Step 1: Stage all new/modified files for commit 2**

```bash
git -C ../PRism-357-inbox-metadata add \
  PRism.Core/Inbox/RawPrInboxItem.cs \
  PRism.Core.Contracts/PrInboxItem.cs \
  PRism.GitHub/Inbox/GitHubPrEnricher.cs \
  PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs \
  PRism.Core/Inbox/InboxRefreshOrchestrator.cs \
  PRism.Web/TestHooks/FakeSectionQueryRunner.cs \
  PRism.Web/TestHooks/FakePrDiscovery.cs \
  tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs \
  tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs \
  tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs \
  tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs \
  tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs \
  tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs \
  tests/PRism.Core.Tests/Ai/NoopSeamTests.cs \
  tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs \
  frontend/src/api/types.ts \
  frontend/src/components/Inbox/InboxRow.tsx \
  frontend/src/components/Inbox/InboxRow.module.css \
  frontend/src/components/Inbox/InboxRow.test.tsx \
  frontend/src/components/Inbox/InboxSection.test.tsx \
  frontend/src/components/Inbox/InboxSection.grouping.test.tsx \
  frontend/src/components/Inbox/RepoGroupAccordion.test.tsx \
  frontend/src/components/Inbox/groupByRepo.test.ts \
  frontend/src/components/Inbox/filters/useInboxFilters.test.ts \
  frontend/src/components/Inbox/filters/applyInboxFilters.test.ts \
  frontend/src/components/Inbox/filters/FilterBar.test.tsx \
  frontend/src/pages/InboxPage.test.tsx \
  frontend/e2e/inbox.spec.ts \
  frontend/e2e/inbox-filter.spec.ts \
  frontend/e2e/a11y-audit.spec.ts \
  frontend/e2e/ai-gating-sweep.spec.ts
```

- [ ] **Step 2: Verify no secrets or unintended files staged**

```bash
git -C ../PRism-357-inbox-metadata diff --cached --name-only
```

- [ ] **Step 3: Commit**

```bash
git -C ../PRism-357-inbox-metadata commit -m "$(cat <<'EOF'
feat(inbox): add files-changed count to tail metrics cluster (#357)

Parse changed_files from the pulls/{n} response (already fetched) and
surface it as a file glyph + count in the inbox row tail. Hidden when
zero — graceful degradation for any PR where the field is absent.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 17: Pre-push checklist

**Files:** none (verification)

- [ ] **Step 1: Run the full backend test suite one final time**

```
dotnet test PRism.sln
```

Expected: all tests pass.

- [ ] **Step 2: Run the full frontend test suite one final time**

```
cd frontend && npm test -- --run
```

Expected: all tests pass.

- [ ] **Step 3: Run the repo pre-push checklist verbatim**

Read `.ai/docs/development-process.md` for the pre-push checklist and run every item in it. Do not skip any step.

- [ ] **Step 4: Verify the worktree branch has both commits**

```bash
git -C ../PRism-357-inbox-metadata log --oneline -5
```

Expected: two new commits at the top — the commit-2 `feat(inbox):` then the commit-1 `fix(inbox):` — followed by main HEAD.

---

## Task 18: Open PR via pr-autopilot

**Files:** none (GitHub operation)

- [ ] **Step 1: Invoke `pr-autopilot` skill**

Use the `superpowers:pr-autopilot` skill to open the PR, run the bot-feedback loop, and monitor CI.

PR should target `main`. B1 gate applies: pause for human visual assert after CI is green and all bots have been addressed.

---

## Self-Review

**Spec coverage:**
- [x] `iter N` → `N commits` (singular-aware): Tasks 1–4
- [x] aria-label updated: Task 3
- [x] `changedFiles === 0` renders no file slot: Task 13 (conditional render)
- [x] `ChangedFiles` field through full stack: Tasks 7–10
- [x] No new GitHub API call: enricher reads existing `pulls/{n}` response
- [x] PR-detail clustered iteration count untouched: nothing in Tasks 1–16 touches PR-detail
- [x] `--inbox-tail-w` widened: Task 13 Step 5
- [x] Positional blast-radius call sites (RawPrInboxItem): Task 8 — 6 files
- [x] Positional blast-radius call sites (PrInboxItem): Task 10 — 3 files
- [x] 13 frontend fixture files: Tasks 4 + 14
- [x] Visual baselines: regen'd from CI artifact after PR is green (B1 gate)

**No placeholders or TBDs found.**
