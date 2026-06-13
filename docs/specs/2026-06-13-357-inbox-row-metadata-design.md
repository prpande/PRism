# Inbox row metadata: commit count + files-changed (#357)

## Problem

The inbox row currently shows `iter {N}` (e.g. "iter 3") for each PR. That number is
the raw GitHub commit count from `pulls/{n}`, not a real iteration count — the actual
iteration clustering only runs when a PR is opened in the PR-detail view. The label
actively misleads once a PR has had a force-push (clustering collapses related pushes;
raw commit count does not).

A second gap: there is no files-changed count on the row, even though `changed_files`
is already present on the same `pulls/{n}` response the enricher already fetches.

## Goals

1. Relabel `iter N` as `N commits` (singular-aware) — honest label, no new API call.
2. Add a files-changed count to the tail metrics cluster — no new API call.
3. Rename the misleadingly-named field (`IterationNumber`/`IterationNumberApprox`) to
   `CommitCount` throughout the stack for code honesty.

## Non-goals

- Changing the PR-detail clustered iteration count (untouched).
- Adding any new GitHub API calls.
- Touching `state.json` / persisted schema (no B2 surface).

---

## Design

### Implementation approach

Two commits in one PR, so the bug fix (relabel) and the enhancement (files count)
are independently revertible in git history:

- **Commit 1** — rename + relabel (bug fix)
- **Commit 2** — `ChangedFiles` field + tail render (enhancement)

### Data flow (unchanged shape, new field in commit 2)

```
GitHubPrEnricher.FetchAsync  (parse pulls/{n} response)
  → RawPrInboxItem            (PRism.Core/Inbox)
    → InboxRefreshOrchestrator.MapToContractItem
      → PrInboxItem           (PRism.Core.Contracts)
        → JSON wire
          → PrInboxItem       (frontend/src/api/types.ts)
            → InboxRow render
```

---

## Commit 1 — rename + relabel

### Backend

| File | Change |
|------|--------|
| `PRism.Core/Inbox/RawPrInboxItem.cs:22` | `int IterationNumberApprox` → `int CommitCount` |
| `PRism.Core.Contracts/PrInboxItem.cs:16` | `int IterationNumber` → `int CommitCount` |
| `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:299` | `r.IterationNumberApprox` → `r.CommitCount` |

`RawPrInboxItem` and `PrInboxItem` are positional records — the rename is a
declaration-site change; call sites that use named arguments update to `CommitCount:`,
positional callers need no change if argument order is preserved.

### Frontend

| File | Change |
|------|--------|
| `frontend/src/api/types.ts:114` | `iterationNumber: number` → `commitCount: number` |
| `InboxRow.tsx:87–88` | aria-label: `iteration ${pr.iterationNumber}` → `${pr.commitCount} commit${pr.commitCount === 1 ? '' : 's'}` |
| `InboxRow.tsx:148` | render: `iter {pr.iterationNumber}` → `{pr.commitCount} {pr.commitCount === 1 ? 'commit' : 'commits'}` |

Done rows already omit the iteration/commit from their aria-label — no change needed.

### Tests updated (commit 1)

- `PRism.Web/TestHooks/FakeSectionQueryRunner.cs:44` — named arg `IterationNumberApprox: _store.Iterations.Count` → `CommitCount: _store.Iterations.Count`
- `PRism.Web/TestHooks/FakePrDiscovery.cs:32` — named arg `IterationNumber: _store.Iterations.Count` → `CommitCount: _store.Iterations.Count`
- `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs:59` — `IterationNumberApprox.Should().Be(3)` → `CommitCount.Should().Be(3)`
- `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs:26,30` — `RawPr`/`RawClosed` helpers: positional `1` for the old `IterationNumberApprox` slot becomes `CommitCount: 1` (or stays positional if order is preserved)
- All frontend fixture files that set `iterationNumber: 1` → `commitCount: 1`: approximately 13 files, including `InboxRow.test.tsx`, `InboxSection.test.tsx`, `InboxSection.grouping.test.tsx`, `RepoGroupAccordion.test.tsx`, `groupByRepo.test.ts`, `useInboxFilters.test.ts`, `applyInboxFilters.test.ts`, `FilterBar.test.tsx`, `InboxPage.test.tsx`, and e2e specs `inbox.spec.ts`, `inbox-filter.spec.ts`, `a11y-audit.spec.ts`, `ai-gating-sweep.spec.ts`

---

## Commit 2 — `ChangedFiles` field + tail render

### Backend

| File | Change |
|------|--------|
| `PRism.GitHub/Inbox/GitHubPrEnricher.cs` (~line 68) | Add `var changedFiles = doc.RootElement.TryGetProperty("changed_files", out var cf) ? cf.GetInt32() : 0;` alongside `commits`/`additions`/`deletions` |
| `PRism.GitHub/Inbox/GitHubPrEnricher.cs` (~line 97) | Include `ChangedFiles = changedFiles` in the `raw with { … }` expression |
| `PRism.Core/Inbox/RawPrInboxItem.cs` | Add `int ChangedFiles` (required positional, after `CommitCount`, before `MergedAt?`) |
| `PRism.Core.Contracts/PrInboxItem.cs` | Add `int ChangedFiles` (required positional, after `CommitCount`, before `CommentCount`) |
| `PRism.Core/Inbox/InboxRefreshOrchestrator.cs:299` | Pass `r.ChangedFiles` in `new PrInboxItem(…)` — use **named args** here and for all subsequent fields to prevent silent int-binding if parameter order ever shifts again |

**IMPORTANT — positional call site blast radius.** Adding `int ChangedFiles` as a required positional parameter in `PrInboxItem` inserts a new `int` at position 8 (after `CommitCount`, before `CommentCount`). Any call site that constructs `PrInboxItem` with positional integer args from position 8 onward will silently bind wrong field values (no compile error — all `int`s). Before inserting the parameter, convert all such call sites to **named args**. Known affected sites:

- `tests/PRism.Web.Tests/Endpoints/InboxEndpointsTests.cs:263–267` — mixed positional; `1, 0, 1, 0` maps to wrong fields after insertion
- `tests/PRism.Core.Tests/Inbox/InboxDeduplicatorTests.cs:12–16, 57–58` — fully positional
- `tests/PRism.Core.Tests/Ai/NoopSeamTests.cs:76–79` — fully positional

Similarly for `RawPrInboxItem` — `ChangedFiles` lands at position 12 (after `CommitCount`, before `MergedAt?`). All positional call sites that supply ≥ 11 required args need `ChangedFiles: 0` added. Known affected sites (in addition to orchestrator test helpers already noted):

- `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs:139–147` — positional construction; will not compile without `ChangedFiles`
- `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs:19–23` — positional 11-arg; multiple test methods
- `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs:18–23` — positional
- `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs:29–33` — positional
- `tests/PRism.Core.Tests/Inbox/RawPrInboxItemTests.cs:12–14, 24–27` — positional

The recommended approach: **grep for `new RawPrInboxItem(` and `new PrInboxItem(`** as the first implementation step to enumerate all call sites, then convert positional int-heavy constructors to named args before adding the new field.

### Frontend

`api/types.ts` — add `changedFiles: number` to `PrInboxItem`.

`InboxRow.tsx` — add a `.filesSlot` to the tail `.metrics` cluster, after `.commentSlot`:

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

Hidden when `changedFiles === 0` — graceful degradation for any PR where the field
comes back absent or zero (the enricher defaults to `0` on missing property).

`InboxRow.module.css` — add `.filesSlot` and `.files` styles mirroring `.commentSlot`
and `.comments` (same flex/gap/color treatment). Also update `--inbox-tail-w` in the
`.row` block to account for the new slot: the metrics cluster is a fixed-width column
(`var(--inbox-tail-w)`) whose current comment in the CSS documents the slot widths and
running total. Adding a 52px files slot + 12px gap (+64px) requires widening
`--inbox-tail-w` by the same amount; otherwise the new slot overflows or is clipped.

### Tests updated (commit 2)

- `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs` — add `"changed_files": 7` to `PullsResponse` fixture; assert `item.ChangedFiles.Should().Be(7)` in the existing `Adds_head_sha_and_diff_stats` test.
- `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` — `RawPr`/`RawClosed`/`RawClosedRepo` positional helpers add a `0` (or representative value) for the new `ChangedFiles` slot, which sits between `CommitCount` and `MergedAt`.
- `frontend/src/components/Inbox/InboxRow.test.tsx` — add `changedFiles: 5` to the `PR` fixture; add assertion that the count renders in the tail.
- Other frontend fixture files (`filters/`, `groupByRepo`, etc.) — add `changedFiles: 0` (or a non-zero value) as needed to satisfy the updated type.
- Visual baselines regen from the CI artifact after both commits are green.

---

## Acceptance criteria

- [ ] Inbox rows show `N commits` (singular: `1 commit`) instead of `iter N`.
- [ ] Row aria-label matches the visible label — no "iteration" wording.
- [ ] Each inbox row shows a file-glyph + count in the tail metrics cluster.
- [ ] `changedFiles === 0` renders no file slot (no crash, no empty glyph).
- [ ] No new GitHub API call introduced.
- [ ] PR-detail clustered iteration count unchanged.
- [ ] All backend and frontend tests pass; visual baselines regen'd from CI.

---

## Risk classification

- **Tier:** T3 — cross-cutting field addition + rename spanning 8+ files across backend, contracts, orchestrator, frontend types, and React render
- **Risk:** B1 (UI-visual) — `InboxRow` rendered output changes; visual baselines shift; human eyeball-assert required after PR is green. No B2 surfaces touched.
