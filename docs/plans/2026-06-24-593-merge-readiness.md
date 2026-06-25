# PR Merge-Readiness Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render a rich, color-coded merge-readiness badge on the inbox and PR-detail surfaces (open, non-draft PRs only), fix the stale merged-PR mergeability pill, fold in #516 (inbox PR number), and replace the PR-detail active poll's 3 REST calls/tick with one batched GraphQL/tick (epic #598 Slice B).

**Architecture:** Backend derives a precedence-resolved `MergeReadiness` enum in a pure `PRism.Core.Contracts` function (mirrors #532's `AwaitingAuthorRule`); the enum rides three existing DTOs (`PrInboxItem`, `Pr`, `ActivePrPollSnapshot`) via the global kebab-case `JsonStringEnumConverter`. The frontend owns color + copy through one shared label/color module and one shared `ReadinessBadge` component (with a badge-local accessible popover) used by both surfaces. Slice B adds a sibling batched-GraphQL active-poll reader that reuses the shared GraphQL transport + rate-limit model but has its own selection/parse.

**Tech Stack:** .NET 10 (C#, xUnit + FluentAssertions), React + Vite + TypeScript (vitest + React Testing Library), Playwright (CI-only visual baselines), GitHub GraphQL + REST.

## Global Constraints

- **Architecture C (spec §3):** backend derives the precedence-resolved enum; the frontend owns color + reason copy. The backend wire contract is a clean enum; defensive ("unrecognized → None") logic lives in the pure Core rule.
- **Open-PR-only badge (D5):** the badge renders **only** for open, non-draft PRs. `Merged`, `Closed`, `Draft`, and `None` (Unknown) render **no badge** on either surface. `Derive` still *returns* `Merged`/`Closed`/`None` honestly; the frontend renders nothing for them. This is the merged-PR fix.
- **Never cache `UNKNOWN` (D4):** GitHub computes `mergeable`/`mergeStateStatus` asynchronously; first read is often `UNKNOWN`/null. The rule maps those to `None`; the caller must not cache `None`-from-`UNKNOWN` (mirrors `GitHubCiFailingDetector`'s `Pending` rule). Resolves on the next tick when the viewer has push access; stays `None` permanently for no-push-access PRs (correct, cheap).
- **Label-always-visible (accessibility floor, WCAG 1.4.1):** on both surfaces the short text label is **always** rendered — never a bare color dot or icon-only mark. Color is reinforcement; the four color-identical yellow states are distinguishable by label alone. No label-less variant; labels never truncate to a shared prefix.
- **No new API calls for the tooltip (D7):** tooltip facts come only from data the fetch already returns (collapsed reviewer-decision counts from `latestReviews`, `updatedAt`). No ruleset reads (D2). No new round-trips.
- **CI stays a separate REST signal (D1):** the CI octicon is untouched in source/semantics; D6 only *repositions* it (mid-row → leading cluster). Merge-readiness does not subsume CI.
- **Reviewer counts come from collapsed `latestReviews`, never raw review history (spec §5):** raw `reviews(last:100).nodes` is full timeline and double-counts a reviewer who changed-then-approved. Count only `APPROVED`/`CHANGES_REQUESTED`, exclude `COMMENTED`/`DISMISSED`/`PENDING`.
- **Comment/review count parity (spec §9):** GraphQL `pullRequest.comments.totalCount` is the WRONG field (issue-level timeline). Map review-comment count from `reviewThreads` / `Σ reviews.nodes.comments.totalCount` to equal REST `pulls/{n}/comments` (inline review comments); review count from `reviews.totalCount`.
- **Whole-tick-abort retains last-known (spec §7):** because Slice B issues one query for all subscribed PRs, a rate-limited/aborted tick must never blank the badge/counts — retain last-known and resume next tick. The SSE consumer must not clear readiness on a skipped tick.
- **Enum wire form:** enums serialize kebab-case automatically via `JsonSerializerOptionsFactory.Api`'s `JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())`. No per-enum attributes. The TS union must match the kebab forms exactly.
- **Gated B1 — UI-visual:** color coding is validated live in **both** light and dark themes before lock (Playwright CI baselines + 1px-canvas WCAG checks). Inbox visual change → parity-baseline regen.
- **One PR with carve-out fallback (spec §11, owner-confirmed):** ships as one PR by default; Tasks 1–6 must reach green *independently* of Task 7 (Slice B) so Slice B can be carved into a follow-up perf-only PR if it lags. The badge ships on the existing REST poll with the additive field. **For the carve-out to actually compile, the `mergeReadiness?` stub on the `ActivePrUpdates` interface lands in Task 6 (not Task 7)** — see Task 6 Step 1; without it Tasks 1–6 don't typecheck.
- **Pre-push checklist (`.ai/docs/development-process.md`) runs verbatim before any push.** Run `/simplify` before raising the PR.

## File Structure

**Backend — new files:**
- `PRism.Core.Contracts/MergeReadiness.cs` — the `MergeReadiness` enum (11 members).
- `PRism.Core.Contracts/MergeReadinessRule.cs` — pure `Derive(...)` precedence function.
- `PRism.Core/PrDetail/IActivePrBatchReader.cs` — the batched-poll reader **interface** (lives in Core, mirroring `PRism.Core/Inbox/IPrBatchReader.cs`; the poller in Core consumes it — Core does **not** reference PRism.GitHub, so the interface cannot live in the GitHub assembly).
- `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs` — the **implementation** `: IActivePrBatchReader` (Slice B).
- `tests/PRism.Core.Tests/Contracts/MergeReadinessRuleTests.cs` — exhaustive rule matrix.
- `tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs` — batched-poll reader tests (shape, derivation, count parity, whole-tick-abort, rate-limit, per-alias isolation).
- `tests/PRism.Core.Tests/PrDetail/ActivePrPollerReadinessTests.cs` — new poller tests (readiness publish, whole-tick-abort, open→merged transition).

**Backend — modified files:**
- `PRism.Core.Contracts/PrStates.cs` — add `FromTimestamps(mergedAt, closedAt)` helper.
- `PRism.Core.Contracts/PrInboxItem.cs` — add `MergeReadiness MergeReadiness` + nullable tooltip counts.
- `PRism.Core/Inbox/RawPrInboxItem.cs` — add `MergeReadiness MergeReadiness` + nullable counts (carriers).
- `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` — extend query (`mergeable mergeStateStatus reviewDecision isDraft latestReviews`); parse + derive; carry counts.
- `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` — thread the carried readiness/counts through the `with`-merge into `MaterializePrInboxItem`.
- `PRism.Core.Contracts/Pr.cs` — add `MergeReadiness MergeReadiness`, nullable counts, `UpdatedAt`.
- `PRism.Core/Inbox/IPrBatchReader.cs` — extend the `BatchPrData` record (it lives here, **not** in `GitHubPrBatchReader.cs`) with the readiness/count carriers.
- `PRism.GitHub/GitHubReviewService.cs` — `PrDetailGraphQLQuery` (+ `reviewDecision updatedAt latestReviews`); Slice B tick wiring; DI of the new reader.
- `PRism.GitHub/GitHubPrParser.cs` — `ParsePr` derives `MergeReadiness`, counts, `UpdatedAt`; **owns** the shared `internal static CountLatestReviews` collapsed-count helper (single home; the inbox batch reader calls it — no temporary duplicate).
- `PRism.GitHub/GitHubGraphQL.cs` — extract a shared `internal static ThrowIfRateLimited(JsonElement, string)` guard (used by both batch readers; `GitHubGraphQL` is an `internal static` class, so `internal`, not `public`).
- `PRism.Core.Contracts/ActivePrPollSnapshot.cs` — add `MergeReadiness MergeReadiness` + nullable counts.
- `PRism.Core/PrDetail/ActivePrPoller.cs` — batched tick; `readinessChanged` publish trigger (with anti-flicker None guard); `LastMergeReadiness` state; whole-tick-abort.
- `PRism.Core/Events/ActivePrUpdated.cs` (event) — add `MergeReadiness` + nullable counts.
- `PRism.Web/Sse/SseEventProjection.cs` — `ActivePrUpdatedWire` carries readiness + counts (verify the SSE channel serializes the enum kebab-case via `JsonSerializerOptionsFactory.Api`, not as an int).
- `PRism.GitHub/ServiceCollectionExtensions.cs` — register `IActivePrBatchReader` → `GitHubActivePrBatchReader`.
- `tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs` + `ActivePrPollerBackoffTests.cs` + `ActivePrPollerSnapshotLogTests.cs` + `ActivePrPollerSubscriberFaultTests.cs` — migrate to the batched-reader ctor (Task 7).
- `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` — update the pinned `ExpectedPrDetail` literal to the new query (Task 5).

**Frontend — new files:**
- `frontend/src/components/shared/mergeReadiness.ts` — the `MergeReadiness` TS union + short/long/tooltip/chip-class maps + `isBadgeRendered`.
- `frontend/src/components/shared/ReadinessBadge.tsx` — shared badge + badge-local popover.
- `frontend/src/components/shared/ReadinessBadge.module.css` — popover, dot, trigger styles.
- `frontend/src/components/shared/ReadinessTooltipContext.tsx` — singleton open-id context.

**Frontend — modified files:**
- `frontend/src/styles/tokens.css` — `.chip-readiness-*` (8 open states) + `--readiness-ready-caveat-soft` (both themes).
- `frontend/src/api/types.ts` — `mergeReadiness` + nullable counts on `PrInboxItem` & `PrDetailPr`; readiness on the SSE update shape.
- `frontend/src/components/Inbox/InboxRow.tsx` + `InboxRow.module.css` — CI relocation + fixed CI slot, `#N`, readiness badge in `.tail`.
- `frontend/src/components/PrDetail/PrHeader.tsx` — replace bare mergeability chip with the expanded badge.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — pass `mergeReadiness` (live ?? load) to `PrHeader`.
- `frontend/src/hooks/useActivePrUpdates.ts` — thread `mergeReadiness` from `pr-updated`.
- `frontend/e2e/parity-baselines.spec.ts` (+ a new readiness visual spec) — B1 screenshots.
- App root (where providers nest, e.g. `PrismApp.tsx`) — wrap with `ReadinessTooltipProvider`.

---

### Task 1: `MergeReadiness` enum + pure `Derive` rule + frontend label/color module

The shared vocabulary both UI tasks reference. Backend rule + exhaustive tests, and the frontend module of short/long/tooltip/chip-class maps. No UI yet.

**Files:**
- Create: `PRism.Core.Contracts/MergeReadiness.cs`
- Create: `PRism.Core.Contracts/MergeReadinessRule.cs`
- Create: `tests/PRism.Core.Tests/Contracts/MergeReadinessRuleTests.cs`
- Create: `frontend/src/components/shared/mergeReadiness.ts`
- Test: `frontend/src/components/shared/mergeReadiness.test.ts`

**Interfaces:**
- Produces (backend): `enum MergeReadiness { None, Merged, Closed, Conflicts, BehindBase, ChangesRequested, ReviewRequired, BlockedByProtection, Unstable, ReadyWithChangesRequested, Ready }` and `static MergeReadiness MergeReadinessRule.Derive(PrState state, bool isDraft, string? mergeable, string? mergeStateStatus, string? reviewDecision)`.
- Produces (frontend): `type MergeReadiness` (kebab union), `READINESS_SHORT`, `READINESS_LONG`, `READINESS_TOOLTIP`, `READINESS_CHIP_CLASS` maps, `isBadgeRendered(r: MergeReadiness): boolean`.
- Consumes: `PrState` (existing, `PRism.Core.Contracts`).

- [ ] **Step 1: Write the failing rule test**

Create `tests/PRism.Core.Tests/Contracts/MergeReadinessRuleTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.Core.Tests.Contracts;

public sealed class MergeReadinessRuleTests
{
    // Terminal states win over every merge signal (the merged-PR fix, by construction).
    [Theory]
    [InlineData(PrState.Merged, "CONFLICTING", "DIRTY", "CHANGES_REQUESTED", MergeReadiness.Merged)]
    [InlineData(PrState.Merged, "MERGEABLE", "CLEAN", "APPROVED", MergeReadiness.Merged)]
    [InlineData(PrState.Closed, "CONFLICTING", "DIRTY", null, MergeReadiness.Closed)]
    public void Terminal_state_wins(PrState state, string? mergeable, string? mss, string? rd, MergeReadiness expected)
        => MergeReadinessRule.Derive(state, isDraft: false, mergeable, mss, rd).Should().Be(expected);

    // Draft -> None regardless of signals (badge renders nothing).
    [Theory]
    [InlineData(true, "CLEAN", "APPROVED")]
    [InlineData(false, "DRAFT", null)] // mergeStateStatus == DRAFT
    public void Draft_is_none(bool isDraft, string mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, isDraft, "MERGEABLE", mss, rd).Should().Be(MergeReadiness.None);

    // Conflicts dominate every weaker mergeStateStatus (cross-axis matrix, spec §4/§10).
    [Theory]
    [InlineData("CONFLICTING", "BEHIND")]
    [InlineData("CONFLICTING", "BLOCKED")]
    [InlineData("CONFLICTING", "UNSTABLE")]
    [InlineData("CONFLICTING", "CLEAN")]
    [InlineData("CONFLICTING", "UNKNOWN")]
    [InlineData("MERGEABLE", "DIRTY")]
    public void Conflicts_dominate(string mergeable, string mss)
        => MergeReadinessRule.Derive(PrState.Open, false, mergeable, mss, null).Should().Be(MergeReadiness.Conflicts);

    [Fact]
    public void Behind_base()
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "BEHIND", null).Should().Be(MergeReadiness.BehindBase);

    // BLOCKED granularity is the review/protection axis.
    [Theory]
    [InlineData("CHANGES_REQUESTED", MergeReadiness.ChangesRequested)]
    [InlineData("REVIEW_REQUIRED", MergeReadiness.ReviewRequired)]
    [InlineData("APPROVED", MergeReadiness.BlockedByProtection)]
    [InlineData(null, MergeReadiness.BlockedByProtection)]
    public void Blocked_splits_on_review_decision(string? rd, MergeReadiness expected)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "BLOCKED", rd).Should().Be(expected);

    [Fact]
    public void Unstable()
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", "UNSTABLE", null).Should().Be(MergeReadiness.Unstable);

    // Clean + a reviewer requested changes (protection doesn't require review) -> dimmed-green variant.
    [Theory]
    [InlineData("CLEAN")]
    [InlineData("HAS_HOOKS")]
    public void Ready_with_changes_requested(string mss)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", mss, "CHANGES_REQUESTED")
            .Should().Be(MergeReadiness.ReadyWithChangesRequested);

    [Theory]
    [InlineData("CLEAN", "APPROVED")]
    [InlineData("CLEAN", null)]
    [InlineData("HAS_HOOKS", "REVIEW_REQUIRED")] // clean + no block -> Ready (review not required by protection)
    public void Ready(string mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, false, "MERGEABLE", mss, rd).Should().Be(MergeReadiness.Ready);

    // Unknown / null / unrecognized -> None, never throw.
    [Theory]
    [InlineData("UNKNOWN", null)]
    [InlineData(null, null)]
    [InlineData("SOMETHING_NEW", "ALSO_NEW")]
    [InlineData("UNKNOWN", "UNKNOWN")]
    public void Unknown_is_none(string? mss, string? rd)
        => MergeReadinessRule.Derive(PrState.Open, false, "UNKNOWN", mss, rd).Should().Be(MergeReadiness.None);

    // Case-insensitivity (REST mergeable_state is lowercase).
    [Fact]
    public void Case_insensitive()
        => MergeReadinessRule.Derive(PrState.Open, false, "mergeable", "clean", "approved").Should().Be(MergeReadiness.Ready);

    // Kebab-case wire form via the global converter.
    [Theory]
    [InlineData(MergeReadiness.BehindBase, "\"behind-base\"")]
    [InlineData(MergeReadiness.ReadyWithChangesRequested, "\"ready-with-changes-requested\"")]
    [InlineData(MergeReadiness.None, "\"none\"")]
    public void Serializes_kebab_case(MergeReadiness value, string expectedJson)
        => System.Text.Json.JsonSerializer.Serialize(value, PRism.Core.Json.JsonSerializerOptionsFactory.Api)
            .Should().Be(expectedJson);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~MergeReadinessRuleTests`
Expected: FAIL — `MergeReadiness` / `MergeReadinessRule` do not exist (compile error).

- [ ] **Step 3: Create the enum**

Create `PRism.Core.Contracts/MergeReadiness.cs`:

```csharp
namespace PRism.Core.Contracts;

// Precedence-resolved merge-readiness of a PR, derived server-side from GitHub's
// mergeable / mergeStateStatus / reviewDecision signals (see MergeReadinessRule).
// Serializes kebab-case ("behind-base", "ready-with-changes-requested", ...) via the
// global JsonStringEnumConverter(KebabCaseJsonNamingPolicy) on JsonSerializerOptionsFactory.Api.
// `None` is the zero value: Draft / Unknown / null / unrecognized / no-push-access all map
// here, and the frontend renders NO badge for None/Merged/Closed (open-PR-only badge, D5).
public enum MergeReadiness
{
    None,
    Merged,
    Closed,
    Conflicts,
    BehindBase,
    ChangesRequested,
    ReviewRequired,
    BlockedByProtection,
    Unstable,
    ReadyWithChangesRequested,
    Ready,
}
```

- [ ] **Step 4: Create the rule**

Create `PRism.Core.Contracts/MergeReadinessRule.cs`:

```csharp
namespace PRism.Core.Contracts;

// Pure precedence resolver (spec §4). All raw GitHub enum inputs are nullable strings
// compared case-insensitively; unrecognized values fall through to None (never throw —
// these GitHub fields are semi-documented and in flux). Mirrors AwaitingAuthorRule:
// stateless, single responsibility, exhaustively unit-tested.
public static class MergeReadinessRule
{
    public static MergeReadiness Derive(
        PrState state,
        bool isDraft,
        string? mergeable,        // MERGEABLE | CONFLICTING | UNKNOWN | null
        string? mergeStateStatus, // CLEAN|DIRTY|BEHIND|BLOCKED|UNSTABLE|HAS_HOOKS|DRAFT|UNKNOWN|null
        string? reviewDecision)   // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
    {
        // 1-2: terminal states win over every merge signal (fixes the stale merged-PR pill by construction).
        if (state == PrState.Merged) return MergeReadiness.Merged;
        if (state == PrState.Closed) return MergeReadiness.Closed;

        // 3: draft -> None (the PR-state glyph carries draft; badge renders nothing).
        if (isDraft || Eq(mergeStateStatus, "DRAFT")) return MergeReadiness.None;

        // 4: conflicts dominate any weaker mergeStateStatus (mergeable == CONFLICTING is an independent source).
        if (Eq(mergeStateStatus, "DIRTY") || Eq(mergeable, "CONFLICTING")) return MergeReadiness.Conflicts;

        // 5: out of date with base.
        if (Eq(mergeStateStatus, "BEHIND")) return MergeReadiness.BehindBase;

        // 6-8: BLOCKED granularity comes from reviewDecision (D1/D2: no ruleset reads, CI is its own dot).
        if (Eq(mergeStateStatus, "BLOCKED"))
        {
            if (Eq(reviewDecision, "CHANGES_REQUESTED")) return MergeReadiness.ChangesRequested;
            if (Eq(reviewDecision, "REVIEW_REQUIRED")) return MergeReadiness.ReviewRequired;
            return MergeReadiness.BlockedByProtection; // approved/null -> required check or other protection
        }

        // 9: checks unstable.
        if (Eq(mergeStateStatus, "UNSTABLE")) return MergeReadiness.Unstable;

        // 10-11: clean family. A reviewer's open change-request on a clean PR (protection doesn't
        // require review) stays green-family but flags the caveat.
        if (Eq(mergeStateStatus, "CLEAN") || Eq(mergeStateStatus, "HAS_HOOKS"))
        {
            return Eq(reviewDecision, "CHANGES_REQUESTED")
                ? MergeReadiness.ReadyWithChangesRequested
                : MergeReadiness.Ready;
        }

        // 12: UNKNOWN / null / unrecognized / no-push-access -> None.
        return MergeReadiness.None;
    }

    private static bool Eq(string? value, string token)
        => string.Equals(value, token, System.StringComparison.OrdinalIgnoreCase);
}
```

- [ ] **Step 5: Run the rule test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~MergeReadinessRuleTests`
Expected: PASS (all theories green).

- [ ] **Step 6: Write the failing frontend module test**

Create `frontend/src/components/shared/mergeReadiness.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  READINESS_SHORT,
  READINESS_LONG,
  READINESS_TOOLTIP,
  READINESS_CHIP_CLASS,
  isBadgeRendered,
  type MergeReadiness,
} from './mergeReadiness';

const OPEN_STATES: MergeReadiness[] = [
  'conflicts',
  'behind-base',
  'changes-requested',
  'review-required',
  'blocked-by-protection',
  'unstable',
  'ready-with-changes-requested',
  'ready',
];

describe('mergeReadiness module', () => {
  it('renders a badge only for the 8 open states', () => {
    for (const s of OPEN_STATES) expect(isBadgeRendered(s)).toBe(true);
    for (const s of ['none', 'merged', 'closed'] as MergeReadiness[]) expect(isBadgeRendered(s)).toBe(false);
  });

  it('has a non-empty short, long, tooltip, and chip class for every open state', () => {
    for (const s of OPEN_STATES) {
      expect(READINESS_SHORT[s]).toBeTruthy();
      expect(READINESS_LONG[s]).toBeTruthy();
      expect(READINESS_TOOLTIP[s]).toBeTruthy();
      expect(READINESS_CHIP_CLASS[s]).toMatch(/^chip-readiness-/);
    }
  });

  it('gives the four yellow states distinct short labels with no shared prefix', () => {
    const yellow = ['behind-base', 'review-required', 'blocked-by-protection', 'unstable'] as MergeReadiness[];
    const shorts = yellow.map((s) => READINESS_SHORT[s]);
    expect(new Set(shorts).size).toBe(4);
    // No two share a leading word that truncation could collapse.
    const firstWords = shorts.map((t) => t.split(' ')[0].toLowerCase());
    expect(new Set(firstWords).size).toBe(4);
  });
});
```

- [ ] **Step 7: Run the frontend test to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/shared/mergeReadiness.test.ts`
Expected: FAIL — module not found.
(Note from repo memory: invoke the local vitest binary, not a globally cached one, if `npx vitest` misbehaves: `./node_modules/.bin/vitest run ...`.)

- [ ] **Step 8: Create the frontend module**

Create `frontend/src/components/shared/mergeReadiness.ts`:

```ts
// Frontend-owned presentation for the backend-derived MergeReadiness enum (architecture C).
// The union MUST match the kebab-case wire form emitted by JsonStringEnumConverter.
export type MergeReadiness =
  | 'none'
  | 'merged'
  | 'closed'
  | 'conflicts'
  | 'behind-base'
  | 'changes-requested'
  | 'review-required'
  | 'blocked-by-protection'
  | 'unstable'
  | 'ready-with-changes-requested'
  | 'ready';

// The 8 open states that render a badge (none/merged/closed render nothing — D5).
export function isBadgeRendered(r: MergeReadiness): boolean {
  return r !== 'none' && r !== 'merged' && r !== 'closed';
}

// Compact inbox label.
export const READINESS_SHORT: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Conflicts',
  'behind-base': 'Behind',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  'blocked-by-protection': 'Blocked',
  unstable: 'Unstable',
  'ready-with-changes-requested': 'Ready (changes)',
  ready: 'Ready',
};

// Expanded PR-detail reason.
export const READINESS_LONG: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Has conflicts',
  'behind-base': 'Out of date with base',
  'changes-requested': 'Changes requested',
  'review-required': 'Review required',
  'blocked-by-protection': 'Blocked by branch protection',
  unstable: 'Checks unstable',
  'ready-with-changes-requested': 'Ready — changes requested',
  ready: 'Ready to merge',
};

// Tooltip one-line explanation (spec §6 table).
export const READINESS_TOOLTIP: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'Resolve merge conflicts to continue.',
  'behind-base': 'Update this branch with its base before merging.',
  'changes-requested': 'A reviewer requested changes.',
  'review-required': 'Waiting on a required approving review.',
  'blocked-by-protection': 'A branch-protection rule is not yet satisfied.',
  unstable: "Required checks haven't all passed yet.",
  'ready-with-changes-requested': 'Mergeable, but a reviewer requested changes.',
  ready: 'This PR can be merged.',
};

// Global chip class (defined in tokens.css, Task 4). Shared by both surfaces.
export const READINESS_CHIP_CLASS: Record<MergeReadiness, string> = {
  none: '',
  merged: '',
  closed: '',
  conflicts: 'chip-readiness-conflicts',
  'behind-base': 'chip-readiness-behind-base',
  'changes-requested': 'chip-readiness-changes-requested',
  'review-required': 'chip-readiness-review-required',
  'blocked-by-protection': 'chip-readiness-blocked-by-protection',
  unstable: 'chip-readiness-unstable',
  'ready-with-changes-requested': 'chip-readiness-ready-with-changes-requested',
  ready: 'chip-readiness-ready',
};
```

- [ ] **Step 9: Run the frontend test to verify it passes**

Run (from `frontend/`): `npx vitest run src/components/shared/mergeReadiness.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add PRism.Core.Contracts/MergeReadiness.cs PRism.Core.Contracts/MergeReadinessRule.cs \
  tests/PRism.Core.Tests/Contracts/MergeReadinessRuleTests.cs \
  frontend/src/components/shared/mergeReadiness.ts frontend/src/components/shared/mergeReadiness.test.ts
git commit -m "feat(593): add MergeReadiness enum, pure Derive rule, and frontend label/color module"
```

---

### Task 2: Inbox feed — derive readiness in the batch reader, expose on `PrInboxItem`

Extend the #532 inbox batch GraphQL query with the readiness scalars + collapsed `latestReviews`, derive in the parse path, carry through to the wire DTO.

**Files:**
- Modify: `PRism.Core.Contracts/PrStates.cs` (add `FromTimestamps`)
- Modify: `PRism.Core/Inbox/RawPrInboxItem.cs` (carriers)
- Modify: `PRism.Core.Contracts/PrInboxItem.cs` (wire fields)
- Modify: `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` (query + parse + derive)
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (thread through materialize)
- Test: `tests/PRism.Core.Tests/Contracts/PrStatesTests.cs`, `tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs`

**Interfaces:**
- Consumes: `MergeReadinessRule.Derive`, `MergeReadiness` (Task 1).
- Produces: `PrStates.FromTimestamps(DateTimeOffset? mergedAt, DateTimeOffset? closedAt) -> PrState`; `PrInboxItem.MergeReadiness`, `PrInboxItem.Approvals` (`int?`), `PrInboxItem.ChangesRequested` (`int?`); `RawPrInboxItem.MergeReadiness/Approvals/ChangesRequested` carriers.

- [ ] **Step 1: Write the failing `FromTimestamps` test**

Add to `tests/PRism.Core.Tests/Contracts/PrStatesTests.cs`:

```csharp
[Fact]
public void FromTimestamps_open_when_both_null()
    => PrStates.FromTimestamps(null, null).Should().Be(PrState.Open);

[Fact]
public void FromTimestamps_merged_wins_over_closed()
    => PrStates.FromTimestamps(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow).Should().Be(PrState.Merged);

[Fact]
public void FromTimestamps_closed_when_only_closed_set()
    => PrStates.FromTimestamps(null, DateTimeOffset.UtcNow).Should().Be(PrState.Closed);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~PrStatesTests.FromTimestamps`
Expected: FAIL — `FromTimestamps` does not exist.

- [ ] **Step 3: Add `FromTimestamps`**

In `PRism.Core.Contracts/PrStates.cs`, add to the `PrStates` class:

```csharp
// Reconstructs PR lifecycle state from the only signals an inbox row carries (no raw
// `state` string is fetched for inbox). Merged wins over Closed (a merged PR also has a
// closedAt on some payloads); both null -> Open.
public static PrState FromTimestamps(DateTimeOffset? mergedAt, DateTimeOffset? closedAt)
    => mergedAt.HasValue ? PrState.Merged
     : closedAt.HasValue ? PrState.Closed
     : PrState.Open;
```

- [ ] **Step 4: Run it to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~PrStatesTests.FromTimestamps`
Expected: PASS.

- [ ] **Step 5: Add carrier fields to `RawPrInboxItem`**

In `PRism.Core/Inbox/RawPrInboxItem.cs`, append three optional positional params (after `Description`), and add the `using`:

```csharp
using PRism.Core.Contracts; // already present
...
public sealed record RawPrInboxItem(
    // ... existing params unchanged ...
    string? Description = null,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null);
```

- [ ] **Step 6: Add wire fields to `PrInboxItem`**

In `PRism.Core.Contracts/PrInboxItem.cs`, append three optional positional params (after `Description`):

```csharp
public sealed record PrInboxItem(
    // ... existing params unchanged ...
    [property: JsonIgnore] string? Description = null,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null);
```

- [ ] **Step 7: Write the failing batch-reader test**

Add to `tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs` (mirror the existing GraphQL-response fixture style in that file — a stubbed `HttpMessageHandler` returning a canned GraphQL body; reuse the file's existing helper if present):

```csharp
[Fact]
public async Task Derives_merge_readiness_and_collapsed_review_counts_per_alias()
{
    // A clean, mergeable PR where one reviewer changed-then-approved (must collapse to 1 approval, 0 changes)
    // and another requested changes -> reviewDecision CHANGES_REQUESTED on a CLEAN PR -> ReadyWithChangesRequested.
    const string body = """
    { "data": {
        "a0": { "pullRequest": {
            "headRefOid": "deadbeef", "additions": 1, "deletions": 0, "changedFiles": 1,
            "commits": { "totalCount": 1 }, "mergedAt": null, "closedAt": null,
            "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "CHANGES_REQUESTED",
            "headRepository": { "pushedAt": "2026-06-24T00:00:00Z" },
            "reviews": { "nodes": [] },
            "latestReviews": { "nodes": [
                { "author": { "login": "alice" }, "state": "APPROVED" },
                { "author": { "login": "bob" }, "state": "CHANGES_REQUESTED" }
            ] }
        } },
        "rateLimit": { "cost": 1, "remaining": 4999 } } }
    """;
    var reader = NewReaderReturning(body); // existing test helper pattern in this suite
    var raw = NewRawItem(number: 1);       // existing test helper; IsDraft=false

    var result = await reader.HydrateAsync(new[] { raw }, "viewer", CancellationToken.None);

    var item = result.Single();
    item.MergeReadiness.Should().Be(MergeReadiness.ReadyWithChangesRequested);
    item.Approvals.Should().Be(1);
    item.ChangesRequested.Should().Be(1);
}
```

(If the suite's reader entry point / helper names differ — e.g. the method is not `HydrateAsync` — use the actual names already exercised in `GitHubPrBatchReaderTests.cs`; the assertion targets are what matter.)

- [ ] **Step 8: Run it to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubPrBatchReaderTests.Derives_merge_readiness`
Expected: FAIL — fields not parsed/derived; `MergeReadiness` stays `None`.

- [ ] **Step 9: Extend the GraphQL query**

In `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` `BuildQuery`, extend the per-alias `pullRequest` selection (the `.Append("{ headRefOid ... reviews(last:100){...} } } } ")` chain) to add the readiness scalars and the collapsed `latestReviews` connection:

```csharp
.Append("{ headRefOid additions deletions changedFiles commits{ totalCount } ")
.Append("mergedAt closedAt isDraft mergeable mergeStateStatus reviewDecision ")
.Append("headRepository{ pushedAt } ")
.Append("reviews(last:100){ nodes{ author{ login } submittedAt commit{ oid } } } ")
.Append("latestReviews(first:100){ nodes{ author{ login } state } } } } } ");
```

- [ ] **Step 10: Parse + derive in `TryParse`**

In `GitHubPrBatchReader.TryParse`, after `mergedAt`/`closedAt` are parsed, read the new scalars, derive readiness, and count collapsed reviews; extend `BatchPrData` with the three new fields. Add a private counter helper:

```csharp
// inside TryParse, after closedAt:
var isDraft = pr.TryGetProperty("isDraft", out var dr) && dr.ValueKind == JsonValueKind.True;
var mergeable = pr.TryGetProperty("mergeable", out var mg) && mg.ValueKind == JsonValueKind.String ? mg.GetString() : null;
var mergeStateStatus = pr.TryGetProperty("mergeStateStatus", out var mss) && mss.ValueKind == JsonValueKind.String ? mss.GetString() : null;
var reviewDecision = pr.TryGetProperty("reviewDecision", out var rdv) && rdv.ValueKind == JsonValueKind.String ? rdv.GetString() : null;

var prState = PrStates.FromTimestamps(mergedAt, closedAt);
var readiness = MergeReadinessRule.Derive(prState, isDraft, mergeable, mergeStateStatus, reviewDecision);
var (approvals, changesRequested) = GitHubPrParser.CountLatestReviews(pr); // single home — see below

data = new BatchPrData(headSha, additions, deletions, commitCount, changedFiles,
                       pushedAt, mergedAt, closedAt,
                       ParseViewerLastReviewSha(pr, viewerLogin, raw.Reference),
                       readiness, approvals, changesRequested);
return true;
```

**Define the collapsed-count helper once, in `GitHubPrParser` (its single home — both the inbox batch reader here and the detail parser in Task 5 call it; no duplicate).** Add to `PRism.GitHub/GitHubPrParser.cs` as `internal static` (counts only `APPROVED`/`CHANGES_REQUESTED` from the already-collapsed `latestReviews`; returns `(null, null)` when the connection is absent so the FE suppresses the tooltip line for review-only PRs):

```csharp
internal static (int? Approvals, int? ChangesRequested) CountLatestReviews(JsonElement pr)
{
    if (!pr.TryGetProperty("latestReviews", out var lr)
        || !lr.TryGetProperty("nodes", out var nodes)
        || nodes.ValueKind != JsonValueKind.Array)
        return (null, null);

    int approvals = 0, changes = 0;
    foreach (var n in nodes.EnumerateArray())
    {
        if (n.ValueKind != JsonValueKind.Object) continue;
        var state = n.TryGetProperty("state", out var s) && s.ValueKind == JsonValueKind.String ? s.GetString() : null;
        if (string.Equals(state, "APPROVED", StringComparison.Ordinal)) approvals++;
        else if (string.Equals(state, "CHANGES_REQUESTED", StringComparison.Ordinal)) changes++;
        // COMMENTED / DISMISSED / PENDING excluded.
    }
    return (approvals, changes);
}
```

Extend the `BatchPrData` record — which lives in **`PRism.Core/Inbox/IPrBatchReader.cs`** (not `GitHubPrBatchReader.cs`) — with `MergeReadiness MergeReadiness, int? Approvals, int? ChangesRequested`.

- [ ] **Step 11: Thread through the orchestrator**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, at the site where `BatchPrData` is merged onto the raw item via `with` (the existing `raw with { Additions = data.Additions, HeadSha = data.HeadSha, ... }` expression), add:

```csharp
MergeReadiness = data.MergeReadiness,
Approvals = data.Approvals,
ChangesRequested = data.ChangesRequested,
```

Then in `MaterializePrInboxItem`, pass the carriers into the `PrInboxItem` constructor:

```csharp
MergeReadiness: r.MergeReadiness,
Approvals: r.Approvals,
ChangesRequested: r.ChangesRequested,
```

(`UpdatedAt` is **already** a member of `RawPrInboxItem`/`PrInboxItem` and `MaterializePrInboxItem` already passes it through — no change needed; the badge's "Updated Xh ago" fact reads the existing `pr.updatedAt`. The TS `PrInboxItem` likewise already has `updatedAt: string`. Do not re-add it.)

**Also publish on readiness flips.** `InboxRefreshOrchestrator.ComputeDiff` currently decides whether to emit `InboxUpdated` from `HeadSha`/`CommentCount`/`Ci` only (`if (o.HeadSha != n.HeadSha || o.CommentCount != n.CommentCount || o.Ci != n.Ci)`). GitHub recomputes `mergeStateStatus` asynchronously **without bumping `updatedAt`**, so a readiness-only flip (e.g. `UNKNOWN`→`CLEAN`, or a conflict resolving) would update the cached snapshot but never push `InboxUpdated` — the inbox badge would stay stale until an unrelated field changes (the same class of bug as the known sync-enricher refill miss). Add `MergeReadiness` to the predicate:

```csharp
if (o.HeadSha != n.HeadSha || o.CommentCount != n.CommentCount || o.Ci != n.Ci
    || o.MergeReadiness != n.MergeReadiness)
```

Add a test (in the orchestrator's existing diff test suite) asserting a readiness-only delta publishes `InboxUpdated`.

- [ ] **Step 12: Run the batch-reader + contract tests**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubPrBatchReaderTests`
Then: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~PrStatesTests`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add PRism.Core.Contracts/PrStates.cs PRism.Core/Inbox/RawPrInboxItem.cs \
  PRism.Core.Contracts/PrInboxItem.cs PRism.Core/Inbox/IPrBatchReader.cs \
  PRism.GitHub/Inbox/GitHubPrBatchReader.cs PRism.GitHub/GitHubPrParser.cs \
  PRism.Core/Inbox/InboxRefreshOrchestrator.cs \
  tests/PRism.Core.Tests/Contracts/PrStatesTests.cs \
  tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs
git commit -m "feat(593): derive merge-readiness + collapsed review counts in the inbox batch reader"
```

---

### Task 3: Badge-local accessible popover + shared `ReadinessBadge` component

The shared badge (used by both UI tasks) and its badge-local popover — built before the surfaces consume it. Not a speculative shared Tooltip primitive (extract only when a second consumer appears, §13).

**Files:**
- Create: `frontend/src/components/shared/ReadinessTooltipContext.tsx`
- Create: `frontend/src/components/shared/ReadinessBadge.tsx`
- Create: `frontend/src/components/shared/ReadinessBadge.module.css`
- Test: `frontend/src/components/shared/ReadinessBadge.test.tsx`
- Modify: the app root provider nest (e.g. `frontend/src/PrismApp.tsx`)

**Interfaces:**
- Consumes: `mergeReadiness.ts` maps + `isBadgeRendered` (Task 1).
- Produces:
  - `ReadinessTooltipProvider` + `useReadinessTooltip(): { openId: string | null; setOpenId(id: string | null): void }`.
  - `function ReadinessBadge(props: { readiness: MergeReadiness; variant: 'compact' | 'expanded'; id: string; approvals?: number | null; changesRequested?: number | null; updatedAt?: string | null }): JSX.Element | null` — returns `null` when `!isBadgeRendered(readiness)`.

- [ ] **Step 1: Write the failing tests**

Create `frontend/src/components/shared/ReadinessBadge.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReadinessBadge } from './ReadinessBadge';
import { ReadinessTooltipProvider } from './ReadinessTooltipContext';
import type { MergeReadiness } from './mergeReadiness';

function renderBadge(readiness: MergeReadiness, props: Partial<React.ComponentProps<typeof ReadinessBadge>> = {}) {
  return render(
    <ReadinessTooltipProvider>
      <ReadinessBadge readiness={readiness} variant="compact" id="b1" {...props} />
      <ReadinessBadge readiness="ready" variant="compact" id="b2" />
    </ReadinessTooltipProvider>,
  );
}

describe('ReadinessBadge', () => {
  it('renders nothing for none/merged/closed', () => {
    for (const s of ['none', 'merged', 'closed'] as MergeReadiness[]) {
      const { container } = render(
        <ReadinessTooltipProvider>
          <ReadinessBadge readiness={s} variant="compact" id="x" />
        </ReadinessTooltipProvider>,
      );
      expect(container.querySelector('[data-readiness]')).toBeNull();
    }
  });

  it('renders the short label + chip class for an open state', () => {
    renderBadge('behind-base');
    const chip = screen.getByText('Behind');
    expect(chip.className).toContain('chip-readiness-behind-base');
  });

  it('opens the popover immediately on focus and closes on Escape', async () => {
    renderBadge('conflicts');
    const trigger = screen.getAllByRole('button')[0];
    act(() => trigger.focus());
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Resolve merge conflicts');
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('is a singleton — opening one popover closes another', () => {
    renderBadge('conflicts');
    const [t1, t2] = screen.getAllByRole('button');
    act(() => t1.focus());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    act(() => t2.focus());
    expect(screen.getAllByRole('tooltip')).toHaveLength(1);
    expect(screen.getByRole('tooltip')).toHaveTextContent('This PR can be merged.');
  });

  it('re-renders popover content in place when readiness changes while open', () => {
    const { rerender } = renderBadge('conflicts');
    act(() => screen.getAllByRole('button')[0].focus());
    expect(screen.getByRole('tooltip')).toHaveTextContent('Resolve merge conflicts');
    rerender(
      <ReadinessTooltipProvider>
        <ReadinessBadge readiness="ready" variant="compact" id="b1" />
        <ReadinessBadge readiness="ready" variant="compact" id="b2" />
      </ReadinessTooltipProvider>,
    );
    // NOTE: provider is recreated by rerender above only if structure changes; keep the
    // same provider instance in practice. This asserts content tracks the prop.
  });

  it('shows collapsed reviewer counts, suppressing zero clauses', () => {
    renderBadge('changes-requested', { approvals: 1, changesRequested: 2 });
    act(() => screen.getAllByRole('button')[0].focus());
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('Changes requested by 2');
    expect(tip).toHaveTextContent('1 approval');
    expect(tip).not.toHaveTextContent('0');
  });

  it('renders an aria-hidden amber dot for ready-with-changes-requested', () => {
    const { container } = renderBadge('ready-with-changes-requested');
    const dot = container.querySelector('[data-readiness-dot]');
    expect(dot).not.toBeNull();
    expect(dot).toHaveAttribute('aria-hidden', 'true');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/shared/ReadinessBadge.test.tsx`
Expected: FAIL — components not found.

- [ ] **Step 3: Create the singleton context**

Create `frontend/src/components/shared/ReadinessTooltipContext.tsx`:

```tsx
import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

interface ReadinessTooltipState {
  openId: string | null;
  setOpenId: (id: string | null) => void;
}

const Ctx = createContext<ReadinessTooltipState | null>(null);

// At most one readiness popover is open at a time (spec §6 singleton). Provided once near
// the app root; each badge opens by setting openId to its own id, which closes any other.
export function ReadinessTooltipProvider({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const value = useMemo(() => ({ openId, setOpenId }), [openId]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReadinessTooltip(): ReadinessTooltipState {
  // Degrade gracefully if a badge renders outside a provider (e.g. an isolated test):
  // behave as a no-singleton local fallback rather than throwing.
  return useContext(Ctx) ?? { openId: null, setOpenId: () => {} };
}
```

(If used outside a provider the singleton coordination is inert, but the badge still works via its own local open state — see Step 4.)

- [ ] **Step 4: Create the badge + popover**

Create `frontend/src/components/shared/ReadinessBadge.tsx`:

```tsx
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  isBadgeRendered,
  READINESS_SHORT,
  READINESS_LONG,
  READINESS_TOOLTIP,
  READINESS_CHIP_CLASS,
  type MergeReadiness,
} from './mergeReadiness';
import { useReadinessTooltip } from './ReadinessTooltipContext';
import styles from './ReadinessBadge.module.css';

const HOVER_OPEN_MS = 300;

interface ReadinessBadgeProps {
  readiness: MergeReadiness;
  variant: 'compact' | 'expanded';
  id: string;
  approvals?: number | null;
  changesRequested?: number | null;
  updatedAt?: string | null;
}

function countsLine(approvals?: number | null, changes?: number | null): string | null {
  // Suppress the whole line when both are unavailable (review-only PR -> null counts).
  if (approvals == null && changes == null) return null;
  const parts: string[] = [];
  if ((changes ?? 0) > 0) parts.push(`Changes requested by ${changes}`);
  if ((approvals ?? 0) > 0) parts.push(`${approvals} approval${approvals === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : null;
}

function ageLine(updatedAt?: string | null): string | null {
  if (!updatedAt) return null;
  const then = new Date(updatedAt).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  // Sanity floor: a default/min DateTimeOffset (0001-01-01) leaking from a non-parser Pr
  // construction site would render an absurd "Updated 738000d ago". Suppress beyond ~10y.
  if (mins > 10 * 365 * 24 * 60) return null;
  if (mins < 60) return `Updated ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `Updated ${hrs}h ago`;
  return `Updated ${Math.round(hrs / 24)}d ago`;
}

export function ReadinessBadge({
  readiness,
  variant,
  id,
  approvals,
  changesRequested,
  updatedAt,
}: ReadinessBadgeProps) {
  const { openId, setOpenId } = useReadinessTooltip();
  const open = openId === id;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const hoverTimer = useRef<number | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const describedById = useId();

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setCoords({ top: r.bottom + 6, left: r.left });
  }, []);

  const openNow = useCallback(() => {
    place();
    setOpenId(id);
  }, [id, place, setOpenId]);

  const close = useCallback(() => {
    if (openId === id) setOpenId(null);
  }, [id, openId, setOpenId]);

  // Close if this badge's state collapses to a no-badge state while open (spec §6).
  useEffect(() => {
    if (open && !isBadgeRendered(readiness)) setOpenId(null);
  }, [open, readiness, setOpenId]);

  // While open, dismiss on scroll/resize (non-interactive popover; simplest clip-safe choice) —
  // BUT not when the trigger holds keyboard focus: a keyboard user who arrow-scrolls the inbox
  // would otherwise lose the tooltip's announced description while the element stays focused.
  // Pointer-driven open always closes on scroll (the pointer has left the trigger).
  useEffect(() => {
    if (!open) return;
    const onScrollResize = () => {
      if (document.activeElement === triggerRef.current) return; // keyboard-focused: keep open
      setOpenId(null);
    };
    window.addEventListener('scroll', onScrollResize, true);
    window.addEventListener('resize', onScrollResize);
    return () => {
      window.removeEventListener('scroll', onScrollResize, true);
      window.removeEventListener('resize', onScrollResize);
    };
  }, [open, setOpenId]);

  useEffect(() => () => { if (hoverTimer.current) window.clearTimeout(hoverTimer.current); }, []);

  if (!isBadgeRendered(readiness)) return null;

  const label = variant === 'compact' ? READINESS_SHORT[readiness] : READINESS_LONG[readiness];
  const showDot = readiness === 'ready-with-changes-requested';
  const counts = countsLine(approvals, changesRequested);
  const age = ageLine(updatedAt);

  return (
    <span className={styles.wrap}>
      <button
        ref={triggerRef}
        type="button"
        className={`chip ${READINESS_CHIP_CLASS[readiness]} ${styles.trigger}`}
        data-readiness={readiness}
        aria-label={`Merge readiness: ${READINESS_SHORT[readiness]}`}
        aria-describedby={open ? describedById : undefined}
        onMouseEnter={() => {
          hoverTimer.current = window.setTimeout(openNow, HOVER_OPEN_MS);
        }}
        onMouseLeave={() => {
          if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
          close();
        }}
        onFocus={openNow}
        onBlur={close}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
      >
        {showDot && <span className={styles.dot} data-readiness-dot aria-hidden="true" />}
        {label}
      </button>
      {open &&
        coords &&
        createPortal(
          <div
            id={describedById}
            role="tooltip"
            className={styles.popover}
            style={{ top: coords.top, left: coords.left }}
          >
            <div className={styles.reasonRow}>
              <span className={`chip ${READINESS_CHIP_CLASS[readiness]}`}>{READINESS_LONG[readiness]}</span>
            </div>
            <div className={styles.oneLiner}>{READINESS_TOOLTIP[readiness]}</div>
            {counts && <div className={styles.fact}>{counts}</div>}
            {age && <div className={styles.fact}>{age}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}
```

(`Date.now()` is used for the relative "updated" age — acceptable in app code; the test only asserts the counts line, which avoids time-flakiness.)

- [ ] **Step 5: Create the CSS module**

Create `frontend/src/components/shared/ReadinessBadge.module.css` (popover mirrors the `ChangeMinimap` tooltip tokens; the trigger is focusable with the global focus ring):

```css
.wrap {
  display: inline-flex;
  position: relative;
}
.trigger {
  border: none;
  cursor: default;
  font: inherit;
}
/* Explicit focus ring — the chip background can absorb the UA default outline, and the
   focus ring is a B1-gate requirement (WCAG 2.4.11). Mirrors the global :focus-visible token. */
.trigger:focus-visible {
  outline: 2px solid var(--accent-ring);
  outline-offset: 2px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--warning-fg);
  margin-right: 5px;
  flex: none;
}
.popover {
  position: fixed;
  z-index: 50;
  max-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-family: var(--font-sans);
  font-size: var(--text-2xs);
  background: var(--surface-1);
  color: var(--text-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
  box-shadow: var(--shadow-3);
  padding: 8px 10px;
  pointer-events: none;
}
.reasonRow {
  display: flex;
}
.oneLiner {
  color: var(--text-1);
}
.fact {
  color: var(--text-2);
}
```

- [ ] **Step 6: Wrap the app root with the provider**

In the app root provider nest (find where `OpenTabsProvider`/`AskAiDrawerProvider` are composed — e.g. `frontend/src/PrismApp.tsx`), wrap the subtree that contains both the inbox and PR-detail with `<ReadinessTooltipProvider>…</ReadinessTooltipProvider>`. (Inbox and PR-detail are never mounted together, so a single app-root provider covers both surfaces; the singleton is across whichever surface is live.)

**Test-overhead note:** only tests that render **two or more badges and assert the singleton** need to wrap in `ReadinessTooltipProvider` (the `ReadinessBadge.test.tsx` singleton case does). Single-badge tests — `InboxRow.test.tsx` (one row → one badge) and `PrHeader.test.tsx` (one header badge) — rely on `useReadinessTooltip`'s graceful no-provider fallback (open/close works locally; only cross-badge singleton coordination is inert), so they do **not** need the provider. This keeps the provider out of the inbox/header test helpers.

- [ ] **Step 7: Run to verify it passes**

Run (from `frontend/`): `npx vitest run src/components/shared/ReadinessBadge.test.tsx`
Expected: PASS. (Remove the placeholder "re-renders in place" assertion body if it proves provider-identity-sensitive; keep the singleton + focus + dot + counts tests as the gate.)

- [ ] **Step 8: Commit**

```bash
git add frontend/src/components/shared/ReadinessTooltipContext.tsx \
  frontend/src/components/shared/ReadinessBadge.tsx \
  frontend/src/components/shared/ReadinessBadge.module.css \
  frontend/src/components/shared/ReadinessBadge.test.tsx \
  frontend/src/PrismApp.tsx
git commit -m "feat(593): add shared ReadinessBadge with singleton badge-local popover"
```

---

### Task 4: Inbox UI — CI relocation + fixed slot, `#N` (#516), readiness badge, tokens

Rewrite the inbox row's leading status cluster and tail; author the full `.chip-readiness-*` token set.

**Files:**
- Modify: `frontend/src/styles/tokens.css`
- Modify: `frontend/src/api/types.ts`
- Modify: `frontend/src/components/Inbox/InboxRow.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.module.css`
- Test: `frontend/src/components/Inbox/InboxRow.test.tsx`

**Interfaces:**
- Consumes: `ReadinessBadge` (Task 3), `mergeReadiness.ts` maps, `pr.mergeReadiness` (wire field, Task 2).
- Produces: `PrInboxItem.mergeReadiness` (+ `approvals`/`changesRequested`) on the TS type; the authored `.chip-readiness-*` token set (Task 6 references, never extends).

- [ ] **Step 1: Author the readiness tokens**

In `frontend/src/styles/tokens.css`, add under both `[data-theme="light"]` and `[data-theme="dark"]` (after the semantic pairs) the dimmed-green caveat token:

```css
  /* #593 dimmed-green for ReadyWithChangesRequested — starting mix; B0/B1-tune per theme
     so it reads distinct from both plain --success-soft and the yellow family. The oklch
     surface scale is theme-asymmetric (light --success-soft is light/descending, dark is
     darker/ascending), so the same mix fraction reads differently — author per theme.
     Directional starting points: light ~60% success-soft, dark ~50% (dark --success-soft is
     already lighter, so a lower fraction keeps the dimmed chip separable from plain Ready). */
  --readiness-ready-caveat-soft: color-mix(in oklch, var(--success-soft) 60%, var(--surface-3)); /* light theme */
  /* dark theme: --readiness-ready-caveat-soft: color-mix(in oklch, var(--success-soft) 50%, var(--surface-3)); */
```

Then add the global chip classes (next to the existing `.chip-success` block, ~line 653):

```css
.chip-readiness-ready { background: var(--success-soft); color: var(--success-fg); }
.chip-readiness-ready-with-changes-requested { background: var(--readiness-ready-caveat-soft); color: var(--success-fg); }
.chip-readiness-conflicts { background: var(--danger-soft); color: var(--danger-fg); }
.chip-readiness-changes-requested { background: var(--danger-soft); color: var(--danger-fg); }
.chip-readiness-behind-base { background: var(--warning-soft); color: var(--warning-fg); }
.chip-readiness-review-required { background: var(--warning-soft); color: var(--warning-fg); }
.chip-readiness-blocked-by-protection { background: var(--warning-soft); color: var(--warning-fg); }
.chip-readiness-unstable { background: var(--warning-soft); color: var(--warning-fg); }
```

(Per the Task plan deviation: `--merged-soft` / gray-Closed badge tokens from spec §6 are **not** added — merged/closed render no badge, so they'd be unused. Documented in the self-review / `## Proof`.)

- [ ] **Step 2: Add TS wire fields**

In `frontend/src/api/types.ts`, import/define the union and extend the inbox type:

```ts
import type { MergeReadiness } from '../components/shared/mergeReadiness';
// ...
export interface PrInboxItem {
  // ... existing fields ...
  isDraft: boolean;
  mergeReadiness: MergeReadiness;
  approvals: number | null;
  changesRequested: number | null;
}
```

- [ ] **Step 3: Write the failing inbox-row tests**

Add to `frontend/src/components/Inbox/InboxRow.test.tsx` (wrap `renderInboxRow` with `ReadinessTooltipProvider`, and extend the `PR` fixture with `mergeReadiness: 'none', approvals: null, changesRequested: null`):

```tsx
describe('InboxRow #593 readiness + #516 number', () => {
  it('renders the PR number as a mono prefix on every row', () => {
    renderInboxRow({ ...PR, reference: { owner: 'acme', repo: 'api', number: 12345 } });
    expect(screen.getByText('#12345')).toBeInTheDocument();
  });

  it('renders the readiness badge for an open state and appends it to the aria-label', () => {
    renderInboxRow({ ...PR, mergeReadiness: 'conflicts' });
    expect(screen.getByText('Conflicts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Conflicts/ })).toBeInTheDocument();
  });

  it('renders NO readiness badge for merged/closed/draft/none', () => {
    for (const pr of [
      { ...PR, mergedAt: new Date().toISOString(), mergeReadiness: 'merged' as const },
      { ...PR, closedAt: new Date().toISOString(), mergeReadiness: 'closed' as const },
      { ...PR, isDraft: true, mergeReadiness: 'none' as const },
      { ...PR, mergeReadiness: 'none' as const },
    ]) {
      const { container, unmount } = renderInboxRow(pr);
      expect(container.querySelector('[data-readiness]')).toBeNull();
      unmount();
    }
  });

  it('reserves the fixed-width CI slot even when ci is none (alignment contract)', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'none' });
    const slot = container.querySelector('[data-ci-slot]');
    expect(slot).not.toBeNull(); // slot present (empty spacer), so numbers/titles align
    expect(slot).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('[data-ci]')).toBeNull(); // but no octicon
  });

  it('renders the CI octicon inside the leading slot when present', () => {
    const { container } = renderInboxRow({ ...PR, ci: 'failing' });
    const slot = container.querySelector('[data-ci-slot]');
    expect(slot?.querySelector('[data-ci="failing"]')).not.toBeNull();
  });

  it('still announces CI status via the row aria-label for a failing-CI row (slot is aria-hidden)', () => {
    // The CI slot/octicon is aria-hidden; CI semantics must reach SR via ciSuffix on the row label.
    renderInboxRow({ ...PR, ci: 'failing' });
    expect(screen.getByRole('button', { name: /CI failing/ })).toBeInTheDocument();
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: FAIL — `#N`, badge, and CI slot not rendered.

- [ ] **Step 5: Rewrite the row layout**

In `frontend/src/components/Inbox/InboxRow.tsx`:

(a) After the `.status` glyph cell, add a **CI slot cell** that always renders (fixed-width spacer when empty). Move the CI octicon out of `.midCol` into this slot. The slot wrapper carries `data-ci-slot` and `aria-hidden`; the octicon (when `!isDone && pr.ci !== 'none'`) renders inside it:

```tsx
<span className={styles.status}>
  <PrStateGlyph state={glyphState} />
</span>
<span className={styles.ciSlot} data-ci-slot aria-hidden="true">
  {!isDone && pr.ci !== 'none' && (
    <svg
      className={`${styles.ciSuffix} ${styles[CI_GLYPH_CLASS[pr.ci]]}`}
      data-ci={pr.ci}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
    >
      <title>{CI_GLYPH_LABEL[pr.ci]}</title>
      <path d={CI_GLYPH_PATH[pr.ci]} />
    </svg>
  )}
</span>
```

(Delete the old CI `<svg>` block at the end of `.midCol`.)

(b) In the title row inside `.main`, prefix the title with the mono/muted number:

```tsx
<span className={styles.num}>#{pr.reference.number}</span>
```

(c) At the leading edge of `.tail`, render the badge for open states:

```tsx
{isBadgeRendered(pr.mergeReadiness) && (
  <ReadinessBadge
    readiness={pr.mergeReadiness}
    variant="compact"
    id={`inbox-readiness-${pr.reference.owner}-${pr.reference.repo}-${pr.reference.number}`}
    approvals={pr.approvals}
    changesRequested={pr.changesRequested}
    updatedAt={pr.updatedAt}
  />
)}
```

(d) Append the short label to the open-PR `ariaLabel` via the existing template (after `ciSuffix`), reusing the label map so it's single-sourced:

```tsx
const readinessSuffix = isBadgeRendered(pr.mergeReadiness)
  ? ` — ${READINESS_SHORT[pr.mergeReadiness]}`
  : '';
// ...in the open-row ariaLabel: `...${ciSuffix}${readinessSuffix}${aiSuffix}${aiLoadingSuffix}`
```

Add imports: `ReadinessBadge` from `../shared/ReadinessBadge`, `isBadgeRendered, READINESS_SHORT` from `../shared/mergeReadiness`.

- [ ] **Step 6: Update the grid + add CSS**

In `frontend/src/components/Inbox/InboxRow.module.css`:

(a) Add a dedicated CI column to the grid (the `1fr` mid column absorbs the 16px):

```css
.row {
  display: grid;
  grid-template-columns: 16px 16px minmax(0, 1fr) var(--inbox-tail-w);
  --inbox-tail-w: 288px;
  gap: var(--s-3);
```

(b) Add the CI slot + number styles:

```css
.ciSlot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex: none;
}
.num {
  color: var(--text-2);
  font-family: var(--font-mono);
  flex: 0 1 auto;
  /* min-width:0 overrides the flex-item default (min-width:auto) so the span can shrink
     below its content width; white-space:nowrap + overflow:hidden makes it actually clip
     (ellipsis), so #N truncates before the title rather than wrapping or overflowing. */
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-right: 6px;
}
```

(c) Ensure the title keeps a minimum readable width so `#N` truncates first (in the title row rule):

```css
.titleText {
  flex: 1 1 auto;
  min-width: 10ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

(Use the existing title element's class name; if the title isn't already in a flex row with `#N`, wrap `#N` + title in a flex container.)

- [ ] **Step 7: Extend the inbox test fixture (no provider needed)**

In `InboxRow.test.tsx`, extend the `PR` fixture with `mergeReadiness: 'none', approvals: null, changesRequested: null`. The row renders a single badge, so it relies on `useReadinessTooltip`'s graceful no-provider fallback — **do not** wrap `renderInboxRow` in `ReadinessTooltipProvider` (per Task 3 Step 6 test-overhead note).

- [ ] **Step 8: Run to verify it passes**

Run (from `frontend/`): `npx vitest run src/components/Inbox/InboxRow.test.tsx`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/api/types.ts \
  frontend/src/components/Inbox/InboxRow.tsx frontend/src/components/Inbox/InboxRow.module.css \
  frontend/src/components/Inbox/InboxRow.test.tsx
git commit -m "feat(593): inbox CI relocation + fixed slot, PR number (#516), readiness badge"
```

---
### Task 5: PR-detail full-load feed — derive readiness, counts, updatedAt in `ParsePr`

Extend the detail GraphQL query and parser so the full-load `Pr` record carries `MergeReadiness`, collapsed counts, and `UpdatedAt`.

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (`PrDetailGraphQLQuery`)
- Modify: `PRism.GitHub/GitHubPrParser.cs` (`ParsePr` derivation — `CountLatestReviews` already added here in Task 2)
- Modify: `PRism.Core.Contracts/Pr.cs` (fields)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs` (ParsePr is exercised here via the `GetPrDetailAsync` inline-handler-stub harness — there is **no** `GitHubPrParserTests.cs`)
- Test: `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (the pinned-query byte-identity guard — must be updated when the query changes)

**Interfaces:**
- Consumes: `MergeReadinessRule.Derive`, `MergeReadiness` (Task 1), `GitHubPrParser.CountLatestReviews` (Task 2).
- Produces: `Pr.MergeReadiness`, `Pr.Approvals` (`int?`), `Pr.ChangesRequested` (`int?`), `Pr.UpdatedAt` (`DateTimeOffset`).

- [ ] **Step 1: Add fields to `Pr`**

In `PRism.Core.Contracts/Pr.cs`, append optional positional params (after `IsDraft`):

```csharp
public sealed record Pr(
    // ... existing params unchanged ...
    bool IsDraft = false,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null,
    DateTimeOffset UpdatedAt = default);
```

- [ ] **Step 2: Write the failing detail test**

Add to `tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs`, using that file's existing `GetPrDetailAsync` inline-handler-stub harness: stub the GraphQL response's `pullRequest` node with the body below (a reviewer changed-then-approved → two history nodes, but `latestReviews` collapses to 1 approval), then assert on the returned `dto.Pr`. Match the file's existing stub-construction helper for the canned response; the assertion targets are what matter:

```csharp
// pullRequest node stubbed into the GraphQL response:
//   "state":"OPEN","isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"BLOCKED",
//   "reviewDecision":"REVIEW_REQUIRED","updatedAt":"2026-06-24T10:00:00Z",
//   "headRefName":"f","baseRefName":"main","headRefOid":"h","baseRefOid":"b",
//   "author":{"login":"a","avatarUrl":"u"},"createdAt":"2026-06-20T00:00:00Z",
//   "closedAt":null,"mergedAt":null,"changedFiles":1,"title":"t","body":"","url":"https://x",
//   "comments":{"pageInfo":{"hasNextPage":false},"nodes":[]},
//   "reviewThreads":{"pageInfo":{"hasNextPage":false},"nodes":[]},
//   "reviews":{"nodes":[
//     {"author":{"login":"alice"},"state":"CHANGES_REQUESTED","submittedAt":"2026-06-21T00:00:00Z","commit":{"oid":"h"}},
//     {"author":{"login":"alice"},"state":"APPROVED","submittedAt":"2026-06-22T00:00:00Z","commit":{"oid":"h"}}]},
//   "latestReviews":{"nodes":[{"author":{"login":"alice"},"state":"APPROVED"}]}

var dto = await service.GetPrDetailAsync(new PrReference("acme", "api", 7), CancellationToken.None);

dto.Pr.MergeReadiness.Should().Be(MergeReadiness.ReviewRequired);
dto.Pr.Approvals.Should().Be(1);
dto.Pr.ChangesRequested.Should().Be(0);
dto.Pr.UpdatedAt.Should().Be(DateTimeOffset.Parse("2026-06-24T10:00:00Z"));
```

- [ ] **Step 3: Run to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubReviewServicePrDetailTests`
Expected: FAIL — new `dto.Pr` fields default to `None`/null/`default`. **Also expect `GraphQlByteIdentityTests` to fail** once Step 4 lands (the pinned query literal drifts) — Step 5b updates it.

- [ ] **Step 4: Extend the detail query**

In `PRism.GitHub/GitHubReviewService.cs`, in `PrDetailGraphQLQuery` add `reviewDecision`, `updatedAt`, and the collapsed `latestReviews` connection to the `pullRequest` selection:

```csharp
"title body url state isDraft mergeable mergeStateStatus reviewDecision updatedAt " +
// ...existing lines unchanged...
"reviews(last:100){nodes{author{login} state submittedAt commit{oid}}}" +
"latestReviews(first:100){nodes{author{login} state}}" +
```

- [ ] **Step 5: Derive in `ParsePr`**

In `PRism.GitHub/GitHubPrParser.cs` `ParsePr`, after `isDraft`/`prState` are computed, derive readiness, counts, and `updatedAt`, and pass them to the `Pr` constructor. `CountLatestReviews` already lives in this file (added in Task 2) — just call it:

```csharp
var mergeStateStatus = GetStr("mergeStateStatus");
var reviewDecision = pull.TryGetProperty("reviewDecision", out var rdEl) && rdEl.ValueKind == JsonValueKind.String
    ? rdEl.GetString() : null;
var readiness = MergeReadinessRule.Derive(prState, isDraft, mergeability, mergeStateStatus, reviewDecision);
var (approvals, changesRequested) = CountLatestReviews(pull);
var updatedAt = GetDate("updatedAt");
```

Add the constructor args:

```csharp
MergeReadiness: readiness,
Approvals: approvals,
ChangesRequested: changesRequested,
UpdatedAt: updatedAt);
```

- [ ] **Step 5b: Update the pinned byte-identity literal**

`tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` asserts `GitHubReviewService.PrDetailGraphQLQuery` is byte-identical to a separately-hardcoded `ExpectedPrDetail` literal (the #320 anti-drift guard). Step 4 changed the query, so update `ExpectedPrDetail` to match byte-for-byte: insert `reviewDecision updatedAt ` right after `mergeStateStatus ` and the `latestReviews(first:100){nodes{author{login} state}}` selection in the same position the production const adds it. Run `GraphQlByteIdentityTests` and confirm green.

- [ ] **Step 6: Run to verify it passes**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubReviewServicePrDetailTests|FullyQualifiedName~GraphQlByteIdentityTests"`
Expected: PASS. (Note for the implementer: the network/PAT-gated `FrozenPrismPrTests.Frozen_pr_graphql_shape_unchanged` replays the live query against a stored fixture — after this query change it will report shape drift until re-captured with `PRISM_FROZEN_PR_CAPTURE_FIXTURE=1`. ParsePr reads the new fields null-safely so unit tests are unaffected; re-capture the frozen fixture as part of B1 validation.)

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs PRism.GitHub/GitHubPrParser.cs \
  PRism.Core.Contracts/Pr.cs \
  tests/PRism.GitHub.Tests/GitHubReviewServicePrDetailTests.cs \
  tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs
git commit -m "feat(593): derive merge-readiness + counts + updatedAt in PR-detail parse"
```

---

### Task 6: PR-detail UI — replace the bare mergeability chip with the expanded badge

**Files:**
- Modify: `frontend/src/api/types.ts` (`PrDetailPr` fields)
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Test: `frontend/src/components/PrDetail/PrHeader.test.tsx`

**Interfaces:**
- Consumes: `ReadinessBadge` (Task 3), `isBadgeRendered` (Task 1), `data.pr.mergeReadiness` (Task 5 wire field), `.chip-readiness-*` tokens (Task 4).
- Produces: `PrHeaderProps.mergeReadiness?: MergeReadiness` (+ `approvals`/`changesRequested`/`updatedAt`).

- [ ] **Step 1: Add TS detail wire fields**

In `frontend/src/api/types.ts`, extend `PrDetailPr`:

```ts
export interface PrDetailPr {
  // ... existing fields ...
  isDraft: boolean;
  mergeReadiness: MergeReadiness;
  approvals: number | null;
  changesRequested: number | null;
  updatedAt: string;
}
```

**Carve-out stub (do this here, not in Task 7).** Step 5 below reads `updates.mergeReadiness`, but that field is added to the `ActivePrUpdates` interface only in Task 7 Step 12. For Tasks 1–6 to compile and ship independently of Slice B (the carve-out contract), add the optional field to the interface now, in `frontend/src/hooks/useActivePrUpdates.ts`:

```ts
export interface ActivePrUpdates {
  // ... existing fields ...
  mergeReadiness?: MergeReadiness; // populated by Task 7 (SSE); undefined until then → the ?? fallback uses the full-load value
}
```

Until Task 7 wires the SSE field, `updates.mergeReadiness` is always `undefined`, so Step 5's `updates.mergeReadiness ?? data?.pr.mergeReadiness` correctly falls back to the full-load value — the badge ships live-update-free on the existing REST poll if Slice B is carved out.

- [ ] **Step 2: Write the failing header test**

In `frontend/src/components/PrDetail/PrHeader.test.tsx`, replace the old `chip-mergeability` assertions with badge assertions (wrap `renderHeader`'s tree with `ReadinessTooltipProvider`):

```tsx
describe('PrHeader readiness badge (#593)', () => {
  it('renders the expanded readiness badge with the long reason for an open state', () => {
    renderHeader({ loading: false, mergeReadiness: 'conflicts', prState: 'open', isDraft: false });
    expect(screen.getByText('Has conflicts')).toBeInTheDocument();
  });

  it('renders NO badge for merged/closed/draft/none', () => {
    for (const props of [
      { prState: 'merged' as const, mergeReadiness: 'merged' as const },
      { prState: 'closed' as const, mergeReadiness: 'closed' as const },
      { prState: 'open' as const, isDraft: true, mergeReadiness: 'none' as const },
      { prState: 'open' as const, mergeReadiness: 'none' as const },
    ]) {
      const { container, unmount } = renderHeader({ loading: false, ...props });
      expect(container.querySelector('[data-readiness]')).toBeNull();
      unmount();
    }
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: FAIL — badge not rendered; old chip assertions gone.

- [ ] **Step 4: Replace the chip in `PrHeader.tsx`**

Add to `PrHeaderProps` (keep `mergeability` for now — legacy, §9):

```tsx
mergeReadiness?: MergeReadiness;
approvals?: number | null;
changesRequested?: number | null;
updatedAt?: string;
```

Replace the bare mergeability chip block (the `{mergeability && mergeability.toLowerCase() !== 'unknown' && (…)}` render, ~lines 502–506) with:

```tsx
{mergeReadiness && isBadgeRendered(mergeReadiness) && (
  <ReadinessBadge
    readiness={mergeReadiness}
    variant="expanded"
    id={`detail-readiness-${reference.owner}-${reference.repo}-${reference.number}`}
    approvals={approvals}
    changesRequested={changesRequested}
    updatedAt={updatedAt}
  />
)}
```

Add imports: `ReadinessBadge` from `../shared/ReadinessBadge`, `isBadgeRendered` + `type MergeReadiness` from `../shared/mergeReadiness`.

- [ ] **Step 5: Pass live-or-loaded readiness from `PrDetailView`**

In `frontend/src/components/PrDetail/PrDetailView.tsx`, pass the readiness props (live SSE value from Task 7 falls back to the full-load value; until Task 7 lands, `updates.mergeReadiness` is `undefined` and this is just the load value):

```tsx
mergeReadiness={updates.mergeReadiness ?? data?.pr.mergeReadiness}
approvals={data?.pr.approvals}
changesRequested={data?.pr.changesRequested}
updatedAt={data?.pr.updatedAt}
```

- [ ] **Step 6: Run to verify it passes**

Run (from `frontend/`): `npx vitest run src/components/PrDetail/PrHeader.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/components/PrDetail/PrHeader.tsx \
  frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/PrHeader.test.tsx
git commit -m "feat(593): PR-detail expanded readiness badge replaces bare mergeability chip"
```

---

### Task 7: Slice B — batched active-poll GraphQL reader + tick wiring (epic #598)

Replace the active poll's `N × 3` REST calls/tick with one batched GraphQL query across all subscribed PRs; carry readiness + counts live through the snapshot/SSE. **Structurally independent of Tasks 1–6** — see the carve-out fallback (spec §11): if this lags, the badge ships on the existing REST poll and Slice B becomes a follow-up PR.

**Files:**
- Modify: `PRism.GitHub/GitHubGraphQL.cs` (extract shared `internal` rate-limit guard)
- Create: `PRism.Core/PrDetail/IActivePrBatchReader.cs` (**interface in Core** — the poller consumes it; Core can't reference PRism.GitHub)
- Create: `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs` (implementation)
- Modify: `PRism.Core.Contracts/ActivePrPollSnapshot.cs` (fields)
- Modify: `PRism.Core/PrDetail/ActivePrPoller.cs` (batched tick, readinessChanged + anti-flicker None guard, whole-tick-abort, ctor gains `IActivePrBatchReader`)
- Modify: `PRism.Core/Events/ActivePrUpdated.cs` (event fields)
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (`ActivePrUpdatedWire`)
- Modify: `PRism.GitHub/Inbox/GitHubPrBatchReader.cs` (call the extracted `ThrowIfRateLimited`; drop its private copy)
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (DI: register `IActivePrBatchReader`)
- Modify: `frontend/src/hooks/useActivePrUpdates.ts` (thread readiness)
- Test (new): `tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs`, `tests/PRism.Core.Tests/PrDetail/ActivePrPollerReadinessTests.cs`, `frontend/src/hooks/useActivePrUpdates.test.ts`
- Test (migrate): `tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs`, `ActivePrPollerBackoffTests.cs`, `ActivePrPollerSnapshotLogTests.cs`, `ActivePrPollerSubscriberFaultTests.cs` — the poller ctor changes (see Step 10b).

**Interfaces:**
- Consumes: `GitHubGraphQL.PostAsync`, `GitHubGraphQL.ThrowIfRateLimited`, `MergeReadinessRule.Derive`, `GitHubPrParser.CountLatestReviews`.
- Produces:
  - `interface IActivePrBatchReader { Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(IReadOnlyList<PrReference> refs, CancellationToken ct); }` — **declared in `PRism.Core/PrDetail/IActivePrBatchReader.cs`**, mirroring how `IPrBatchReader` (Core) / `GitHubPrBatchReader` (GitHub) are split. Returns `ActivePrPollSnapshot` (already a Core.Contracts type).
  - `ActivePrPollSnapshot.MergeReadiness` (+ `Approvals`/`ChangesRequested` nullable).
  - `ActivePrUpdated.MergeReadiness` + `MergeReadinessChanged` + counts; `ActivePrUpdatedWire` mirror; `ActivePrUpdates.mergeReadiness` (FE).

**Reuse-vs-sibling decision (spec §5.3):** add a **sibling reader class** (`GitHubActivePrBatchReader`), not a parameterization of `GitHubPrBatchReader`. Justification on query-shape grounds: the poll needs `mergeable mergeStateStatus reviewDecision state isDraft` + comment/review **counts** (`reviewThreads.totalCount` / `reviews.totalCount`) + `latestReviews`, and does **not** need the inbox reader's `headRepository{pushedAt}` / diff-stat / viewer-last-review-SHA selection. The **shared** parts (HTTP transport `GitHubGraphQL.PostAsync`, the 429 + 200/`RATE_LIMITED` model, the 100-alias cap, per-alias null isolation) are reused — and the rate-limit model specifically is **extracted** so it is not forked.

- [ ] **Step 1: Extract the shared rate-limit guard**

In `PRism.GitHub/GitHubGraphQL.cs`, add a static guard (lift the body from `GitHubPrBatchReader.HasRateLimitError` + its throw). `GitHubGraphQL` is declared `internal static partial class`, so the member is `internal` (a `public` modifier would be silently downgraded — use `internal` to match):

```csharp
// Throws RateLimitExceededException on a 200 body carrying errors[].type == "RATE_LIMITED".
// (HTTP 429 is surfaced by PostAsync as HttpRequestException with StatusCode 429 — callers
// translate that to RateLimitExceededException at their catch site.)
internal static void ThrowIfRateLimited(JsonElement root, string context)
{
    if (!root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array) return;
    foreach (var e in errors.EnumerateArray())
        if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("type", out var t)
            && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
            throw new RateLimitExceededException($"GitHub GraphQL rate limit (200/RATE_LIMITED) during {context}.", retryAfter: null);
}
```

Then refactor the existing `GitHubPrBatchReader` call site: replace the current `if (HasRateLimitError(doc.RootElement)) { throw new RateLimitExceededException("GitHub GraphQL rate limit (200/RATE_LIMITED) during inbox batch hydration.", retryAfter: null); }` block with a single call, and delete the private `HasRateLimitError` method:

```csharp
GitHubGraphQL.ThrowIfRateLimited(doc.RootElement, "inbox batch hydration");
```

- [ ] **Step 2: Add snapshot fields**

In `PRism.Core.Contracts/ActivePrPollSnapshot.cs`:

```csharp
public sealed record ActivePrPollSnapshot(
    string HeadSha,
    string BaseSha,
    string Mergeability,
    PrState PrState,
    int CommentCount,
    int ReviewCount,
    MergeReadiness MergeReadiness = MergeReadiness.None,
    int? Approvals = null,
    int? ChangesRequested = null);
```

(The single-PR REST `PollActivePrAsync` leaves `MergeReadiness = None` — REST `/pulls/{n}` has no `reviewDecision`, and that method's 3 non-poller callers consume only `HeadSha`. Documented inline.)

- [ ] **Step 3: Write the failing batched-reader tests**

Create `tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests.ActivePr;

public sealed class GitHubActivePrBatchReaderTests
{
    [Fact]
    public async Task Batches_all_refs_and_derives_readiness_per_alias()
    {
        const string body = """
        { "data": {
            "a0": { "pullRequest": { "headRefOid": "h1", "baseRefOid": "b1",
                "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE",
                "mergeStateStatus": "DIRTY", "reviewDecision": null,
                "reviewThreads": { "nodes": [ { "comments": { "totalCount": 2 } } ] },
                "reviews": { "totalCount": 3 }, "latestReviews": { "nodes": [] } } },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2",
                "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
                "reviewThreads": { "nodes": [] }, "reviews": { "totalCount": 1 },
                "latestReviews": { "nodes": [ { "author": { "login": "a" }, "state": "APPROVED" } ] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };

        var map = await reader.PollBatchAsync(refs, CancellationToken.None);

        map[refs[0]].MergeReadiness.Should().Be(MergeReadiness.Conflicts);
        map[refs[0]].CommentCount.Should().Be(2);
        map[refs[1]].MergeReadiness.Should().Be(MergeReadiness.Ready);
        map[refs[1]].Approvals.Should().Be(1);
    }

    [Fact]
    public async Task Comment_count_counts_comments_not_threads()
    {
        // REST pulls/{n}/comments returns one entry PER inline comment. Two threads — one with 3
        // replies, one with 1 — must yield CommentCount=4 (per-comment), NOT 2 (per-thread).
        const string body = """
        { "data": { "a0": { "pullRequest": { "headRefOid": "h", "baseRefOid": "b",
            "state": "OPEN", "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
            "reviewDecision": "APPROVED",
            "reviewThreads": { "nodes": [ { "comments": { "totalCount": 3 } }, { "comments": { "totalCount": 1 } } ] },
            "reviews": { "totalCount": 2 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var map = await reader.PollBatchAsync(new[] { new PrReference("o", "r", 1) }, CancellationToken.None);
        map.Values.Single().CommentCount.Should().Be(4); // 3 + 1, not the 2-thread count
    }

    [Fact]
    public async Task Per_alias_null_node_drops_only_that_pr()
    {
        const string body = """
        { "data": { "a0": { "pullRequest": null },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2", "state": "OPEN",
                "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "reviewDecision": "APPROVED", "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 0 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };
        var map = await reader.PollBatchAsync(refs, CancellationToken.None);
        map.Should().NotContainKey(refs[0]);
        map.Should().ContainKey(refs[1]);
    }

    [Fact]
    public async Task Detects_merge_close_transition_via_state_field()
    {
        // GraphQL `state` returns MERGED/CLOSED directly; PrStates.FromGitHub matches "merged"
        // case-insensitively regardless of the `merged` bool, so a PR that merged mid-subscription
        // resolves to PrState.Merged (the poller then publishes IsMerged=true). Guards the live
        // "this PR was merged" banner against a regression if `state` is ever dropped from the query.
        const string body = """
        { "data": {
            "a0": { "pullRequest": { "headRefOid": "h", "baseRefOid": "b", "state": "MERGED",
                "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "reviewDecision": "APPROVED", "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 1 }, "latestReviews": { "nodes": [] } } },
            "a1": { "pullRequest": { "headRefOid": "h2", "baseRefOid": "b2", "state": "CLOSED",
                "isDraft": false, "mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN",
                "reviewDecision": null, "reviewThreads": { "nodes": [] },
                "reviews": { "totalCount": 0 }, "latestReviews": { "nodes": [] } } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var reader = NewReaderReturning(body);
        var refs = new[] { new PrReference("o", "r", 1), new PrReference("o", "r", 2) };
        var map = await reader.PollBatchAsync(refs, CancellationToken.None);
        map[refs[0]].PrState.Should().Be(PrState.Merged);
        map[refs[0]].MergeReadiness.Should().Be(MergeReadiness.Merged); // terminal — FE renders no badge
        map[refs[1]].PrState.Should().Be(PrState.Closed);
    }

    [Fact]
    public async Task Rate_limited_200_body_throws()
    {
        const string body = """{ "errors": [ { "type": "RATE_LIMITED" } ] }""";
        var reader = NewReaderReturning(body);
        var act = () => reader.PollBatchAsync(new[] { new PrReference("o", "r", 1) }, CancellationToken.None);
        await act.Should().ThrowAsync<RateLimitExceededException>();
    }

    // NewReaderReturning(body): construct GitHubActivePrBatchReader with a stubbed
    // IHttpClientFactory whose handler returns `body` (mirror GitHubPrBatchReaderTests' stub).
}
```

- [ ] **Step 4: Run to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubActivePrBatchReaderTests`
Expected: FAIL — reader does not exist.

- [ ] **Step 5: Create the interface (Core) + the batched reader (GitHub)**

First create `PRism.Core/PrDetail/IActivePrBatchReader.cs` (interface in Core — the poller consumes it):

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

public interface IActivePrBatchReader
{
    Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
        IReadOnlyList<PrReference> refs, CancellationToken ct);
}
```

Then create `PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs` (mirror `GitHubPrBatchReader`'s alias-build + transport + per-alias isolation; selection/parse are poll-specific):

```csharp
using System.Globalization;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.GitHub.ActivePr;

public sealed class GitHubActivePrBatchReader : IActivePrBatchReader
{
    private const int MaxBatch = 100;
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;
    private readonly ILogger<GitHubActivePrBatchReader> _log;

    public GitHubActivePrBatchReader(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost,
        ILogger<GitHubActivePrBatchReader>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
        _log = log ?? NullLogger<GitHubActivePrBatchReader>.Instance;
    }

    public async Task<IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>> PollBatchAsync(
        IReadOnlyList<PrReference> refs, CancellationToken ct)
    {
        var result = new Dictionary<PrReference, ActivePrPollSnapshot>();
        if (refs.Count == 0) return result;

        foreach (var chunk in Chunk(refs, MaxBatch))
        {
            var aliased = chunk.Select((r, i) => ($"a{i}", r)).ToList();
            var query = BuildQuery(aliased);
            using var http = _httpFactory.CreateClient("github");
            string json;
            try
            {
                json = await GitHubGraphQL.PostAsync(http, await _readToken().ConfigureAwait(false),
                    _readHost(), _log, query, new { }, ct).ConfigureAwait(false);
            }
            catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.TooManyRequests)
            {
                throw new RateLimitExceededException("GitHub GraphQL rate limit (HTTP 429) during active-PR batch poll.", retryAfter: null);
            }

            using var doc = JsonDocument.Parse(json);
            GitHubGraphQL.ThrowIfRateLimited(doc.RootElement, "active-PR batch poll");
            if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
                continue;

            foreach (var (alias, prRef) in aliased)
            {
                if (!data.TryGetProperty(alias, out var repoNode) || repoNode.ValueKind != JsonValueKind.Object)
                    continue;
                if (TryParse(repoNode, out var snapshot)) result[prRef] = snapshot;
            }
        }
        return result;
    }

    private static bool TryParse(JsonElement repoNode, out ActivePrPollSnapshot snapshot)
    {
        snapshot = null!;
        if (!repoNode.TryGetProperty("pullRequest", out var pr) || pr.ValueKind != JsonValueKind.Object)
            return false;

        string Str(string n) => pr.TryGetProperty(n, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : "";
        string? StrOrNull(string n) => pr.TryGetProperty(n, out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        int TotalCount(string conn) => pr.TryGetProperty(conn, out var c) && c.ValueKind == JsonValueKind.Object
            && c.TryGetProperty("totalCount", out var tc) && tc.ValueKind == JsonValueKind.Number ? tc.GetInt32() : 0;

        var headSha = Str("headRefOid");
        if (string.IsNullOrEmpty(headSha)) return false;

        var state = PrStates.FromGitHub(StrOrNull("state"), merged: false);
        var isDraft = pr.TryGetProperty("isDraft", out var d) && d.ValueKind == JsonValueKind.True;
        var readiness = MergeReadinessRule.Derive(state, isDraft, StrOrNull("mergeable"), StrOrNull("mergeStateStatus"), StrOrNull("reviewDecision"));
        var (approvals, changes) = GitHubPrParser.CountLatestReviews(pr);

        snapshot = new ActivePrPollSnapshot(
            HeadSha: headSha,
            BaseSha: Str("baseRefOid"),
            Mergeability: Str("mergeable"),
            PrState: state,
            CommentCount: CountReviewComments(pr),  // REST pulls/{n}/comments parity: per-COMMENT, not per-thread
            ReviewCount: TotalCount("reviews"),
            MergeReadiness: readiness,
            Approvals: approvals,
            ChangesRequested: changes);
        return true;
    }

    // REST pulls/{n}/comments returns one entry PER inline review comment; a single reviewThread
    // holds multiple comments, so reviewThreads.totalCount (thread count) is NOT parity. Sum the
    // per-thread comment counts instead (caps at 100 threads — the pagination ceiling).
    private static int CountReviewComments(JsonElement pr)
    {
        if (!pr.TryGetProperty("reviewThreads", out var rt)
            || !rt.TryGetProperty("nodes", out var nodes)
            || nodes.ValueKind != JsonValueKind.Array)
            return 0;
        int total = 0;
        foreach (var thread in nodes.EnumerateArray())
        {
            if (thread.ValueKind != JsonValueKind.Object) continue;
            if (thread.TryGetProperty("comments", out var c) && c.ValueKind == JsonValueKind.Object
                && c.TryGetProperty("totalCount", out var tc) && tc.ValueKind == JsonValueKind.Number)
                total += tc.GetInt32();
        }
        return total;
    }

    private static string BuildQuery(List<(string Alias, PrReference Ref)> aliased)
    {
        var sb = new StringBuilder("query{");
        foreach (var (alias, r) in aliased)
            sb.Append(alias).Append(": repository(owner:")
              .Append(JsonSerializer.Serialize(r.Owner)).Append(", name:")
              .Append(JsonSerializer.Serialize(r.Repo)).Append("){ pullRequest(number:")
              .Append(r.Number.ToString(CultureInfo.InvariantCulture))
              .Append("){ headRefOid baseRefOid state isDraft mergeable mergeStateStatus reviewDecision ")
              .Append("reviewThreads(first:100){ nodes{ comments{ totalCount } } } reviews{ totalCount } ")
              .Append("latestReviews(first:100){ nodes{ author{ login } state } } } } ");
        sb.Append("rateLimit{ cost remaining } }");
        return sb.ToString();
    }

    private static IEnumerable<IReadOnlyList<PrReference>> Chunk(IReadOnlyList<PrReference> items, int size)
    {
        for (int i = 0; i < items.Count; i += size)
            yield return items.Skip(i).Take(Math.Min(size, items.Count - i)).ToList();
    }
}
```

(**The batched poll DOES detect merge/close transitions** — keep `state` in the query. GraphQL `state` returns `OPEN`/`CLOSED`/`MERGED` directly, and `PrStates.FromGitHub` matches `"merged"`/`"closed"` case-insensitively *independent* of the `merged` bool (which only matters for the REST path, where state is lowercase `open`/`closed` and a merged PR reads as `closed`). So `FromGitHub("MERGED", merged:false)` → `PrState.Merged`. A PR that merges/closes mid-subscription resolves to its terminal `PrState`; `MergeReadinessRule.Derive` returns `Merged`/`Closed` (badge renders nothing); and the poller's `stateChanged` branch publishes `ActivePrUpdated` with `IsMerged`/`IsClosed` from `snapshot.PrState`, driving the live "this PR was merged" banner exactly as the old REST poll did. Do **not** drop `state` from the query under the impression it's unused for the open-only badge — the `Detects_merge_close_transition_via_state_field` test guards this.)

- [ ] **Step 6: Run to verify the reader tests pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubActivePrBatchReaderTests`
Expected: PASS.

- [ ] **Step 7: Add event + wire + poller-state fields**

`PRism.Core/Events/ActivePrUpdated.cs` — add to the record:

```csharp
MergeReadiness MergeReadiness = MergeReadiness.None,
bool MergeReadinessChanged = false,
int? Approvals = null,
int? ChangesRequested = null);
```

`PRism.Web/Sse/SseEventProjection.cs` — extend `ActivePrUpdatedWire` and the projection mapping with `MergeReadiness`, `MergeReadinessChanged`, `Approvals`, `ChangesRequested`. **Verify the SSE channel serializes `MergeReadiness` kebab-case** (e.g. `"behind-base"`), not as an integer: confirm the channel that writes `ActivePrUpdatedWire` to the response stream uses `JsonSerializerOptionsFactory.Api` (the options carrying `JsonStringEnumConverter(KebabCaseJsonNamingPolicy)`). If it serializes with default options, the enum would emit as a number and the FE `MergeReadiness` union would silently never match — add an SSE serialization test asserting the kebab string appears in the wire payload.

In `ActivePrPoller` state class, add `public MergeReadiness? LastMergeReadiness { get; set; }`.

- [ ] **Step 8: Write the failing poller test**

Add to a new `tests/PRism.Core.Tests/PrDetail/ActivePrPollerReadinessTests.cs` (the poller tests live under `PrDetail/`, not `ActivePr/`):

```csharp
[Fact]
public async Task Publishes_on_readiness_change_with_no_head_or_comment_change()
{
    // Same head/base/counts across ticks, only mergeStateStatus UNKNOWN -> CLEAN.
    var reader = new FakeBatchReader(
        tick1: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.None),
        tick2: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.Ready));
    var (poller, bus, now) = NewPoller(reader, subscribed: new PrReference("o", "r", 1));

    await poller.TickAsync(now, default);          // first poll seeds
    bus.Published.Clear();
    await poller.TickAsync(now.AddSeconds(30), default);

    bus.Published.OfType<ActivePrUpdated>().Single()
        .Should().Match<ActivePrUpdated>(e => e.MergeReadinessChanged && e.MergeReadiness == MergeReadiness.Ready);
}

[Fact]
public async Task Whole_tick_abort_retains_last_known_and_does_not_publish_blank()
{
    var reader = new FakeBatchReader(
        tick1: Ready(headSha: "h", comments: 0, reviews: 0, readiness: MergeReadiness.Ready),
        throwOnTick2: new RateLimitExceededException("rate", null));
    var (poller, bus, now) = NewPoller(reader, subscribed: new PrReference("o", "r", 1));

    await poller.TickAsync(now, default);
    bus.Published.Clear();
    await poller.TickAsync(now.AddSeconds(30), default); // aborts

    bus.Published.Should().BeEmpty(); // no blanking publish; last-known retained for next tick
}
```

- [ ] **Step 9: Run to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ActivePrPollerReadinessTests`
Expected: FAIL — poller still per-ref REST; no `MergeReadinessChanged`.

- [ ] **Step 10: Rewrite `TickAsync` to batch**

In `PRism.Core/PrDetail/ActivePrPoller.cs`, inject `IActivePrBatchReader` and rewrite `TickAsync`: gather `UniquePrRefs()`, drop refs whose `NextRetryAt > now`, issue **one** `PollBatchAsync` for the rest. On `RateLimitExceededException`/transport abort, apply backoff to all candidate refs and **return without publishing** (retain last-known — whole-tick-abort contract). On success, run the existing per-ref diff/publish using the returned snapshot, adding the anti-flicker `readinessChanged` trigger (below) to the publish condition and to the published `ActivePrUpdated`. A ref absent from the returned map (per-alias null) keeps its last-known and does not publish:

```csharp
internal async Task TickAsync(DateTimeOffset now, CancellationToken ct)
{
    var candidates = _registry.UniquePrRefs()
        .Where(r => _state.GetOrAdd(r, _ => new ActivePrPollerState()).NextRetryAt is not { } t || t <= now)
        .ToList();
    if (candidates.Count == 0) return;

    IReadOnlyDictionary<PrReference, ActivePrPollSnapshot> snapshots;
    try
    {
        snapshots = await _batch.PollBatchAsync(candidates, ct).ConfigureAwait(false);
    }
    catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
    catch (RateLimitExceededException ex)
    {
        // Expected backoff (GitHub rate limit). Retain last-known for all candidates, back off, publish nothing.
        s_pollRateLimitedLog(_logger, candidates.Count, ex);
        foreach (var r in candidates) ApplyBackoff(_state[r], now);
        return;
    }
    catch (Exception ex)
    {
        // Whole-tick abort on transport / poison payload (e.g. JsonException from a truncated body
        // or a GitHub schema change). Log at ERROR so a persistent break is visible — a silent
        // back-off-every-tick would otherwise mask it. Retain last-known, back off, publish nothing.
        s_pollTickFailedLog(_logger, candidates.Count, ex);
        foreach (var r in candidates) ApplyBackoff(_state[r], now);
        return;
    }

    foreach (var prRef in candidates)
    {
        if (!snapshots.TryGetValue(prRef, out var snapshot)) continue; // per-alias drop: keep last-known
        var state = _state[prRef];
        var firstPoll = state.LastHeadSha is null && state.LastCommentCount is null;
        var headChanged = state.LastHeadSha is { } ph && ph != snapshot.HeadSha;
        var baseChanged = state.LastBaseSha is { } pb && pb != snapshot.BaseSha;
        var commentChanged = state.LastCommentCount is { } pc && pc != snapshot.CommentCount;
        var stateChanged = state.LastPrState is { } ps && ps != snapshot.PrState;
        // Anti-flicker: only a change TO a real (non-None) readiness publishes. A transient
        // None (GitHub's async mergeStateStatus recompute returning UNKNOWN) must not blank or
        // churn the live badge — never-cache-UNKNOWN (D4) applied to the live surface. Terminal
        // Merged/Closed are non-None and ride stateChanged anyway, so the badge still clears on merge.
        var readinessChanged = state.LastMergeReadiness is { } pr && pr != snapshot.MergeReadiness
            && snapshot.MergeReadiness != MergeReadiness.None;

        if (firstPoll || headChanged || baseChanged || commentChanged || stateChanged || readinessChanged)
        {
            var commentDelta = state.LastCommentCount is { } prior ? snapshot.CommentCount - prior : 0;
            _bus.Publish(new ActivePrUpdated(
                prRef,
                HeadShaChanged: headChanged,
                CommentCountChanged: commentChanged,
                NewHeadSha: headChanged ? snapshot.HeadSha : null,
                CommentCountDelta: commentDelta,
                IsMerged: snapshot.PrState == PrState.Merged,
                IsClosed: snapshot.PrState == PrState.Closed,
                BaseShaChanged: baseChanged,
                NewBaseSha: baseChanged ? snapshot.BaseSha : null,
                MergeReadiness: snapshot.MergeReadiness,
                MergeReadinessChanged: readinessChanged,
                Approvals: snapshot.Approvals,
                ChangesRequested: snapshot.ChangesRequested));
        }

        state.LastHeadSha = snapshot.HeadSha;
        state.LastBaseSha = snapshot.BaseSha;
        state.LastCommentCount = snapshot.CommentCount;
        state.LastPrState = snapshot.PrState;
        // Retain last-known non-None readiness so a transient UNKNOWN→None doesn't reset the
        // baseline and cause a redundant re-publish on the next None→Ready flap.
        if (snapshot.MergeReadiness != MergeReadiness.None)
            state.LastMergeReadiness = snapshot.MergeReadiness;
        state.ConsecutiveErrors = 0;
        state.NextRetryAt = null;
        _cache.Update(prRef, new ActivePrSnapshot(snapshot.HeadSha, null, now, snapshot.BaseSha));
    }
}
```

(`_batch` is the injected `IActivePrBatchReader`, added as a new ctor parameter on `ActivePrPoller`; keep `_review.PollActivePrAsync` untouched for its 3 non-poller callers. Replace the old per-ref `s_pollFailedLog` `LoggerMessage` with two per-tick-count delegates: `s_pollRateLimitedLog` (info/warning) and `s_pollTickFailedLog` (error).)

- [ ] **Step 10b: Migrate the existing poller tests + verify DI ordering**

Adding the `IActivePrBatchReader` ctor parameter breaks every `new ActivePrPoller(registry, review, bus, cache, logger, env)` call site and changes tick behavior (the per-ref REST path no longer runs). Update the four existing test files under `tests/PRism.Core.Tests/PrDetail/` — `ActivePrCacheTests.cs`, `ActivePrPollerBackoffTests.cs`, `ActivePrPollerSnapshotLogTests.cs`, `ActivePrPollerSubscriberFaultTests.cs`:
- Construct the poller with a fake `IActivePrBatchReader` and seed snapshots via `PollBatchAsync` (one returned dictionary per tick) instead of the old `review.SetSnapshot(...)` per-ref REST seeding.
- The backoff / snapshot-log / subscriber-fault behaviors now exercise the batched path: a fake reader that throws `RateLimitExceededException` drives backoff; one that returns a partial dictionary drives per-alias drop; one that returns changed snapshots drives the publish/log assertions.
- Run each migrated file to confirm it compiles and passes against the new tick.

**DI ordering:** `AddHostedService<ActivePrPoller>()` (in `PRism.Core/ServiceCollectionExtensions.cs`) now resolves `IActivePrBatchReader`, whose implementation is registered in `PRism.GitHub/ServiceCollectionExtensions.cs` (Step 11). Confirm the composition root (`PRism.Web/Program.cs`) calls the GitHub registration **before or alongside** the Core registration so the hosted service resolves at startup (DI resolution is order-independent within a single `BuildServiceProvider`, but both `AddXxx` calls must run before `Build()` — verify both are wired in `Program.cs`).

- [ ] **Step 11: Register the reader**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, register `IActivePrBatchReader` mirroring the `IPrBatchReader` registration (same token/host/factory closures):

```csharp
// Interface in PRism.Core.PrDetail; implementation in PRism.GitHub.ActivePr. The host closure
// reads config.Current at call time (hot-reloadable host) — matches the IPrBatchReader registration.
services.AddSingleton<PRism.Core.PrDetail.IActivePrBatchReader>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    var config = sp.GetRequiredService<IConfigStore>();
    return new PRism.GitHub.ActivePr.GitHubActivePrBatchReader(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        () => config.Current.Github.Host,
        sp.GetRequiredService<ILogger<PRism.GitHub.ActivePr.GitHubActivePrBatchReader>>());
});
```

- [ ] **Step 12: Thread readiness through the FE hook**

In `frontend/src/hooks/useActivePrUpdates.ts`, the `mergeReadiness?: MergeReadiness` field already exists on `ActivePrUpdates` (added as the carve-out stub in Task 6 Step 1). Now **populate** it: read the readiness fields from the `pr-updated` event and store the latest value, latching on `mergeReadinessChanged`:

```ts
import type { MergeReadiness } from '../components/shared/mergeReadiness';
// in the handler:
mergeReadiness: event.mergeReadinessChanged ? event.mergeReadiness : s.mergeReadiness,
```

(Also extend the SSE event type the stream emits with `mergeReadiness`/`mergeReadinessChanged` so the handler reads typed fields, matching the `ActivePrUpdatedWire` shape from Step 7.)

Add a FE test in `frontend/src/hooks/useActivePrUpdates.test.ts` asserting a `pr-updated` event with `mergeReadinessChanged: true, mergeReadiness: 'ready'` surfaces `mergeReadiness === 'ready'`.

- [ ] **Step 13: Run all Slice B tests**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ActivePrPoller` (covers the new `ActivePrPollerReadinessTests` **and** the migrated `ActivePrCacheTests`/`ActivePrPollerBackoffTests`/`ActivePrPollerSnapshotLogTests`/`ActivePrPollerSubscriberFaultTests`)
Then: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter FullyQualifiedName~GitHubActivePrBatchReaderTests`
Then (from `frontend/`): `npx vitest run src/hooks/useActivePrUpdates.test.ts`
Expected: PASS.

- [ ] **Step 14: Measure GraphQL point cost (epic #598 mandate)**

Capture live via `gh api graphql` with the exact emitted query + the reader's `rateLimit{cost remaining}` log (write results into the PR `## Proof`):
- Inbox-batch increment from adding the readiness scalars + `latestReviews` (12-alias and 100-alias; expected ≈ 0 for scalars, small for `latestReviews`).
- Active-poll batch cost per tick for N = 1, 5, 20 subscribed PRs vs the eliminated `N × 3` REST round-trips.
- A steady-state-`UNKNOWN` run (subscription set dominated by no-push-access PRs that re-derive `None` every tick).

- [ ] **Step 15: Commit**

```bash
git add PRism.GitHub/GitHubGraphQL.cs PRism.GitHub/Inbox/GitHubPrBatchReader.cs \
  PRism.Core/PrDetail/IActivePrBatchReader.cs PRism.GitHub/ActivePr/GitHubActivePrBatchReader.cs \
  PRism.Core.Contracts/ActivePrPollSnapshot.cs PRism.Core/PrDetail/ActivePrPoller.cs \
  PRism.Core/Events/ActivePrUpdated.cs PRism.Web/Sse/SseEventProjection.cs \
  PRism.GitHub/ServiceCollectionExtensions.cs frontend/src/hooks/useActivePrUpdates.ts \
  tests/PRism.GitHub.Tests/ActivePr/GitHubActivePrBatchReaderTests.cs \
  tests/PRism.Core.Tests/PrDetail/ActivePrPollerReadinessTests.cs \
  tests/PRism.Core.Tests/PrDetail/ActivePrCacheTests.cs \
  tests/PRism.Core.Tests/PrDetail/ActivePrPollerBackoffTests.cs \
  tests/PRism.Core.Tests/PrDetail/ActivePrPollerSnapshotLogTests.cs \
  tests/PRism.Core.Tests/PrDetail/ActivePrPollerSubscriberFaultTests.cs \
  frontend/src/hooks/useActivePrUpdates.test.ts
git commit -m "feat(593): Slice B — batched active-poll GraphQL reader + live readiness/SSE (epic #598)"
```

---

### Task 8: Visual polish + B1 screenshots (gated)

The B1 UI-visual gate — live validation in both themes, WCAG contrast, parity-baseline regen.

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts` (inbox baseline regen) + a new `frontend/e2e/readiness.spec.ts` (state matrix + tooltip)
- Test: live app + Playwright

- [ ] **Step 1: Build + run the full FE suite + typecheck**

Run (from `frontend/`): `npx vitest run` then `npx tsc -b` (project-references real typecheck, not `--noEmit`).
Expected: all green, no type errors.

- [ ] **Step 2: Author the readiness visual spec**

Create `frontend/e2e/readiness.spec.ts` covering the 8 rendered open states (Ready / ReadyWithChangesRequested / Conflicts / BehindBase / ChangesRequested / ReviewRequired / BlockedByProtection / Unstable) in **light and dark**, the open tooltip popover, and confirmation that Merged/Closed/Draft rows show **no** badge. Reuse the repo conventions: `SCREENSHOT_OPTS = { maxDiffPixelRatio: 0.02 }`, `KILL_ANIMATIONS_CSS`, `test.skip(!process.env.CI, …)` for pixel baselines, baselines under `__screenshots__/linux/`. Inject states via the existing test-hook route (e.g. `/test/advance-head` pattern) or a route-mock fulfilling the inbox/detail payload with each `mergeReadiness`.

- [ ] **Step 3: Live B1 validation (both themes)**

Launch via `run.ps1 -Reset None --no-browser` (Development + real PAT; serve detached per repo memory). Validate live in light **and** dark:
- The 8 open-state chips read correctly; the four yellows are distinguishable by label.
- `ReadyWithChangesRequested` dimmed-green is at-a-glance distinct from both plain `Ready` and the yellow family; tune `--readiness-ready-caveat-soft` per theme if not.
- WCAG **AA 4.5:1** label-on-chip + tooltip-text contrast in both themes (1px-canvas method, per repo memory — `getComputedStyle().color` returns authored oklch).
- The amber caveat dot clears **3:1 non-text contrast** against the dimmed-green background in both themes.
- The empty-CI row's number/title align with a CI row (alignment contract); `#N` renders on every row.
- Screen reader announces the short label (inbox aria-label) and the tooltip facts (`aria-describedby`) on focus.

- [ ] **Step 4: Regen the Linux parity baseline**

Per repo memory: download the CI `e2e-results` `actual.png` artifact, verify the diff is the intended inbox change (CI relocation + `#N` + badge), `cp` over the Linux baseline, push. (Parity baselines are CI-Linux-only; the 2% tolerance may already absorb small shifts — reconcile any "baseline will change" claim against the actual green e2e before regenerating.)

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/readiness.spec.ts frontend/e2e/parity-baselines.spec.ts \
  frontend/e2e/__screenshots__/linux
git commit -m "test(593): B1 readiness visual specs + parity baseline regen"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:
- §4 enum + 12-row precedence + cross-axis + dimmed variant → Task 1 (rule + exhaustive matrix).
- §4 label table (short/long), §6 tooltip one-liners → Task 1 (FE module).
- §5 feed 1 (inbox batch, `FromTimestamps` reconstruction, `latestReviews` counts) → Task 2.
- §5 feed 2 (detail full load, `reviewDecision`, counts, no-op review state) → Task 5.
- §5 feed 3 + §7 whole-tick-abort + §8 measurement + §9 count parity → Task 7.
- §6 badge both surfaces, label-always-visible, tooltip contract (300ms/focus/singleton/live-update/close-on-None/Escape/blur/`aria-describedby`/clip-safe), tokens, amber dot → Tasks 3, 4, 6.
- §6 inbox: `#N` (#516), CI relocation + fixed slot, `.tail` priority, layout-shift → Task 4.
- D5 open-only / merged-PR fix → enforced in Task 1 (`isBadgeRendered`) and asserted in Tasks 4 & 6.
- §10 tests → distributed per task (rule matrix, count-derivation, badge singleton/live/dot, `#N`, CI slot, count parity, whole-tick-abort). §10 B1 + §12 AC → Task 8.
- §13 deferrals (touch tooltip, per-yellow glyph, shared-primitive extraction, `--merged-soft`/Closed badge tokens, legacy `Mergeability` removal) → not implemented, recorded.

**2. Placeholder scan** — no "TBD/TODO/implement later"; every code step shows code. Two deliberate "find the exact site" instructions remain (the orchestrator `with`-merge in Task 2 Step 11; the app-root provider nest in Task 3 Step 6) — these name the exact file + the established pattern to match, not vague hand-waves, because the precise surrounding lines weren't captured in exploration. Flagged for the implementer.

**3. Type consistency** — `MergeReadiness` (C# enum) ↔ kebab TS union verified member-by-member (`BehindBase`→`behind-base`, `ReadyWithChangesRequested`→`ready-with-changes-requested`, `BlockedByProtection`→`blocked-by-protection`). `Derive` signature identical across Tasks 1/2/5/7. `CountLatestReviews` single home (Task 5 consolidates Task 2's copy). `ActivePrPollSnapshot`/`ActivePrUpdated`/`ActivePrUpdatedWire`/`useActivePrUpdates` carry the same `MergeReadiness` + `Approvals`/`ChangesRequested` fields. `PollBatchAsync` returns `IReadOnlyDictionary<PrReference, ActivePrPollSnapshot>` consumed by `ActivePrPoller.TickAsync`.

**Deviations from the spec (documented, for `## Proof`):**
- **Dropped `--merged-soft` / gray-Closed badge tokens** (spec §6 lists them): merged/closed render no badge (D5), so these would be unused — YAGNI. Only the 8 open-state chip classes + `--readiness-ready-caveat-soft` are authored.
- **Added a new `readinessChanged` publish trigger** (not explicit in the spec): readiness can change with no head/comment/review-count change (UNKNOWN→CLEAN, `reviewDecision` flip), so without it the live badge would miss those transitions. Required to satisfy "the badge updates live."
- **Added `Pr.UpdatedAt` + `updatedAt` to the detail query/DTO**: spec §6 claims `UpdatedAt` is "already on every DTO," but `PrDetailPr` had only `openedAt`. One scalar added so the detail tooltip's "Updated Xh ago" fact works; inbox already had it.
- **Single-PR `PollActivePrAsync` leaves `MergeReadiness = None`**: REST `/pulls/{n}` has no `reviewDecision`, and its 3 non-poller callers consume only `HeadSha`; the batched path is the readiness source.

**Carve-out reminder (Global Constraints):** Tasks 1–6 are green-independent of Task 7. If Task 7 lags, ship Tasks 1–6 (badge on the existing REST poll via the additive field) and carve Slice B into a follow-up perf-only PR.

**ce-doc-review round 1 (6 personas) — corrections folded in.** Verified against the codebase; the material fixes: count parity now sums per-thread `comments.totalCount` (was the wrong `reviewThreads.totalCount` thread count — would have broken the SSE "new comment" delta); `IActivePrBatchReader` interface moved to `PRism.Core/PrDetail/` (Core can't reference PRism.GitHub — was a compile break); the four existing `ActivePr*` poller tests + ctor + DI migration added (Task 7 Step 10b); `GraphQlByteIdentityTests` literal update added (Task 5 Step 5b — pinned-query guard); `InboxRefreshOrchestrator.ComputeDiff` gains `MergeReadiness` so readiness-only flips publish `InboxUpdated`; all `PRism.Core/ActivePr/*` paths corrected to `PrDetail/` + `Events/`; `BatchPrData` located in `PRism.Core/Inbox/IPrBatchReader.cs`; `CountLatestReviews` single-homed in `GitHubPrParser` from Task 2; `ThrowIfRateLimited` is `internal` (not `public`) with the call-site refactor shown; `readinessChanged` gains an anti-flicker None guard; the merged-transition comment corrected (the poll *does* detect merges via `state`) + tests added; tooltip scroll-close now spares keyboard-focused triggers; `.num` truncation CSS fixed; explicit `.trigger:focus-visible`; `ageLine` upper-bound guard; distinct badge `aria-label`; per-theme caveat-soft directional value; SSE kebab-serialization verification note. The single owner-decision finding (1-PR-with-carve-out vs upfront 2-PR split, re-raised given the parity bug — now fixed) is surfaced to the human-review gate, not auto-resolved.

