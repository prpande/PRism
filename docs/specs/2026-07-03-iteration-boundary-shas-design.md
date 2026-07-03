# Iteration boundary SHAs — fix the empty-Files-tab defect (#281)

**Status:** design · T2 · bug fix
**Date:** 2026-07-03
**Issue:** #281 (core defect slice; Track-1 exhaustive matrix + Track-2 corpus deferred)

## Problem

Selecting an iteration chip that advertises changes (`+adds / -rems`) can render an
**empty Files tab**. Observed across multiple real PRs.

### Root cause

Each iteration's diff is fetched as GitHub **three-dot** `compare/{BeforeSha}...{AfterSha}`
(`GitHubReviewService.FetchCompareFilesAsync`). `WeightedDistanceClusteringStrategy` sets
each cluster's boundaries to the cluster's **own** commits:

```
BeforeSha  = sorted[startIdx].Sha   // FIRST commit IN the cluster
AfterSha   = sorted[endIdx].Sha     // LAST  commit IN the cluster
CommitShas = sorted[startIdx..endIdx]  // inclusive → drives the chip's +adds/-rems
```

Two defects follow:

1. **Single-commit iteration → empty diff.** When a cluster is one commit —
   *every* single-commit PR's "Iter 1" (strategy line 24-25) and *any* time-isolated
   fixup commit split into its own cluster — `BeforeSha == AfterSha`. GitHub's
   `compare/{sha}...{sha}` returns `status: "identical"`, `files: []`. The Files tab is
   empty while the chip still shows the commit's line counts.

2. **Multi-commit iteration drops its first commit.** `compare(first...last)` has
   merge-base == `first`, so the diff starts *at* the first commit and **excludes that
   commit's own changes**. Chip counts include it; the diff does not.

### Live confirmation (real GitHub API, PR #719)

- `compare(FIRST...FIRST)` → `status: identical`, **0 files**.
- buggy `compare(FIRST...LAST)` → **17 files / 19 commits**.
- correct `compare(parent(FIRST)...LAST)` → **24 files / 20 commits** (the first commit
  and 7 whole files were being dropped).

### Why it shipped

`WeightedDistanceClusteringStrategyTests` has **zero** assertions on `BeforeSha`/`AfterSha`,
and `PrDetailLoaderTests` feeds a hand-crafted fake cluster — so the real boundary logic was
never exercised end-to-end. Closing that seam is #281's purpose.

## Fix

An iteration's lower bound must be the boundary the reviewer last saw (**exclusive**):

| Iteration | `BeforeSha` (fixed) | `AfterSha` | `CommitShas` |
|-----------|---------------------|------------|--------------|
| 1 (`startIdx == 0`) | PR **base** SHA | last commit of cluster | cluster's commits (unchanged) |
| k > 1 | previous cluster's last commit (`sorted[startIdx-1].Sha`) | last commit of cluster | cluster's commits (unchanged) |

Then `compare(BeforeSha...AfterSha)` shows exactly that iteration's changes, and single-commit
iterations are non-empty. This is consistent with "All changes" (`compare(base...head)`):
a one-iteration PR's "Iter 1" becomes `compare(base...head)`, identical to "All changes".

### Threading the PR base SHA

The base SHA is available where clustering runs (`PrDetailLoader.ComposeSnapshotAsync`
enriches the timeline; `DetermineQuality` calls `Cluster`), as `detail.Pr.BaseSha`. Add an
**optional** `string? PrBaseSha` to `ClusteringInput` (last positional param, defaulted `null`
— additive, breaks none of the four existing constructors). `ComposeSnapshotAsync` enriches
the timeline with `timeline with { PrBaseSha = detail.Pr.BaseSha }` before passing it to
`DetermineQuality`, so both `Cluster(...)` and the resolvable-range check read
`timeline.PrBaseSha` (no new `DetermineQuality` parameter). When `PrBaseSha` is null/empty
(tests that don't set it), the strategy falls back to `sorted[0].Sha` for iteration 1 —
`baseRefOid` is a non-null `GitObjectID!` that persists even after base-branch deletion, so
production always supplies it.

Two disjoint code paths set iteration 1's `BeforeSha` and BOTH must change: the single-commit
early return (`WeightedDistanceClusteringStrategy.cs:24-25`) and the first-cluster branch of
the boundary loop (`:82-93`).

### `HasResolvableRange`

Currently `commitShaSet.Contains(Before) && commitShaSet.Contains(After)`. Two changes:
1. The PR base is not a PR commit, so iteration 1 would falsely read "snapshot lost". Treat the
   PR base as resolvable (it is what "All changes" already compares against; a genuinely GC'd
   base still surfaces the runtime `RangeUnreachableException` → "diff unavailable" path).
2. Also require `Before != After`. A degenerate range (`compare(x...x)`) is *always* empty, so
   an iteration whose boundaries collapse — e.g. the empty-`PrBaseSha` single-commit fallback,
   where `Before == After == sorted[0].Sha` and both sit in the commit set — must render
   "snapshot lost" (non-selectable), never an enabled chip over an empty Files tab. This is the
   defense-in-depth guard for the (verified-unlikely) empty-base path.

## Guaranteed invariant

The fix guarantees a selected iteration renders a **non-empty, correct file set** for its
commits — NOT that the chip's `+adds/-rems` (a sum of per-commit line counts) equals the net
three-dot compare totals. Those two can differ under intra-iteration churn (a line added then
removed nets zero in the compare but `+1/-1` in the sum), exactly as GitHub's own
commit-sum-vs-net-diff does. Count-equality is out of scope.

## Non-goals / deferred

- **Force-push / rebase where committedDate order ≠ topological order.** The `Before =
  previous cluster's last commit` rule assumes the commit sorted just before a cluster is an
  ancestor of the cluster's tip. That holds for ordinary linear history (the common case and
  the source of the reported bug) but NOT when history was rewritten with preserved committer
  dates (cherry-pick/rebase) or when the timeline retains force-pushed-away commits. In those
  cases a three-dot compare can still go empty (tip is an ancestor of the chosen `Before`) or
  over-report (merge-base falls back to the fork point). The `Before != After` guard catches
  only the trivial-equality sub-case. Robust topological boundaries (resolving `Before` via a
  commit's real parent, which the timeline query does not fetch today) are the follow-up, with
  the Track-2 corpus (force-push / rebase / large-gap) that #281 defers.
- **`sorted[^1] == headSha`** is assumed for the final cluster (same committedDate-vs-topological
  caveat); pre-existing, out of scope.
- **Comment anchoring on iteration views (amplified, filed follow-up).** Right-side inline
  comments stamp `prDetail.pr.headSha` regardless of the active iteration. Before this fix,
  older-iteration diffs were usually empty (no clickable lines), so this mis-anchoring was
  latent; making those diffs non-empty makes it reachable on open PRs. The proper fix (stamp
  the iteration's `afterSha`) touches the reviewer-atomic submit/anchoring surface (a gated
  risk surface) and is filed separately. Worst case today is a rejected/mis-placed comment
  surfaced with an error, not data loss.
- Track 1 exhaustive Playwright matrix (chips × every control) remains open on #281.

## Doc-review dispositions

One `ce-doc-review` pass (coherence + feasibility + adversarial). Full table lands in the PR
`## Proof`. Summary: adversarial F1 (force-push non-topology) → documented as an explicit
limitation + follow-up (was framed as merely "untested"); F2 (empty-base fallback) → premise
verified partly false (`baseRefOid` persists), kept the `Before != After` defense-in-depth
guard; F3 (chip-count vs net-diff) → clarified the guaranteed invariant above; F4 (comment
mis-anchoring) → filed follow-up, documented; F5 (base always-resolvable) → accepted tradeoff,
runtime 404 backstops; feasibility method-name/edit-site/threading notes → applied above.

## Test plan (TDD, red-on-main)

**`WeightedDistanceClusteringStrategyTests`** (new — boundary SHAs were untested):
- single-commit PR + `PrBaseSha` → `BeforeSha == base`, `AfterSha == commit`, `before != after`.
- multi-cluster → cluster 1 `BeforeSha == base`; cluster 2 `BeforeSha ==` cluster 1's last commit.
- first cluster multi-commit → `BeforeSha == base`, not the cluster's first commit.
- no `PrBaseSha` → falls back to `sorted[0].Sha` (documents the guard).

**`PrDetailLoaderTests`**:
- a cluster whose `BeforeSha` equals the PR base (not in the commit set) → `HasResolvableRange == true`.

**Live validation:** run the app against a real merged multi-iteration PR; click each iteration
chip and confirm a correct, non-empty diff.
