# Inbox group-by-repo + repo-centric Recently-closed — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Group Inbox PRs by repository as nested accordions within every section, and reframe Recently-closed to be repo-centric (top-N repos, not N PRs) with a config-backed window.

**Architecture:** Grouping is a pure frontend fold over the existing flat `PrInboxItem[]` — the `/api/inbox` wire contract, snapshot, diff, and SSE are unchanged. The only backend change is to recently-closed: a recency-sorted search, a repo cap replacing the PR cap, and the history window moved into `InboxConfig`. See `docs/specs/2026-06-06-inbox-group-by-repo-design.md`.

**Tech Stack:** Backend .NET 10 (xUnit, FluentAssertions, Moq); Frontend React + Vite + TypeScript (vitest + React Testing Library). CSS Modules.

**Branch / worktree:** `feat/133-inbox-group-by-repo` at `D:/src/PRism-wt/133-inbox-group-by-repo`.

---

## File Structure

**Backend (modify):**
- `PRism.Core/Config/AppConfig.cs` — add `RecentlyClosedWindowDays` to `InboxConfig`.
- `PRism.Core/Inbox/InboxHistoryConstants.cs` — replace `MaxHistoryRows`/`HistoryWindowDays` with `MaxHistoryRepos`.
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — read window from config; repo-cap materialization block.
- `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs` — recency-sort the closed-history search.

**Backend (tests):**
- `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs` — window backward-compat.
- `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` — window-from-config, repo-cap, tiebreaker, dropped-enrichment.
- `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs` — sort param on closed search.

**Frontend (create):**
- `frontend/src/components/Inbox/groupByRepo.ts` (+ `groupByRepo.test.ts`)
- `frontend/src/components/Inbox/RepoGroupAccordion.tsx` + `.module.css` (+ `RepoGroupAccordion.test.tsx`)

**Frontend (modify):**
- `frontend/src/components/Inbox/InboxRow.tsx` — `showRepo` prop.
- `frontend/src/components/Inbox/RecentlyClosedFooter.tsx` + `.module.css` — unconditional caption, no props.
- `frontend/src/components/Inbox/InboxSection.tsx` — grouping + flatten + unconditional footer; remove the local `MaxHistoryRows`.
- Tests: `InboxRow.test.tsx`, `InboxSection.test.tsx`, `InboxPage.test.tsx` as needed.

---

## Task 1: Config — `RecentlyClosedWindowDays` on `InboxConfig`

**Files:**
- Modify: `PRism.Core/Config/AppConfig.cs:18-20,37-40`
- Test: `tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs`

- [ ] **Step 1: Write the failing test** (mirrors the existing `…WithoutDensity_DefaultsToComfortable` precedent). Append to `ConfigStorePatchAsyncDottedPathTests.cs` inside the class:

```csharp
[Fact]
public void LegacyConfig_WithoutRecentlyClosedWindowDays_DefaultsTo14()
{
    // Old-shape inbox config: kebab-case, no recently-closed-window-days key.
    const string json = """
    {
      "inbox": {
        "deduplicate": true,
        "sections": { "review-requested": true },
        "show-hidden-scope-footer": true
      }
    }
    """;
    var options = JsonSerializerOptionsFactory.Storage;
    var cfg = JsonSerializer.Deserialize<AppConfig>(json, options);
    cfg!.Inbox.RecentlyClosedWindowDays.Should().Be(14);
}
```

If `JsonSerializerOptionsFactory` / `JsonSerializer` aren't already imported in this file, add `using System.Text.Json;` and the factory's namespace (match the other tests in the file — they already deserialize `AppConfig`).

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~LegacyConfig_WithoutRecentlyClosedWindowDays"`
Expected: FAIL — `InboxConfig` has no member `RecentlyClosedWindowDays` (compile error).

- [ ] **Step 3: Add the field + update the default.** In `AppConfig.cs`, change the `InboxConfig` record (currently lines ~37-40):

```csharp
public sealed record InboxConfig(
    bool Deduplicate,
    InboxSectionsConfig Sections,
    bool ShowHiddenScopeFooter,
    int RecentlyClosedWindowDays = 14);
```

And update `AppConfig.Default` (line ~20) to pass it explicitly:

```csharp
new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true, true), true, 14),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~LegacyConfig_WithoutRecentlyClosedWindowDays"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/AppConfig.cs tests/PRism.Core.Tests/Config/ConfigStorePatchAsyncDottedPathTests.cs
git commit -m "feat(#133): add InboxConfig.RecentlyClosedWindowDays (default 14)"
```

---

## Task 2: Orchestrator reads the window from config

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:117`
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (add a window param to the `ConfigWithSections` helper; capture the window in the fake)

- [ ] **Step 1: Extend the test helpers.** In `InboxRefreshOrchestratorTests.cs`, add a `recentlyClosedWindowDays` parameter to `ConfigWithSections` (default 14) and thread it into the `InboxConfig`:

```csharp
private static AppConfig ConfigWithSections(
    bool reviewRequested = true,
    bool awaitingAuthor = true,
    bool authoredByMe = true,
    bool mentioned = true,
    bool ciFailing = true,
    bool recentlyClosed = false,
    int recentlyClosedWindowDays = 14)
    => AppConfig.Default with
    {
        Inbox = new InboxConfig(
            Deduplicate: false,
            Sections: new InboxSectionsConfig(
                reviewRequested, awaitingAuthor, authoredByMe, mentioned, ciFailing, recentlyClosed),
            ShowHiddenScopeFooter: true,
            RecentlyClosedWindowDays: recentlyClosedWindowDays)
    };
```

Then ensure `FakeSectionQueryRunner` records the window it was queried with. Find its `QueryClosedHistoryAsync` and add a captured field (add the property if missing):

```csharp
public int? LastClosedWindowDays { get; private set; }
public Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct)
{
    LastClosedWindowDays = windowDays;
    _onClosedQueried?.Invoke();        // PRESERVE — RecentlyClosed_Disabled_NoSection_AndNoQuery depends on it
    return Task.FromResult(_closed);
}
```

(The real fake body is `{ _onClosedQueried?.Invoke(); return Task.FromResult(_closed); }` — keep that side effect; only ADD the `LastClosedWindowDays` capture. Dropping `_onClosedQueried?.Invoke()` would silently neuter `RecentlyClosed_Disabled_NoSection_AndNoQuery` into a false pass.)

- [ ] **Step 2: Write the failing test**

```csharp
[Fact]
public async Task RecentlyClosed_QueriesWithConfiguredWindow()
{
    var sections = new FakeSectionQueryRunner(
        _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(),
        closed: Array.Empty<RawPrInboxItem>());
    var configMock = ConfigStoreMock(ConfigWithSections(recentlyClosed: true, recentlyClosedWindowDays: 30));
    using var sut = Build(config: configMock.Object, sections: sections);

    await sut.RefreshAsync(CancellationToken.None);

    sections.LastClosedWindowDays.Should().Be(30);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RecentlyClosed_QueriesWithConfiguredWindow"`
Expected: FAIL — `LastClosedWindowDays` is 14 (orchestrator still passes `InboxHistoryConstants.HistoryWindowDays`).

- [ ] **Step 4: Change the orchestrator.** In `InboxRefreshOrchestrator.cs` line ~117, replace:

```csharp
.QueryClosedHistoryAsync(InboxHistoryConstants.HistoryWindowDays, ct)
```
with:
```csharp
.QueryClosedHistoryAsync(_config.Current.Inbox.RecentlyClosedWindowDays, ct)
```

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RecentlyClosed_QueriesWithConfiguredWindow"`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#133): read recently-closed window from config"
```

---

## Task 3: Recency-sort the closed-history search

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs:78-111`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`

**Why:** GitHub `search/issues` defaults to `sort=best-match`. The repo ranking must operate on a *recency* slice, so the closed-history sub-queries (only) get `&sort=updated&order=desc`. Live-section searches are unchanged.

- [ ] **Step 1: Write the failing test** (mirror the existing `QueryClosedHistory_FiresBothSubQueries_WithCutoff_AndDedupesByRef` harness — it uses `FakeHttpMessageHandler`, `BuildSut(handler)`, and `Respond(HttpStatusCode.OK, body)`; capture `req.RequestUri!.Query`):

```csharp
[Fact]
public async Task QueryClosedHistory_RequestsUpdatedDescSort()
{
    var calls = new List<string>();
    var handler = new FakeHttpMessageHandler(req =>
    {
        calls.Add(req.RequestUri!.Query);
        return Respond(HttpStatusCode.OK, """{ "items": [] }""");
    });
    var sut = BuildSut(handler);

    await sut.QueryClosedHistoryAsync(14, default);

    calls.Should().NotBeEmpty();
    calls.Should().OnlyContain(q => q.Contains("sort=updated") && q.Contains("order=desc"));
}
```

(`FakeHttpMessageHandler`/`BuildSut`/`Respond` are the file's real helpers — confirm their exact names/signatures before pasting. `req.RequestUri!.Query` is URL-encoded, but `sort=updated`/`order=desc` have no reserved chars, so `.Contains` works on the raw query.)

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~QueryClosedHistory_RequestsUpdatedDescSort"`
Expected: FAIL — query has no `sort=updated`.

- [ ] **Step 3: Implement.** In `GitHubSectionQueryRunner.cs`, give `SearchAsync` an optional sort and pass it only from closed history. Change the signature (line ~109):

```csharp
private async Task<List<RawPrInboxItem>> SearchAsync(string q, string? token, CancellationToken ct, string? sort = null)
```
and the URL build (line ~111):
```csharp
var url = $"search/issues?q={Uri.EscapeDataString(q)}&per_page=50"
    + (sort is null ? "" : $"&sort={sort}&order=desc");
```
Then in `QueryClosedHistoryAsync` (line ~93), pass the sort:
```csharp
try { return (IReadOnlyList<RawPrInboxItem>)await SearchAsync(q.Item2, token, ct, sort: "updated").ConfigureAwait(false); }
```
(Leave `QueryAllAsync`'s `SearchAsync` calls unchanged — they default `sort: null` = best-match, as today.)

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~QueryClosedHistory"`
Expected: PASS (the new test and the existing closed-history tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs
git commit -m "feat(#133): recency-sort the recently-closed search (sort=updated&order=desc)"
```

---

## Task 4: Repo cap replaces the PR cap (constants + orchestrator)

**Files:**
- Modify: `PRism.Core/Inbox/InboxHistoryConstants.cs`
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:209-215`
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (rewrite one test, add three; add a repo-parameterized helper)

- [ ] **Step 1: Add a repo-parameterized closed-row helper.** In `InboxRefreshOrchestratorTests.cs`, next to `RawClosed`, add:

```csharp
private static RawPrInboxItem RawClosedRepo(int n, string repo, DateTimeOffset closed)
{
    var slash = repo.IndexOf('/');
    var owner = repo[..slash];
    var name = repo[(slash + 1)..];
    return new(Ref(n, owner, name), $"PR #{n}", "author", repo,
        DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0, 0, 0, "", 1,
        MergedAt: closed, ClosedAt: closed);
}
```

- [ ] **Step 2: Rewrite the now-broken test + add the repo-cap tests.** Replace `RecentlyClosed_CapsAtMaxRows_KeepingNewest` entirely with:

```csharp
[Fact]
public async Task RecentlyClosed_CapsAtMaxRepos_KeepingMostRecentlyClosedRepos()
{
    var baseTime = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    // One PR per repo; repo index N closed at base+N minutes (higher index = newer).
    var repoCount = InboxHistoryConstants.MaxHistoryRepos + 5;
    var closed = Enumerable.Range(1, repoCount)
        .Select(i => RawClosedRepo(i, $"acme/repo{i:D2}", baseTime.AddMinutes(i)))
        .ToArray();
    var sections = new FakeSectionQueryRunner(
        _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
    using var sut = Build(config: ConfigStoreMock(ConfigWithSections(recentlyClosed: true)).Object, sections: sections);

    await sut.RefreshAsync(CancellationToken.None);

    var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
    var repos = sec.Select(i => i.Repo).Distinct().ToList();
    repos.Should().HaveCount(InboxHistoryConstants.MaxHistoryRepos);
    repos.Should().NotContain("acme/repo01");        // oldest repo dropped
    repos.First().Should().Be($"acme/repo{repoCount:D2}"); // newest repo first
}

[Fact]
public async Task RecentlyClosed_CapIsOnRepos_NotPrs_RetainsAllPrsOfKeptRepos()
{
    var t = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    // 2 repos, many PRs each — both repos (and all their PRs) survive a 20-repo cap.
    var closed = new[]
    {
        RawClosedRepo(1, "acme/api", t.AddMinutes(50)),
        RawClosedRepo(2, "acme/api", t.AddMinutes(40)),
        RawClosedRepo(3, "acme/api", t.AddMinutes(30)),
        RawClosedRepo(4, "acme/web", t.AddMinutes(45)),
        RawClosedRepo(5, "acme/web", t.AddMinutes(35)),
    };
    var sections = new FakeSectionQueryRunner(
        _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
    using var sut = Build(config: ConfigStoreMock(ConfigWithSections(recentlyClosed: true)).Object, sections: sections);

    await sut.RefreshAsync(CancellationToken.None);

    var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
    sec.Should().HaveCount(5);                                  // no PR-count cap
    sec.Select(i => i.Repo).Distinct().Should().Equal("acme/api", "acme/web"); // api first (newer close)
}

[Fact]
public async Task RecentlyClosed_TieOnNewestClose_IsDeterministic()
{
    var t = DateTimeOffset.Parse("2026-05-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
    // Two repos whose newest close is the SAME instant. Tiebreak: higher PR number wins.
    var closed = new[]
    {
        RawClosedRepo(10, "acme/aaa", t),
        RawClosedRepo(20, "acme/bbb", t),
    };
    var sections = new FakeSectionQueryRunner(
        _ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>(), closed: closed);
    using var sut = Build(config: ConfigStoreMock(ConfigWithSections(recentlyClosed: true)).Object, sections: sections);

    await sut.RefreshAsync(CancellationToken.None);

    var sec = sut.Current!.Sections[InboxHistoryConstants.SectionId];
    sec.Select(i => i.Repo).Should().Equal("acme/bbb", "acme/aaa"); // PR #20 > #10 → bbb first, stable
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RecentlyClosed"`
Expected: FAIL/compile error — `InboxHistoryConstants.MaxHistoryRepos` does not exist yet.

- [ ] **Step 4: Update constants.** Replace `InboxHistoryConstants.cs` body:

```csharp
namespace PRism.Core.Inbox;

/// <summary>
/// Bounds for the recently-closed inbox section. The history window is config-backed
/// (InboxConfig.RecentlyClosedWindowDays); the repo cap stays a constant heuristic (#133).
/// </summary>
public static class InboxHistoryConstants
{
    /// <summary>Max number of distinct repos shown in recently-closed (cap is on repos, not PRs).</summary>
    public const int MaxHistoryRepos = 20;
    public const string SectionId = "recently-closed";
}
```

- [ ] **Step 5: Update the orchestrator materialization block.** In `InboxRefreshOrchestrator.cs`, replace the `closedItems` build (lines ~209-215) with:

```csharp
var ordered = closedRaw
    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r) // fallback: enrichment dropped (e.g. 404) → null close timestamps; sorts by UpdatedAt below, not bottom.
    .Select(r => MaterializePrInboxItem(r, ciByRef, state))         // NO HeadSha filter; CI is a live-PR concept.
    .OrderByDescending(i => i.MergedAt ?? i.ClosedAt ?? i.UpdatedAt) // UpdatedAt fallback (always populated) keeps dropped-enrichment rows in place.
    .ThenByDescending(i => i.Reference.Number)                       // total order so the top-N repo cut is stable across ticks…
    .ThenBy(i => i.Repo, StringComparer.Ordinal)                    // …even when newest-close timestamps tie.
    .ToList();
var topRepos = ordered
    .Select(i => i.Repo)
    .Distinct(StringComparer.Ordinal)        // first-seen order = repos by most-recent close
    .Take(InboxHistoryConstants.MaxHistoryRepos)
    .ToHashSet(StringComparer.Ordinal);
var closedItems = (IReadOnlyList<PrInboxItem>)ordered
    .Where(i => topRepos.Contains(i.Repo))   // keep all PRs of the kept repos
    .ToList();
sectionsFinal[InboxHistoryConstants.SectionId] = closedItems;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `dotnet test tests/PRism.Core.Tests --filter "FullyQualifiedName~RecentlyClosed"`
Expected: PASS (all four recently-closed tests, including the unchanged disabled/empty-headsha ones).

- [ ] **Step 7: Build the whole solution to confirm no stale `MaxHistoryRows`/`HistoryWindowDays` reference remains**

Run: `dotnet build --configuration Release`
Expected: success, 0 errors. (If any reference remains, fix it — feasibility review confirmed only line 117 + this block + the rewritten test used them.)

- [ ] **Step 8: Commit**

```bash
git add PRism.Core/Inbox/InboxHistoryConstants.cs PRism.Core/Inbox/InboxRefreshOrchestrator.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "feat(#133): repo cap (top-N repos) replaces the 30-PR recently-closed cap"
```

---

## Task 5: `groupByRepo` frontend utility

**Files:**
- Create: `frontend/src/components/Inbox/groupByRepo.ts`
- Test: `frontend/src/components/Inbox/groupByRepo.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { groupByRepo, prId } from './groupByRepo';
import type { PrInboxItem } from '../../api/types';

function pr(owner: string, repo: string, number: number): PrInboxItem {
  return {
    reference: { owner, repo, number },
    title: `PR ${number}`, author: 'a', repo: `${owner}/${repo}`,
    updatedAt: '2026-05-01T00:00:00Z', pushedAt: '2026-05-01T00:00:00Z',
    iterationNumber: 1, commentCount: 0, additions: 0, deletions: 0,
    headSha: 'x', ci: 'none', lastViewedHeadSha: null, lastSeenCommentId: null,
    mergedAt: null, closedAt: null,
  };
}

describe('groupByRepo', () => {
  it('returns [] for empty input', () => {
    expect(groupByRepo([])).toEqual([]);
  });

  it('returns one group for a single repo', () => {
    const groups = groupByRepo([pr('acme', 'api', 1), pr('acme', 'api', 2)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe('acme/api');
    expect(groups[0].items.map((i) => i.reference.number)).toEqual([1, 2]);
  });

  it('preserves first-seen repo order and within-repo order', () => {
    const groups = groupByRepo([
      pr('acme', 'web', 1), pr('acme', 'api', 2), pr('acme', 'web', 3),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(['acme/web', 'acme/api']); // first-seen
    expect(groups[0].items.map((i) => i.reference.number)).toEqual([1, 3]);
  });

  it('over a close-desc input yields most-recent-close repo order', () => {
    // Backend emits close-desc; first-seen grouping must surface repos newest-first.
    const groups = groupByRepo([
      pr('acme', 'a', 9), pr('acme', 'b', 8), pr('acme', 'a', 7),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(['acme/a', 'acme/b']);
  });
});

describe('prId', () => {
  it('formats owner/repo#number', () => {
    expect(prId(pr('acme', 'api', 5))).toBe('acme/api#5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/groupByRepo.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// frontend/src/components/Inbox/groupByRepo.ts
import type { PrInboxItem } from '../../api/types';

export interface RepoGroup {
  repo: string; // "owner/name"
  items: PrInboxItem[];
}

/** Stable id for a PR row — also the enrichment map key. */
export function prId(pr: PrInboxItem): string {
  return `${pr.reference.owner}/${pr.reference.repo}#${pr.reference.number}`;
}

/**
 * Fold a flat PR list into per-repo groups, preserving first-seen repo order and
 * within-repo order. No timestamp sort — the backend's emission order is authoritative
 * (recently-closed arrives close-desc, so first-seen yields most-recent-close repo order).
 */
export function groupByRepo(items: PrInboxItem[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byRepo = new Map<string, RepoGroup>();
  for (const item of items) {
    let g = byRepo.get(item.repo);
    if (!g) {
      g = { repo: item.repo, items: [] };
      byRepo.set(item.repo, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/groupByRepo.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/groupByRepo.ts frontend/src/components/Inbox/groupByRepo.test.ts
git commit -m "feat(#133): groupByRepo util (first-seen order) + prId helper"
```

---

## Task 6: `InboxRow` gains a `showRepo` prop

**Files:**
- Modify: `frontend/src/components/Inbox/InboxRow.tsx:9-14,56-69`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

- [ ] **Step 1: Write the failing test.** Add to `InboxRow.test.tsx` (reuse its existing `PR` fixture + render helper; if rows are rendered via a small wrapper there, follow it):

```tsx
import { render, screen } from '@testing-library/react';
// ...existing imports / PR fixture / MemoryRouter+OpenTabsProvider wrapper...

describe('InboxRow showRepo', () => {
  function renderRow(showRepo?: boolean) {
    return render(
      <MemoryRouter>
        <OpenTabsProvider>
          <InboxRow pr={PR} showCategoryChip={false} maxDiff={100} showRepo={showRepo} />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
  }

  it('shows the repo by default', () => {
    renderRow();
    expect(screen.getByText('acme/api')).toBeInTheDocument();
  });

  it('hides the repo and its separator when showRepo=false', () => {
    const { container } = renderRow(false);
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
    // No orphan leading separator: the meta line must not start with "·".
    const meta = container.querySelector('[class*="meta"]')!;
    expect(meta.textContent!.trimStart().startsWith('·')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — `showRepo` not a prop; both spans still render.

- [ ] **Step 3: Implement.** In `InboxRow.tsx`, add the prop (default true) and gate the repo span + its following separator as one fragment. Update the Props interface (lines ~9-14):

```tsx
interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
  showRepo?: boolean;
}
export function InboxRow({ pr, enrichment, showCategoryChip, maxDiff, showRepo = true }: Props) {
```

Replace the repo span + first separator in the meta block (currently lines ~59-60):

```tsx
{showRepo && (
  <>
    <span className={styles.mono}>{pr.repo}</span>
    <span className={styles.dotsep}>·</span>
  </>
)}
```

(Leave the author / iter / age spans and their separators unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS (new tests + existing InboxRow tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(#133): InboxRow showRepo prop (suppress redundant repo inside a group)"
```

---

## Task 7: `RepoGroupAccordion` component

**Files:**
- Create: `frontend/src/components/Inbox/RepoGroupAccordion.tsx`
- Create: `frontend/src/components/Inbox/RepoGroupAccordion.module.css`
- Test: `frontend/src/components/Inbox/RepoGroupAccordion.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import type { PrInboxItem } from '../../api/types';

function pr(n: number): PrInboxItem {
  return {
    reference: { owner: 'acme', repo: 'api', number: n },
    title: `PR ${n}`, author: 'a', repo: 'acme/api',
    updatedAt: '2026-05-01T00:00:00Z', pushedAt: '2026-05-01T00:00:00Z',
    iterationNumber: 1, commentCount: 0, additions: 0, deletions: 0,
    headSha: 'x', ci: 'none', lastViewedHeadSha: null, lastSeenCommentId: null,
    mergedAt: null, closedAt: null,
  };
}
const group = { repo: 'acme/api', items: [pr(1), pr(2)] }; // RepoGroup shape from ./groupByRepo

function renderAcc(defaultOpen: boolean) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <RepoGroupAccordion group={group} enrichments={{}} showCategoryChip={false} maxDiff={100} defaultOpen={defaultOpen} />
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('RepoGroupAccordion', () => {
  it('shows repo name + count badge', () => {
    renderAcc(true);
    expect(screen.getByRole('button', { name: /acme\/api, 2 pull requests/i })).toBeInTheDocument();
  });

  it('renders rows only when open', async () => {
    renderAcc(false);
    expect(screen.queryByText('PR 1')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /acme\/api/i }));
    expect(screen.getByText('PR 1')).toBeInTheDocument();
  });

  it('rows inside the group omit the repo span', () => {
    renderAcc(true);
    // Repo appears once (the header), not repeated in each row's meta.
    expect(screen.getAllByText('acme/api')).toHaveLength(1);
  });
});
```

(If `RepoGroup` isn't re-exported from `api/types`, import it from `./groupByRepo` instead — adjust the import line.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/RepoGroupAccordion.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/Inbox/RepoGroupAccordion.tsx
import { useState } from 'react';
import type { InboxItemEnrichment } from '../../api/types';
import { type RepoGroup, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import styles from './RepoGroupAccordion.module.css';

interface Props {
  group: RepoGroup;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen: boolean;
}

export function RepoGroupAccordion({ group, enrichments, showCategoryChip, maxDiff, defaultOpen }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const count = group.items.length;
  return (
    <div className={styles.group}>
      <button
        className={styles.header}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${group.repo}, ${count} pull request${count === 1 ? '' : 's'}`}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={styles.repo}>{group.repo}</span>
        <span className={styles.count}>{count}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {group.items.map((pr) => (
            <InboxRow
              key={prId(pr)}
              pr={pr}
              enrichment={enrichments[prId(pr)]}
              showCategoryChip={showCategoryChip}
              maxDiff={maxDiff}
              showRepo={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Add the stylesheet** (`RepoGroupAccordion.module.css`) — child-of-section hierarchy per spec (indent + lighter weight, no card chrome):

```css
.group {
  border-bottom: 1px solid var(--border-1);
}
.group:last-child {
  border-bottom: 0;
}
.header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: var(--s-2) var(--s-4);
  padding-left: calc(var(--s-4) + var(--s-4)); /* one step deeper than the section header */
  font-size: var(--text-sm);
  font-weight: 400;                            /* vs section header 500 */
  color: var(--text-2);
  text-align: left;
  background: transparent;
  cursor: pointer;
}
.header:hover {
  background: var(--surface-2);
}
/* No scoped :focus-visible — inherit the global ring from tokens.css (outline
   --accent-ring, outline-offset 2px), the same treatment InboxRow relies on.
   A scoped rule here would diverge (wrong color/offset) from the app pattern. */
.repo {
  font-family: var(--font-mono);
}
.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  background: var(--surface-3);
  color: var(--text-2);
  border-radius: 999px;
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}
/* Indent the rows so the unread accent bar reads as aligned to the group, not the section edge. */
.body {
  padding-left: var(--s-4);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/RepoGroupAccordion.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Inbox/RepoGroupAccordion.tsx frontend/src/components/Inbox/RepoGroupAccordion.module.css frontend/src/components/Inbox/RepoGroupAccordion.test.tsx
git commit -m "feat(#133): RepoGroupAccordion nested accordion component"
```

---

## Task 8: `RecentlyClosedFooter` → unconditional caption, no props

**Files:**
- Modify: `frontend/src/components/Inbox/RecentlyClosedFooter.tsx`
- Modify: `frontend/src/components/Inbox/RecentlyClosedFooter.module.css` (rename class for clarity; optional)
- Test: `frontend/src/components/Inbox/RecentlyClosedFooter.test.tsx` (create if absent)

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';

describe('RecentlyClosedFooter', () => {
  it('renders the unconditional caption with no props', () => {
    render(<RecentlyClosedFooter />);
    expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/Inbox/RecentlyClosedFooter.test.tsx`
Expected: FAIL — component currently requires a `count` prop / different copy.

- [ ] **Step 3: Implement**

```tsx
// frontend/src/components/Inbox/RecentlyClosedFooter.tsx
import styles from './RecentlyClosedFooter.module.css';

export function RecentlyClosedFooter() {
  return (
    <div className={styles.caption}>
      Repositories with PRs you&apos;ve closed recently — most recent first.
    </div>
  );
}
```

And in `RecentlyClosedFooter.module.css`, rename `.truncationHint` → `.caption` (same rules):

```css
.caption {
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-xs);
  color: var(--text-3);
  border-top: 1px solid var(--border-1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/Inbox/RecentlyClosedFooter.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/RecentlyClosedFooter.tsx frontend/src/components/Inbox/RecentlyClosedFooter.module.css frontend/src/components/Inbox/RecentlyClosedFooter.test.tsx
git commit -m "feat(#133): RecentlyClosedFooter unconditional caption (no props)"
```

---

## Task 9: `InboxSection` integration — grouping, flatten, unconditional footer

**Files:**
- Modify: `frontend/src/components/Inbox/InboxSection.tsx`
- Test: `frontend/src/components/Inbox/InboxSection.test.tsx`

- [ ] **Step 1: Write the failing tests.** **Create** `frontend/src/components/Inbox/InboxSection.test.tsx` (it does not exist yet) with local helpers — `prFor(owner, repo, n)` returning a full `PrInboxItem` (copy the shape from `InboxRow.test.tsx`'s `PR` fixture), `makeSection(id, items)` returning `{ id, label: id, items }`, and `renderSection(section, props?)` wrapping `<InboxSection>` in `MemoryRouter` + `OpenTabsProvider` (as `RepoGroupAccordion.test.tsx` does):

```tsx
// Multi-repo live section → one accordion per repo, repos open by default.
it('renders a RepoGroupAccordion per repo for a multi-repo section', () => {
  const section = makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]);
  renderSection(section); // helper that wraps in Router+OpenTabsProvider
  expect(screen.getByRole('button', { name: /acme\/api, 1 pull request/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /acme\/web, 1 pull request/i })).toBeInTheDocument();
  expect(screen.getByText('PR 1')).toBeInTheDocument(); // live sections open by default
});

// Single-repo section → flat rows, no accordion, repo shown.
it('renders flat rows (no accordion) for a single-repo section', () => {
  const section = makeSection('review-requested', [prFor('acme', 'api', 1), prFor('acme', 'api', 2)]);
  renderSection(section);
  expect(screen.queryByRole('button', { name: /pull requests?/i })).not.toBeInTheDocument();
  expect(screen.getByText('PR 1')).toBeInTheDocument();
  expect(screen.getAllByText('acme/api').length).toBeGreaterThan(0); // repo visible in flat rows
});

// Recently-closed → repo groups collapsed by default + unconditional caption.
it('recently-closed repo groups start collapsed and the caption renders', () => {
  const section = makeSection('recently-closed', [prFor('acme', 'api', 1), prFor('acme', 'web', 2)]);
  renderSection(section, { defaultOpen: true }); // section itself open
  expect(screen.queryByText('PR 1')).not.toBeInTheDocument(); // repos collapsed
  expect(screen.getByText(/most recent first/i)).toBeInTheDocument();
});
```

(If the test file lacks `makeSection`/`renderSection`/`prFor` helpers, add small local ones mirroring the `PR` fixture from `InboxRow.test.tsx`. `makeSection(id, items)` returns `{ id, label: id, items }`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxSection.test.tsx`
Expected: FAIL — section still renders a flat list, no accordions, footer conditional.

- [ ] **Step 3: Rewrite `InboxSection.tsx`.** Replace the file with:

```tsx
import { useState } from 'react';
import type { InboxSection as InboxSectionDto, InboxItemEnrichment } from '../../api/types';
import { groupByRepo, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';
import styles from './InboxSection.module.css';

const RECENTLY_CLOSED = 'recently-closed';

const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author': 'Nothing waiting on the author.',
  'authored-by-me': "You haven't opened any PRs.",
  mentioned: "You aren't @-mentioned on any open PRs.",
  'ci-failing': 'No CI failures on your PRs — nice.',
  'recently-closed': 'No PRs closed recently.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen?: boolean;
}

export function InboxSection({ section, enrichments, showCategoryChip, maxDiff, defaultOpen = true }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const isRecentlyClosed = section.id === RECENTLY_CLOSED;
  const groups = groupByRepo(section.items);
  const repoDefaultOpen = !isRecentlyClosed;

  return (
    <section className={styles.section}>
      <button className={styles.header} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={styles.label}>{section.label}</span>
        <span className={styles.count}>{section.items.length}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {section.items.length === 0 ? (
            <div className={styles.empty}>{EmptyCopy[section.id] ?? 'Nothing here.'}</div>
          ) : groups.length <= 1 ? (
            section.items.map((pr) => (
              <InboxRow
                key={prId(pr)}
                pr={pr}
                enrichment={enrichments[prId(pr)]}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
              />
            ))
          ) : (
            groups.map((g) => (
              <RepoGroupAccordion
                key={g.repo}
                group={g}
                enrichments={enrichments}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
                defaultOpen={repoDefaultOpen}
              />
            ))
          )}
          {/* "Unconditional" per spec = not gated on truncation (the old >=30 hint). The
              length>0 guard is intentional: an empty recently-closed shows EmptyCopy, not a
              "most recent first" caption over nothing. */}
          {isRecentlyClosed && section.items.length > 0 && <RecentlyClosedFooter />}
        </div>
      )}
    </section>
  );
}
```

(This deletes the **frontend** `MaxHistoryRows = 30` constant in `InboxSection.tsx` — distinct from the backend constant replaced by `MaxHistoryRepos` in Task 4 — and the `showTruncationHint` logic, and removes the now-unused `PrInboxItem` import. The `prId` helper now comes from `groupByRepo`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/Inbox/InboxSection.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Inbox/InboxSection.tsx frontend/src/components/Inbox/InboxSection.test.tsx
git commit -m "feat(#133): InboxSection groups by repo (flatten single-repo) + unconditional footer"
```

---

## Task 10: Integration sweep + full verification

**Files:**
- Modify (as needed): `frontend/src/pages/InboxPage.test.tsx`

- [ ] **Step 1: Run the full frontend test suite; fix any fallout from the nested DOM**

Run: `cd frontend && npx vitest run`
Expected: PASS. Note: the current `InboxPage.test.tsx` only exercises the `error && !data` alertdialog branch (it mocks `useInbox` to return `data: null`) — it renders no `InboxSection`/`InboxRow`, so it likely needs **no** change. If any frontend test elsewhere asserted a flat row list under a multi-repo section, expand the repo group first then assert the row (do not weaken assertions).

- [ ] **Step 2: Run the full backend test suite**

Run: `dotnet test`
Expected: PASS (entire solution).

- [ ] **Step 3: Lint + format + build (the CI gate — run prettier directly, not via rtk)**

Run:
```bash
cd frontend && node ./node_modules/prettier/bin/prettier.cjs --write "src/**/*.{ts,tsx,css}" && npm run lint && npm run build
```
Expected: prettier writes any formatting, lint passes (no `no-unused-vars` — confirm the removed `PrInboxItem` import and any dead `MaxHistoryRows` are gone), build succeeds.

- [ ] **Step 4: Commit any formatting / test fixups**

```bash
git add -A
git commit -m "test(#133): update InboxPage tests for nested repo groups; format"
```

- [ ] **Step 5: Capture B1 visual proof.** Launch the app against the real PAT and screenshot the inbox showing: a multi-repo live section (repos open), a single-repo section (flat), and recently-closed (repos collapsed + caption). These go on the PR per the visual-verification convention.

Run: `pwsh ./run.ps1 -Reset None --no-browser` then drive `http://localhost:5180` with Playwright; save PNGs for the PR. (Validate at this gate the two B1 questions deferred from the spec: small-live-section noise, and the recently-closed two-layer-collapse feel.)

- [ ] **Step 6: Final commit if any screenshots/assets are tracked**

```bash
git add -A && git commit -m "docs(#133): B1 visual proof for inbox group-by-repo" --allow-empty
```

---

## Self-review notes (for the executor)

- **Wire contract unchanged:** no task edits `api/types.ts`, `/api/inbox` serialization, `InboxSnapshot`, `ComputeDiff`, or the SSE event. If a task tempts you to, stop — grouping is frontend-only.
- **No `inbox.groupByRepo` pref / gate** is added (that's #219). Grouping ships default-on; the single call site is `InboxSection`'s `groups.length <= 1 ? flat : accordions`.
- **Section-header hover/focus** is intentionally NOT added to `InboxSection.module.css` in this slice (avoid an unguarded change to existing UI) — only the new `RepoGroupAccordion` header gets hover/focus. Note any resulting inconsistency at the B1 review.
- **Constants:** after Task 4, `grep -r HistoryWindowDays` and `grep -r MaxHistoryRows` across `PRism.*` (backend) must return nothing. The **frontend** `MaxHistoryRows` lives until Task 9 — after Task 9, `grep -r MaxHistoryRows frontend/` must also return nothing.
- **B1 visual open questions (validate at Task 10's screenshot gate):** (a) the repo count badge is styled identically to the section count badge — confirm it reads as distinct at the child level; (b) the empty recently-closed shows EmptyCopy with no caption (intentional); (c) the two deferred spec questions — small-live-section noise, recently-closed two-layer collapse.
