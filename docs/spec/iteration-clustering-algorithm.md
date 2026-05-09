# PR iteration detection algorithm

This document is the canonical specification of how PRism reconstructs *iterations* (review-rounds) from a GitHub PR's commit history. It is referenced from [`docs/spec/03-poc-features.md`](./03-poc-features.md) § 3 ("Iteration reconstruction") and [`docs/spec/00-verification-notes.md`](./00-verification-notes.md#c2). It supersedes the earlier `60-second clustering policy + clusterGapSeconds knob` text that lived inline in those documents.

The first half of the document (Goal through Future extensions) is the **canonical rationale** — the design reasoning the algorithm was authored against. The second half (`S3 implementation`) is **what S3 actually shipped** and where it intentionally narrowed or diverged from the canonical sketch. Future contributors who want to extend the algorithm should read both halves: the canonical for *why*, the implementation section for *what is in the codebase today*.

---

## Goal

Group the commits on a Pull Request into distinct **iterations** so that a reviewer can quickly see what has changed since the previous iteration, without manually scanning every commit.

An "iteration" here means a coherent burst of work the author considered ready for review (or at least ready to move on from), bounded by some kind of context switch — a break, a rework, a pivot in approach, or feedback being incorporated.

## Why timestamps alone aren't enough, and why they still drive the algorithm

Pure timestamp clustering misses important context: a 5-minute gap between two commits could be a typo fix, or it could be the moment the author finished one approach and started a completely different one after a hallway conversation. Conversely, an 8-hour gap could just be sleep, with the author resuming exactly where they left off.

Author-driven PRs frequently have no formal review event between iterations — local testing, offline walkthroughs, and informal discussions all produce new iterations without leaving a trace in GitHub's review API.

That said, **timestamps remain the most reliably available and consistently meaningful signal**. Every commit has one, they are unambiguous, and gaps between them are still strongly correlated with iteration boundaries. The algorithm therefore keeps the commit timeline as its spine and uses other signals to **modulate the effective distance** between consecutive commits, rather than treating them as orthogonal clustering dimensions.

## Core principle

Cluster commits in 1D along the timeline, but redefine the distance metric:

```
d(commit_i, commit_i+1) = Δt(i, i+1) × multiplier(semantic_signals)
```

The multiplier **shrinks** the effective distance when consecutive commits look like they belong together, and **stretches** it when they look like a context switch. Iteration boundaries are then identified as unusually large weighted distances.

This avoids the unit-mismatch and interpretability problems of true multi-dimensional clustering (timestamp on one axis, file overlap on another, message similarity on a third), while still incorporating all the same information.

## Algorithm

### Step 1: Pull PR data

For the target PR, fetch:
- All commits with author timestamp, SHA, message, and changed file list
- All force-push events on the PR branch
- All review events (submitted reviews, review comments)
- All PR-level comments by the author
- Optionally: per-commit diff stats (additions/deletions)

GitHub GraphQL API is the cleanest single round-trip for this.

### Step 2: Sort commits chronologically

Order by author timestamp. Tie-breaking by commit position in the parent chain when timestamps collide (which happens with rebases).

### Step 3: Compute weighted distance for each consecutive pair

For each pair `(commit_i, commit_i+1)`, compute the multiplier from the signals listed below, then multiply by the raw time gap.

### Step 4: Determine the threshold

Apply an adaptive threshold to the weighted-distance series for the PR. Two reasonable approaches:

- **Otsu-style on gaps.** The distribution of inter-commit weighted distances within a single PR is typically bimodal: many small distances (within an iteration) and a few large ones (between iterations). Pick the threshold that maximally separates the two modes.
- **MAD-based outlier detection.** Flag any weighted distance greater than `median + k × MAD` (with `k` around 3) as an iteration boundary. Robust to a few weird commits.

Add a hard floor (never split below ~5 minutes — protects against trivial fixup commits being separated) and a hard ceiling (always split above ~3 days — handles stale PRs).

### Step 5: Cluster

In 1D with `min_samples = 1`, **DBSCAN** with `eps = threshold` collapses to "split wherever the weighted gap exceeds the threshold." Single-linkage hierarchical clustering with a distance cutoff is mathematically equivalent and gives a free dendrogram if interactive threshold tuning is desired later.

K-means is not appropriate here — the number of iterations is not known in advance, and centroids in time aren't meaningful.

## Signals and how they modulate distance

Listed in roughly descending order of signal-to-noise ratio.

### File overlap (Jaccard on changed file paths)

The single strongest non-temporal signal, and free from the GitHub API. Two commits touching the same files are likely part of the same iteration; two commits touching disjoint files are likely a context switch.

```
files_jaccard = |files(i) ∩ files(i+1)| / |files(i) ∪ files(i+1)|
```

High Jaccard → shrink distance. Low/zero Jaccard → leave or stretch.

### Force-push / rebase markers

A force-push is a soft signal, not a hard boundary. A force-push 2 minutes after the previous commit is usually a "fix commit message" or "fix up the last commit"; a force-push after several hours is much more likely to be a rework or rebase representing a new iteration. Use it as a stretch multiplier that compounds with the time gap.

### Commit message semantics

> **→ S3 status: deferred.** Read § "S3 implementation > What S3 ships vs. defers > Commit message semantics" before re-introducing this signal — the deferral was an empirical judgment about generic keyword sets being fragile across teams, not a "we ran out of time" defer.

Cheap heuristic: keyword matching on the message of `commit_i+1`.
- Strong "continuation" markers ("fix typo", "address feedback", "wip", "fixup", "review comments") → shrink.
- Strong "new direction" markers ("refactor", "rewrite", "switch to", "alternative approach") → stretch.

Expensive option: embedding similarity between consecutive commit messages. Probably not worth the cost in v1; the keyword heuristic captures most of the value.

### Diff size / churn

> **→ S3 status: deferred.** Read § "S3 implementation > What S3 ships vs. defers > Diff size / churn" before re-introducing — the deferral was an empirical judgment that this signal duplicates information already in file-Jaccard for the most common cases.

A tiny commit (~<10 lines changed) following a large one is almost always a follow-up fix within the same iteration — shrink. Two large commits far apart in files → stretch.

### Review events (soft signal, not a hard boundary)

> **→ S3 status: deferred.** Read § "S3 implementation > What S3 ships vs. defers > Review events" before re-introducing — the deferral is *not* about the signal being weak; it's that S3 doesn't yet ingest aggregated review events from the GraphQL timeline. Wiring the input is a small backend addition that has to happen before this multiplier can light up.

Don't treat reviews as hard iteration boundaries — many real iterations happen with no review in between. But when a review does occur, the gap immediately following it should be stretched: the author is now responding to explicit feedback, which is exactly what "new iteration" usually means.

PR-level comments from the author themselves ("ready for another look", "PTAL") are surprisingly good iteration markers and worth treating the same way.

### Branch activity gaps

> **→ S3 status: deferred.** Read § "S3 implementation > What S3 ships vs. defers > Branch activity gaps" before re-introducing — the deferral is about the input cost (a separate REST call per PR for base-branch advance) rather than the signal's value.

If the author pushed to *other* branches during the gap, the idle time on this PR is "real" — they were working on something else and came back. Stretch. If they were entirely idle (no other commits in their public activity), the gap is more likely just sleep or a meeting and should not be stretched as aggressively.

## Concrete starting formula

```
multiplier = 1.0
           × (1 - 0.5 × files_jaccard)             // overlap shrinks (down to 0.5x)
           × (1 - 0.3 × message_continuity_score)  // continuity shrinks (down to 0.7x)
           × (1.5 if force_push_after_long_gap else 1.0)
           × (0.4 if tiny_followup_commit else 1.0)
           × (1.3 if review_event_in_between else 1.0)
           × (1.2 if branch_activity_elsewhere else 1.0)
```

Coefficients are starting points. They are interpretable enough to sanity-check by hand and can be tuned on 10-15 manually labeled PRs — no large training set needed.

## Edge cases and known failure modes

**Large refactors touching the same files repeatedly.** Path-level Jaccard saturates at 1.0 across every iteration, removing one of the strongest signals. Mitigation: hash at the symbol/function level using a parser (tree-sitter or Roslyn for C#) so "touched UserService.cs" doesn't dominate when iterations are actually working on different methods inside it. Likely overkill for v1, but it's the predictable failure mode.

**Squash-rebase workflows.** If the author squashes and force-pushes between iterations, the commit history may be rewritten such that early "iterations" no longer exist as commits. The PR's reflog (via the events API) can recover this if needed, but most teams accept that iteration detection runs on the current commit history.

**Single-commit PRs and very short PRs.** Algorithm should detect these and short-circuit — one iteration, no clustering needed.

**Very long-running PRs with stale early commits.** The hard ceiling on gap size handles most of these, but consider a UI affordance for collapsing iterations older than the most recent base-branch merge into the PR.

**Rebases onto updated main.** A rebase commit can look like a massive context switch (touches every file in the merge). Detect rebase/merge commits and exclude them from the distance computation — they are noise, not signal.

## Tuning approach

1. Pick 10–15 representative PRs across the team.
2. Manually annotate where iteration boundaries should be (developers usually agree within 1–2 boundaries per PR).
3. Compute weighted distances with the starting formula and a starting threshold.
4. Adjust coefficients to maximize agreement with hand labels. Because the formula is interpretable, individual misclassifications can be traced back to specific signals and the corresponding coefficient adjusted.
5. Lock the coefficients; let the per-PR adaptive threshold handle PR-to-PR variation.

## Output / integration shape

For each PR, the algorithm produces an ordered list of iterations:

```
Iteration 1: commits [SHA1, SHA2, SHA3], started 2024-03-12 09:14, ended 11:47
Iteration 2: commits [SHA4, SHA5],       started 2024-03-12 14:02, ended 14:38
Iteration 3: commits [SHA6],             started 2024-03-13 10:11, ended 10:11
```

Per iteration, the integrating feature can render:
- The cumulative diff vs. the iteration's starting state
- The list of files touched
- A short summary of changes (commit messages concatenated, or LLM-summarized)
- The "review-since-here" link a reviewer most likely wants

## Future extensions

- **Symbol-level diff hashing** for refactor-heavy PRs (Roslyn-based for C# given the stack).
- **Embedding-based message similarity** if keyword heuristics prove insufficient.
- **Per-iteration LLM summaries** describing intent rather than just listing changes.
- **Interactive threshold control** in the reviewer UI — the dendrogram from hierarchical clustering makes this near-free to implement. (Note: S3 ships MAD thresholding, not hierarchical clustering, so there is no dendrogram in the current implementation; interactive threshold control would either require a separate `IIterationClusteringStrategy` impl that produces one, or a different UI affordance built on the existing MAD output.)
- **Cross-PR learning** — if iteration boundaries on past merged PRs were validated by reviewers, those become labels for further coefficient tuning.

---

## S3 implementation

S3 narrows the canonical sketch above into a shippable algorithm. Where the canonical doc presents options, S3 picks one. Where it lists six signals, S3 implements two and defers four. This section documents the choices, the C# surface, and the calibration story.

### What S3 ships vs. defers

| Canonical signal | S3 status | Notes |
|---|---|---|
| File overlap (Jaccard on changed file paths) | **Live** as `FileJaccardMultiplier`. | Per-commit `changedFiles` fetched via REST `GET /repos/{o}/{r}/commits/{sha}` fan-out (concurrency cap 8, 100 ms inter-batch pace). GraphQL's `Commit` type does not expose changed-file paths. Bounded by `iterations.skip-jaccard-above-commit-count` (default 100). On 4xx from the fan-out, mark the commit's `changedFiles` as null, mark the session degraded, log a single warning, continue. |
| Force-push / rebase markers | **Live** as `ForcePushMultiplier`. | Treated strictly as a soft signal per the canonical doc — `1.5×` only when the force-push falls in `(c_i, c_{i+1}]` AND the gap exceeds `force-push-long-gap-seconds` (default 600 s); otherwise `1.0×`. Force-pushes with null `beforeSha`/`afterSha` (post-GC) are positioned by `occurredAt` with `max(0, occurredAt - prevCommit.committedDate)` clamping to defend against clock skew. |
| Commit message semantics | **Documented, not implemented.** | `MessageKeywordMultiplier` is a future addition (and may stay deferred indefinitely — see P0-8). S3 deferred it because team-specific message conventions vary widely and a generic keyword set is fragile; the most common case (`fixup!` / `squash!`) is captured by the existing time-gap + file-Jaccard signals. |
| Diff size / churn | **Documented, not implemented.** | `DiffSizeMultiplier` is a future addition (and may stay deferred indefinitely — see P0-8). Deferred because it duplicates information already in the file-Jaccard signal for the most common cases (a one-line fix usually touches a file the prior commit also touched). |
| Review events | **Documented, not implemented.** | `ReviewEventMultiplier` is a future addition (and may stay deferred indefinitely — see P0-8). Deferred because PRism doesn't yet ingest `ReviewEvents` from the GraphQL timeline (S3 fetches review *threads* and *root comments* but not aggregated review events); turning this on requires a small backend addition. |
| Branch activity gaps | **Documented, not implemented.** | `BranchActivityMultiplier` is a future addition (and may stay deferred indefinitely — see P0-8). Deferred because base-branch advance isn't fetched today and would require a separate REST call per PR. |

The strategy slot is purely additive: drop a new `IDistanceMultiplier` impl into `PRism.Core.Iterations`, register in DI via `AddPrismCore`, no change to `WeightedDistanceClusteringStrategy`. P0+ backlog items `P0-8` (flesh out remaining multipliers) and `P0-9` (calibration corpus + workflow) cover the lit-up future.

### Threshold choice: MAD, not Otsu

The canonical doc presented Otsu and MAD as two reasonable threshold options. **S3 picks MAD** for three reasons:

1. **Robustness to outliers.** A single anomalously long gap (e.g., the author left for the weekend) skews Otsu's bimodal-separation calculation; MAD's median-based statistic is unaffected by outliers in the upper tail.
2. **Interpretability.** `median + mad-k × MAD` reads as "anything more than `mad-k` MAD-units above the median is a boundary." A PR's `mad-k` directly governs cluster granularity in a way Otsu's bimodal separation does not.
3. **Cheap to compute.** MAD requires two sorts; Otsu requires histogram + variance scan over the bin range. The cost difference is negligible at PR commit counts but the simpler algorithm is easier to verify against hand-labels.

`MadThresholdComputer.Compute(weighted_d, k)` returns `median(weighted_d) + k × median(|d - median(d)|)`.

### Time field: `committedDate`, not author date

The canonical Step 2 says "order by author timestamp." **S3 uses `committedDate`** instead. Reason: `committedDate` is refreshed by `git commit --amend` and rebase, while `authoredDate` can lie about timeline position after history rewrites. For iteration clustering — which is fundamentally about *when the commits arrived in PR-relevant time*, not *when the author originally typed them* — the committer date is the more honest signal.

### Degenerate-case detector

The canonical doc's hard-floor / hard-ceiling clamping handles the obvious failure modes. S3 adds a per-PR **degenerate-case detector**: if more than `degenerate-floor-fraction` of the weighted distances are clamped to `hard-floor-seconds`, the PR's signal is too weak for MAD-based thresholding to mean anything. The strategy returns `null` and `PrDetailLoader` emits `ClusteringQuality: Low`.

The detector is **gated by `weighted_d.Length >= mad-k * 2`** so small-N tight-amend cases (3-5 commits with sub-floor gaps) don't spuriously trigger the fallback. The MAD path produces a single cluster correctly when all weighted distances are equal (no edge exceeds median + 1).

### `ClusteringQuality` enum and `CommitMultiSelectPicker` fallback

S3's `PrDetailSnapshot` carries a `ClusteringQuality` enum (`Ok` | `Low`). `Low` is emitted in three cases:

| Case | Trigger |
|---|---|
| 1-commit (or empty-beyond-base) PR | `PrDetailLoader` short-circuits before the strategy runs. |
| Per-PR degenerate signal | `WeightedDistanceClusteringStrategy` returns `null` after the degenerate-case detector fires. |
| Global calibration-failure escape hatch | `iterations.clustering-disabled = true` in production config (see below). |

The frontend reads `ClusteringQuality`:
- `Ok` → render `IterationTabStrip`.
- `Low` → render `CommitMultiSelectPicker` (a GitHub-style commit checklist instead of iteration tabs). Same UX for all three fallback cases — the user is never confused by the difference.

Wire format: kebab-case lowercase (`"ok"` | `"low"`) via `JsonStringEnumConverter`.

### Calibration-failure escape hatch (`clustering-disabled`)

`WeightedDistanceClusteringStrategy` ships **enabled by default** (`iterations.clustering-disabled = false`, the record-init default on `IterationsConfig`). Iterations render based on the algorithm's output; the calibration story (corpus, hand-labels, agreement %) governs *whether the operator should flip the flag to `true`*, not whether the algorithm runs at first launch. `clustering-disabled = true` is a manual escape hatch the operator turns on when the algorithm is producing iteration boundaries that disagree with reviewer judgment on real PRs — flipping it forces `PrDetailLoader` to emit `ClusteringQuality: Low` on every PR, falling back to `CommitMultiSelectPicker` (same UX as per-PR degenerate cases and 1-commit PRs).

This means S3 dogfoods clustering immediately on every PR. The risks the doc flags up-front (small corpora, signal-weak PRs, tight-amend chains) play out in production, and the operator can flip the escape hatch if the output is consistently bad. The earlier framing — that clustering ships disabled until calibration explicitly converges — was aspirational; the shipped default is enabled.

The discipline-check harness (`ClusteringDisciplineCheck` in `tests/PRism.Core.Tests/Iterations/`) is the calibration tool: see backlog item `P0-9` for the workflow that builds a corpus and tunes coefficients. **The harness body is currently a hard skip** (`Skip.If(true, "...awaits Task 3 IReviewService.GetTimelineAsync...")`) — the env-var dispatch shape is pinned but the timeline-fetch + boundary-diff logic lands with that task. Until that body lands, there is no measurable agreement-% gate; the operator's flip decision is judgment-based ("does this match my mental model on the PRs I care about?") rather than corpus-validated.

### Coefficient surface

`IterationClusteringCoefficients` is a record with the values below as record-init defaults. **In S3, the coefficients are constants per process lifetime** — `PRism.Core/ServiceCollectionExtensions.AddPrismCore` registers `new IterationClusteringCoefficients()` as a singleton. There is no `appsettings.json` binding and no `IOptionsMonitor` hot-reload for the coefficient block today; calibration changes require a code edit and a rebuild. Hot-reloadable config-driven coefficients are post-PoC scope (deferred behind P0-9 calibration; the moment a corpus exists, wiring `IOptionsMonitor<IterationClusteringCoefficients>` is the natural next step).

What *is* hot-reloadable today: `iterations.clustering-disabled` lives in `config.json` (managed by `IConfigStore`), and `PrDetailLoader.InvalidateAll` re-keys the cache on config change so a flip takes effect on the next PR-detail load without an app restart.

The shipping defaults — recorded once in `IterationClusteringCoefficients`'s record-init and once here in the spec for ease-of-reference:

```text
file-jaccard-weight:               0.5     // FileJaccardMultiplier signal weight. 0 = ignore; 1 = full overlap reduces distance to zero.
force-push-after-long-gap:         1.5     // ForcePushMultiplier value when both conditions are met.
force-push-long-gap-seconds:       600     // Below this gap, force-push is treated as a tight --amend (no expansion).
mad-k:                             3       // MAD threshold = median + mad-k × MAD.
hard-floor-seconds:                300     // Distance clamp floor (5 min — canonical doc's recommendation).
hard-ceiling-seconds:              259200  // Distance clamp ceiling (3 days — canonical doc's recommendation).
skip-jaccard-above-commit-count:   100     // Above this commit count, skip the per-commit changedFiles fan-out.
degenerate-floor-fraction:         0.5     // If more than this fraction of distances clamp to the floor, declare the PR's signal too weak.
```

The kebab-case names above are the names the future `appsettings.json` binding will use (matching the rest of the PRism config schema's kebab-case convention). Two of these — `degenerate-floor-fraction` and `skip-jaccard-above-commit-count` — are operational guards rather than tuning dials: changing them silently degrades quality without producing different iteration boundaries from a *signal* perspective. When the binding lands, consider keeping these two as constants and exposing only the six tuning coefficients to config.

### `IDistanceMultiplier` interface

The strategy slot:

```csharp
public interface IDistanceMultiplier
{
    /// <summary>Returns the multiplier in (0, ∞) for the gap between the two consecutive commits.</summary>
    /// Whole-input access is exposed (via `ClusteringInput input`) so multipliers can read
    /// PR-level signals like commit count for cap gates. The four documented future
    /// multipliers (message keywords, diff size, review events, branch activity) are all
    /// pair-local and ignore the wider input — but the signature does not enforce this.
    double For(
        ClusteringCommit prev,
        ClusteringCommit next,
        ClusteringInput input,
        IterationClusteringCoefficients coefficients);
}
```

`WeightedDistanceClusteringStrategy` calls `For` on every registered multiplier and multiplies the results into a single per-pair coefficient. Adding a new multiplier is purely additive — drop a class into `PRism.Core.Iterations`, register in DI, no strategy change.

### `PrDetailDto` (wire shape) and `PrDetailSnapshot` (cache wrapper)

The shape the algorithm's output reaches the frontend through is `PrDetailDto` — a wire DTO in `PRism.Core.Contracts`:

```csharp
public sealed record PrDetailDto(
    Pr Pr,
    ClusteringQuality ClusteringQuality,
    IReadOnlyList<IterationDto>? Iterations,        // null when ClusteringQuality is Low
    IReadOnlyList<CommitDto> Commits,               // always populated; picker reads this when Low
    IReadOnlyList<IssueCommentDto> RootComments,
    IReadOnlyList<ReviewThreadDto> ReviewComments,
    bool TimelineCapHit);
```

`PrDetailLoader` caches the DTO inside a `PrDetailSnapshot` wrapper that carries the cache key:

```csharp
public sealed record PrDetailSnapshot(
    PrDetailDto Detail,
    string HeadSha,                                 // mirrors Detail.Pr.HeadSha at fetch time; part of the cache key
    int CoefficientsGeneration);                    // bumps on PrDetailLoader.InvalidateAll so coefficient hot-reloads re-cluster
```

`IterationDto` and `CommitDto` are the wire-format representations of the strategy's domain types (`IterationCluster`, `ClusteringCommit`); the strategy operates on the domain types and `PrDetailLoader` projects to DTOs at the boundary. Both DTO types live in `PRism.Core.Contracts`.

### Edge-case behavior matrix

S3 implements the canonical edge cases plus a few implementation-specific ones:

| Case | S3 behavior |
|---|---|
| `Commits.Length == 0` | Zero iterations; "All changes" tab only; file tree renders empty-PR placeholder. |
| `Commits.Length == 1` | `PrDetailLoader` short-circuits to `ClusteringQuality: Low`; frontend renders `CommitMultiSelectPicker`. |
| All weighted distances equal | MAD threshold = median (no edge exceeds it); strategy emits a single cluster. Not a fallback path. |
| Small-N PR (`weighted_d.Length < mad-k * 2`, e.g., 3-5 commits) where most distances are equal but one is a small outlier (e.g., `[300, 300, 300, 300, 600]`) | Degenerate detector does not fire (gate `>= mad-k * 2` not met). MAD on the 4 floor-clamps = 0, so threshold = `median + 3*0 = 300`; the lone 600 distance exceeds it and produces a 2-cluster split. The doc's claim that "all-equal → single cluster" is true but does not cover this near-equal case. **Recovery:** the right-click "Merge with previous iteration" affordance handles it. **Code-side P0+ refinement to consider:** add a `MAD == 0` short-circuit that returns a single cluster regardless of N (or widen the degenerate-detector gate to catch small-N near-degenerate cases). |
| > `degenerate-floor-fraction` of distances clamped to `hard-floor-seconds` AND `weighted_d.Length >= mad-k * 2` | Strategy returns null; `PrDetailLoader` emits `ClusteringQuality: Low`. |
| `iterations.clustering-disabled = true` | `PrDetailLoader` emits `ClusteringQuality: Low` for every PR. |
| Malformed timeline event | Drop the event from `ClusteringInput`; log; continue. Never fails the page load. |
| Commit's `changedFiles` REST fan-out fails | Treat as unknown; `FileJaccardMultiplier` returns `1.0`. Mark session degraded; subsequent fan-outs skipped. |
| > `skip-jaccard-above-commit-count` commits | Skip per-commit fan-out entirely; `FileJaccardMultiplier` returns `1.0` for every pair. |
| `HeadRefForcePushedEvent.beforeCommit` / `afterCommit` is null (GC) | Position the force-push by `occurredAt`. `ForcePushMultiplier` still applies. |
| Negative `Δt` (clock skew) | Clamped to zero (`max(0, committedDate(c_{i+1}) - committedDate(c_i))`). |

The canonical doc's *Rebases onto updated main* edge case ("detect rebase/merge commits and exclude them") is **not** implemented in S3. Rebase commits flow through the algorithm with their massive Jaccard-disjoint signal, which the algorithm interprets as a likely iteration boundary — the same "this iteration includes a force-push; some changes may be upstream merges" banner that fires on every force-push iteration warns the reviewer (see `03-poc-features.md` § 3 "Iteration reconstruction"). A precise diff-from-author's-prior-changes computation via merge-base reconstruction is a v2 refinement, not a P0+ item.

### Discipline-check harness

The harness is `tests/PRism.Core.Tests/Iterations/ClusteringDisciplineCheck.cs`, an env-var-gated `[SkippableFact]`:

```powershell
$env:PRISM_DISCIPLINE_PR_REFS = "owner/repo/123,owner/repo/456,..."
dotnet test tests\PRism.Core.Tests --filter "FullyQualifiedName~ClusteringDisciplineCheck"
```

**Status today: the harness body is a hard skip.** `ClusteringDisciplineCheck.cs` short-circuits with `Skip.If(true, "...awaits Task 3 (IReviewService.GetTimelineAsync); the env-var dispatch shape is pinned, but execution will land with that task.")`. The env-var contract (`PRISM_DISCIPLINE_PR_REFS` as comma-separated `org/repo/number`) is locked, but the timeline-fetch + boundary-diff machinery is deferred. P0-9's first move is filling in this body and defining the sibling-JSON ground-truth format.

Once implemented, the harness will: for each PR ref, fetch the timeline, run `WeightedDistanceClusteringStrategy`, and emit a per-PR diff between computed boundaries and a hand-labeled ground-truth file (sibling JSON). Aggregate agreement % is the dial the calibration workflow uses to tune coefficients. Hand-labeling is the corpus-building work; the harness is the surface that exercises the algorithm against it.

---

## Open Questions

Findings raised during ce-doc-review that warrant design thought beyond a doc tweak. Each is *known but unresolved*; record an outcome here when one is reached so the next reader sees the resolution rather than re-discovering the question.

- **Behavior on > `skip-jaccard-above-commit-count` PRs.** The algorithm reduces to pure time-gap clustering above the cap (file-Jaccard returns 1.0; force-push only modulates rare boundaries). A 150-commit, 3-week PR with no force-pushes may produce 3 iterations or 30 depending on cadence variance. Should `PrDetailLoader` auto-emit `ClusteringQuality: Low` above the cap (consistent with the principle that *any* single-signal degraded mode = `Low`)? Decide alongside P0-9.
- **Tight rebase-onto-main miss.** A force-push within `force-push-long-gap-seconds` (default 600s) of the prior commit returns `ForcePushMultiplier = 1.0` even when the force-push is a rebase pulling in upstream changes. The tight-amend pattern and the tight-rebase-onto-new-main pattern look identical to the algorithm; only the second is meaningfully a new iteration. Recovery is manual-merge today. Future refinement: detect rebase-vs-amend by comparing the post-force-push commit's parent to the pre-force-push HEAD. If they differ, it's a rebase and the multiplier should expand regardless of gap.
- **Interactive-rebase `committedDate` collapse.** An interactive rebase that reorders 5 commits originally spread across days refreshes every committer date to within seconds of each other. The algorithm sees a tight cluster where the user's mental model has 5 iterations. The chosen `committedDate` is more honest than `authoredDate` for `--amend` chains but less honest for interactive-rebase reorderings. No clean fix; the manual-merge UI is the recovery. Document the tradeoff in the canonical "committedDate" choice if calibration shows this hits often.

---

## References

- [`docs/spec/03-poc-features.md`](./03-poc-features.md) § 3 "Iteration reconstruction" — UI surface that consumes the algorithm.
- [`docs/spec/00-verification-notes.md`](./00-verification-notes.md#c2) § C2 — why GraphQL `synchronize` events don't exist and where iteration boundaries actually come from.
- [`docs/spec/02-architecture.md`](./02-architecture.md) § "State schema (PoC)" — the `iterationOverrides` field that post-processes this algorithm's output.
- [`docs/specs/2026-05-06-s3-pr-detail-read-design.md`](../specs/2026-05-06-s3-pr-detail-read-design.md) § 6.4 — slice-implementation pseudocode (kept in lockstep with the `S3 implementation` section above).
- [`docs/backlog/01-P0-foundations.md`](../backlog/01-P0-foundations.md) § P0-8, § P0-9 — multiplier expansion and calibration workflow.
