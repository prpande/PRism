# Rich, color-coded PR merge-readiness indicator (inbox + PR detail) — Design

**Issue:** #593 · **Epic:** #598 (Slice C, absorbing Slice B) · **Date:** 2026-06-24
**Classification:** T3 (net-new cross-tier behavior: inbox + PR detail + backend), **gated B1 — UI-visual** (color coding, both themes). Human spec/plan review gates retained.

## 1. Goal

Show a **rich, color-coded merge-readiness indicator** on both the **inbox** and the **PR-detail** page so a user can tell at a glance whether a PR can merge — and if not, *why not*. Replace today's bare `mergeability` chip (raw `MERGEABLE`/`CONFLICTING` text, no color, no merged-PR guard) and add an inbox indicator where there is none today.

This slice also folds in **epic #598 Slice B**: the PR-detail active poller currently makes **3 REST calls per tick per subscribed PR** (`/pulls/{n}`, `/pulls/{n}/comments?per_page=1`, `/pulls/{n}/reviews?per_page=1`). We replace that with **one aliased-batch GraphQL query per tick across all subscribed PRs**, reusing the #532 `GitHubPrBatchReader` pattern. The same query supplies the live merge-readiness signal, so the badge updates without a full reload.

Backend derivation is the single source of truth; the frontend renders color + copy. No new diff/DTO breakage beyond the additive fields described below.

## 2. Locked decisions

- **D1 — CI stays a separate, parallel signal.** The existing CI octicon (`GitHubCiFailingDetector`, REST: check-runs + legacy commit-status) is **untouched**. Merge-readiness does **not** subsume it. Rationale: `statusCheckRollup` (GraphQL) covers modern Actions only and would lose legacy-status coverage; the epic explicitly keeps the inbox CI detector on REST. Check-*failure* detail is therefore the CI dot's job, not the readiness indicator's.
- **D2 — `BLOCKED` reason is `mergeStateStatus`-level only.** No branch-protection/ruleset reads, no per-rule counts, no classic-PAT-scope dependency. Granularity within `BLOCKED` comes from `reviewDecision` (already in the query), not from extra API calls.
- **D3 — Slice B batches across all subscribed PRs.** One aliased GraphQL query per poll tick for every subscribed PR (cap 100/query, mirroring `GitHubPrBatchReader`). `N × 3` REST → `1` GraphQL per tick.
- **D4 — `UNKNOWN` handled by cadence, not bespoke logic.** GitHub computes `mergeable`/`mergeStateStatus` asynchronously; the first read often returns `UNKNOWN`/null. The existing poller re-reads every tick, so `UNKNOWN` resolves naturally **when the viewer has push access**. Discipline: **never cache `UNKNOWN`** (the same rule `GitHubCiFailingDetector` applies to `Pending`). Caveat: for **no-push-access / review-only PRs**, `mergeStateStatus` stays `UNKNOWN` *permanently* — that is a stable terminal `None`, not a transient one. It is correct and cheap (scalar fields), but the never-cache rule means those rows re-derive every tick forever; §8 measurement covers this steady-state case.
- **D5 — Draft and Unknown show NO indicator.** Draft is already conveyed by the existing Draft chip (detail, #501) and the PR-state glyph (inbox); a readiness mark would duplicate it. Unknown → neutral absence. Both are still computed server-side (honest data); the frontend renders nothing, exactly as it does for CI `none`.

## 3. Architecture — backend-derived enum, frontend-owned presentation

Three approaches were weighed:

- **A.** Backend derives state **and** reason string, exposed on every DTO.
- **B.** Pass raw GitHub enums to the frontend; derive in TS.
- **C. (chosen)** Backend derives the **precedence-resolved state enum**; the frontend owns color + reason copy.

**C** matches PRism's established split: the PR-state glyph map and CI labels already live in the frontend, while precedence and defensive ("unrecognized enum → Unknown") logic lives in a pure, unit-tested Core function — mirroring #532's `AwaitingAuthorRule`. Given D2 (no counts), each state maps to a fixed reason string, so copy belongs with PRism's other UI strings. The backend wire contract stays a clean enum.

## 4. Derived model + precedence

A pure function in `PRism.Core.Contracts`:

```csharp
public enum MergeReadiness
{
    None,                 // Draft / Unknown / null / unrecognized / no-push-access → render nothing
    Merged,
    Closed,
    Conflicts,
    BehindBase,
    ChangesRequested,
    ReviewRequired,
    BlockedByProtection,
    Unstable,
    ReadyWithChangesRequested, // mergeable, but a reviewer requested changes (protection doesn't require review)
    Ready,
}

public static class MergeReadinessRule
{
    // All raw GitHub enum inputs are nullable strings compared case-insensitively;
    // unrecognized values fall through to None (never throw — these fields are
    // semi-documented and in-flux).
    public static MergeReadiness Derive(
        PrState state,
        bool isDraft,
        string? mergeable,        // MERGEABLE | CONFLICTING | UNKNOWN | null
        string? mergeStateStatus, // CLEAN|DIRTY|BEHIND|BLOCKED|UNSTABLE|HAS_HOOKS|DRAFT|UNKNOWN|null
        string? reviewDecision);  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
}
```

**Precedence (first match wins):**

| # | State | Trigger | Indicator color |
|---|---|---|---|
| 1 | `Merged` | `state == Merged` | purple / neutral |
| 2 | `Closed` | `state == Closed` (unmerged) | gray |
| 3 | `None` (Draft) | `isDraft` or `mergeStateStatus == DRAFT` | **none** |
| 4 | `Conflicts` | `mergeStateStatus == DIRTY` or `mergeable == CONFLICTING` | red |
| 5 | `BehindBase` | `mergeStateStatus == BEHIND` | yellow |
| 6 | `ChangesRequested` | `mergeStateStatus == BLOCKED && reviewDecision == CHANGES_REQUESTED` | red |
| 7 | `ReviewRequired` | `mergeStateStatus == BLOCKED && reviewDecision == REVIEW_REQUIRED` | yellow |
| 8 | `BlockedByProtection` | `mergeStateStatus == BLOCKED` (otherwise: approved/null → required check or other protection) | yellow |
| 9 | `Unstable` | `mergeStateStatus == UNSTABLE` | yellow |
| 10 | `ReadyWithChangesRequested` | (`mergeStateStatus == CLEAN` or `HAS_HOOKS`) **and** `reviewDecision == CHANGES_REQUESTED` | **dimmed green** (+ amber caveat dot) |
| 11 | `Ready` | `mergeStateStatus == CLEAN` or `HAS_HOOKS` | green |
| 12 | `None` (Unknown) | `mergeStateStatus == UNKNOWN` / null / unrecognized; `mergeable == UNKNOWN` with no stronger signal; no-push-access | **none** |

Notes:
- **Terminal states win** (Merged/Closed before everything) — this fixes the issue's merged-PR contradiction *by construction*.
- **`BLOCKED` granularity** is purely the review/protection axis (D1: check-failure is the CI dot's job). `ChangesRequested` (a reviewer explicitly blocked, red/actionable) reads differently from `ReviewRequired` (needs approvals, yellow/waiting) and `BlockedByProtection` (approved but a required check / other rule unmet, yellow).
- `reviewDecision` subdivides two buckets: `BLOCKED` (rows 6–8) and the clean-but-changes-requested case (row 10). It is never a standalone state. **Resolved (owner decision):** a PR with `reviewDecision == CHANGES_REQUESTED` but `mergeStateStatus == CLEAN` (a reviewer requested changes where protection does **not** require review) can technically merge, so it is **not** red `ChangesRequested`; but showing plain green `Ready` would hide the open request. It renders as `ReadyWithChangesRequested` — a **dimmed-green** chip with an amber caveat dot (short "Ready (changes)", long "Ready — changes requested"). This keeps the can-this-merge truth (green family) while flagging the caveat.
- **`mergeable == CONFLICTING` is an independent conflict source.** Row 4 ORs it in deliberately so a PR with `mergeable == CONFLICTING` but `mergeStateStatus ∈ {BEHIND, BLOCKED, UNSTABLE, UNKNOWN}` still resolves to `Conflicts` — conflicts dominate. This cross-axis behavior is enumerated in the §10 test matrix so a future row-reorder cannot regress conflicts-hidden-behind-BEHIND.
- Colors are the starting mapping; final pixels are B1-validated live in both themes.

**Labels — single source-of-truth module, two forms per state (frontend-owned).** One state→label module exposes a **short** form (inbox compact badge) and a **long** reason string (PR-detail). The two forms are intentionally different text, not a contradiction; presentation/CSS controls compactness, not separate maps.

| State | Short (inbox) | Long (detail reason) |
|---|---|---|
| Merged | "Merged" | "Merged" |
| Closed | "Closed" | "Closed" |
| Conflicts | "Conflicts" | "Has conflicts" |
| BehindBase | "Behind" | "Out of date with base" |
| ChangesRequested | "Changes requested" | "Changes requested" |
| ReviewRequired | "Review required" | "Review required" |
| BlockedByProtection | "Blocked" | "Blocked by branch protection" |
| Unstable | "Unstable" | "Checks unstable" |
| ReadyWithChangesRequested | "Ready (changes)" | "Ready — changes requested" |
| Ready | "Ready" | "Ready to merge" |

The four yellow states (BehindBase, ReviewRequired, BlockedByProtection, Unstable) are color-identical; their short labels are distinct with **no shared prefix** that truncation could collapse, so the text axis always disambiguates them (see §6 label-always-visible contract).

## 5. Data flow — three feeds, one derivation

`MergeReadiness` is exposed on three DTOs, each populated from signals its fetch already has (plus `reviewDecision`):

1. **Inbox** — `PrInboxItem.MergeReadiness`. Extend the #532 `GitHubPrBatchReader` GraphQL query (per alias) with `mergeable mergeStateStatus reviewDecision`; derive in the batch reader's parse path; expose on `PrInboxItem`. Note: `state`/`isDraft` already arrive via the separate section-query path (`RawPrInboxItem`), so the batch reader adds only the three readiness scalars and sources `state`/`isDraft` from the raw item rather than re-fetching them. Runs in the existing inbox-refresh batch — **no new round-trips**; measure incremental point cost per epic rule.
2. **PR-detail full load** — `Pr.MergeReadiness` (on the `Pr` record inside `PrDetailDto`). `GetPrDetailAsync`'s `PrDetailGraphQLQuery` today reads `mergeable` into `Mergeability` and **discards `mergeStateStatus`** (it already fetches it; despite the inline comment, no real "collapse" happens). **Add `reviewDecision`** to the query and feed `mergeable + mergeStateStatus + reviewDecision + state + isDraft` into `Derive` in `GitHubPrParser.ParsePr`; expose. The legacy `string Mergeability` field is retained for now (see §9) but no longer drives the UI.
3. **PR-detail active poll (Slice B)** — `ActivePrPollSnapshot.MergeReadiness` + the `pr-updated` SSE payload. Replace the poll tick's 3 REST calls with **one batched GraphQL across all subscribed PRs**. Architecture notes for the planner:
   - **The existing `PollActivePrAsync(PrReference, ct)` single-PR seam stays** — it has three non-poller callers that are inherently single-PR/synchronous-to-a-request (`PrDetailLoader` head probe on mount, `PrSubmitEndpoints` pre-submit head check, the `SubmitPipeline` pre-finalize re-poll). Slice B does **not** mutate that shared method; it adds a **separate batched multi-ref path** the `ActivePrPoller.TickAsync` loop calls once per tick.
   - The batched reader mirrors `GitHubPrBatchReader` (shared transport `GitHubGraphQL.PostAsync`, `rateLimit{cost remaining}`, per-alias isolation, 100-cap). The planner must decide whether to **parameterize/reuse** `GitHubPrBatchReader` or add a sibling class, and justify it on query-shape grounds (the poll needs `mergeable mergeStateStatus reviewDecision state isDraft` + comment/review counts per PR, not the inbox reader's review-history selection) — do not silently duplicate.
   - **Per-PR isolation reconciliation:** today each ref has its own backoff (`NextRetryAt`), first-poll detection, and `ActivePrUpdated` diff. Per-*alias* null isolation survives (one bad PR drops just that PR), but a whole-tick failure now affects every subscribed PR at once — see §7 degradation contract.
   - Snapshot carries the derived readiness + the comment/review counts (with REST-equivalent semantics, see §9), so the badge updates live without a full reload.

Frontend types (`frontend/src/api/types.ts`): add `mergeReadiness` to the inbox item type and the PR-detail type; consume in `InboxRow.tsx` and `PrHeader.tsx`; thread the poll field through `useActivePrUpdates` → `PrDetailView`.

## 6. Presentation

A **color-coded badge appears on BOTH surfaces** (inbox and PR detail), driven by the same `MergeReadiness` value and the same `.chip-readiness-*` token set — a compact variant on the inbox, an expanded variant on detail. `None` (Draft/Unknown) renders nothing on both (matches the CI `none` pattern). Merged/closed show their terminal badge and **never** a mergeable/conflicting badge.

**Inbox terminal-state glyph suppression (owner decision A).** On the inbox, when `MergeReadiness` is `Merged` or `Closed`, the readiness chip **replaces** (suppresses) the PR-state glyph for that row — the chip carries both the color and the label, so the glyph would be redundant. The PR-state glyph still renders for open/draft rows. (Draft itself still shows the glyph and no readiness chip per D5.)

**Label-always-visible contract (accessibility floor).** On both surfaces the **short text label is always rendered** — never collapsed to a bare color dot or an icon-only mark. Color is reinforcement, not the sole signal (WCAG 1.4.1, Use of Color); the four color-identical yellow states are distinguishable by label alone. B1 may tune chip width/padding but **may not** introduce a label-less variant; "the contract is a color-coded badge *with its label*, not a bare dot." The label may not truncate to a shared prefix.

- **Inbox row (`InboxRow.tsx`)** — a compact, color-coded readiness **badge** (chip) carrying the **short label** (§4 table), rendered **parallel to** the existing CI octicon and PR-state glyph (D1).
  - **Slot order & differentiation:** PR-state glyph (leading, by title) · CI octicon · readiness chip, grouped in the row's trailing status cluster. The readiness chip is a *labelled pill* and the CI octicon is a *bare icon* — the shape difference keeps two simultaneously-warning signals (e.g. failing CI + `Behind`) from reading as one alarm. Exact spacing/order within the trailing cluster is B1-validated live.
  - **Disclosure:** the short label is the **complete inbox disclosure** — there is **no hover tooltip**; the full reason string lives only on PR-detail. (Matches the CI octicon, which carries meaning via `aria-label`, not a tooltip.)
  - **Layout-shift:** when `MergeReadiness == None` the chip slot reserves **no horizontal space** (no skeleton, no placeholder) — identical to the CI `none` behavior — so a badge appearing after the first poll resolution does not shift the row.
- **PR-detail (`PrHeader.tsx:502`)** — replace the bare `chip chip-mergeability-${raw}` with the expanded color-coded badge **+ long reason** (§4 table). Reuses the shared `.chip-readiness-*` token set.

**Accessibility.** The chip is **informational and non-interactive** (no focus, no keyboard handler, no tooltip). Inbox: the state's short label is appended to the row's existing `aria-label` (e.g. "PR #593 … — Ready"), with the same single source-of-truth label module the detail view uses. Detail: the long reason renders as visible text inside the chip, so it is announced directly. A screen-reader announcement check is added to the B1 gate (§10).

**Tokens.** New `.chip-readiness-*` rules in `tokens.css` map each state to PRism's existing semantic soft/fg pairs (`--success-soft`/`--success-fg` green, `--warning-soft`/`--warning-fg` yellow, `--danger-soft`/`--danger-fg` red), plus a new `--merged-soft` purple pair (`--merged-fg` already exists) and a neutral `--surface-3`/`--text-2` gray for Closed. `ReadyWithChangesRequested` is a **dimmed green** (success-soft mixed toward surface) with a leading amber (`--warning`) caveat dot. Because PRism's oklch surface scale is **theme-asymmetric** (light descends, dark ascends/compressed — repo memory), each rule resolves through theme-scoped tokens (the semantic pairs are already per-theme; `--merged-soft` adds both). Label-on-chip text must clear **WCAG AA 4.5:1** contrast in both themes, measured live at B1 (1px-canvas method), not eyeballed from a screenshot.

## 7. Error handling / degradation

- Unrecognized `mergeStateStatus`/`mergeable`/`reviewDecision` → `None` (Unknown bucket). Never throw on a new enum value.
- `UNKNOWN`/null (incl. no-push-access) → `None`, neutral absence, no error. Not cached → resolves on the next poll/refresh tick (D4).
- Per-alias null/malformed node in either batch drops just that PR (inherits #532's per-alias isolation; one bad PR never aborts the tick).
- Rate-limit model inherited from `GitHubPrBatchReader`: HTTP 429 or a 200 body with `errors[].type==RATE_LIMITED` → `RateLimitExceededException` (poller backs off); other transport failures abort the tick.
- **Whole-tick abort contract (active poll).** Because Slice B issues one query for all subscribed PRs, a rate-limit/back-off or a chunk-level `data:null` now affects **every** subscribed PR in that tick, not one. The live surface must degrade gracefully: on a missed/aborted tick the readiness badge (and comment/review counts) **retain their last-known value — never blank** — and the poller resumes on the next tick. The SSE `pr-updated` consumer must not clear readiness on a skipped tick. (Contrast the inbox, where a missed batch just reuses the cached snapshot view.)

## 8. Rate-limit measurement (epic #598 mandate)

Every slice must report measured GraphQL point cost. Before/after to capture:
- **Inbox batch:** incremental cost of adding `mergeable mergeStateStatus reviewDecision state isDraft` to the existing per-alias selection (expected ≈ 0 — scalar fields on an already-fetched `pullRequest`). Measure 12-alias and 100-alias.
- **Active poll batch (Slice B):** point cost of the new batched poll query vs the eliminated `N × 3` REST round-trips. Report cost per tick for representative N (1, 5, 20 subscribed PRs). Include a **steady-state-`UNKNOWN`** run (a subscription set dominated by no-push-access PRs that re-derive `None` every tick forever) so the measurement reflects the permanent-UNKNOWN cost, not only the resolves-quickly case.
Captured live via `gh api graphql` with the exact emitted query + the reader's `rateLimit{cost remaining}` log, written into the PR `## Proof` section.

## 9. Parity gotchas

- **`mergeStateStatus` push-access dependency** — only fully accurate when the viewer has push access; for review-only PRs it can stay `UNKNOWN` → `None`. Bounds richness for external-repo PRs; the indicator degrades gracefully (D5).
- **Legacy `Mergeability` string** — retained on `Pr`/`ActivePrPollSnapshot` to avoid a wider wire-shape change in this slice (it has existing consumers/tests). It is no longer the UI source. A follow-up may remove it once all consumers move to `MergeReadiness`. (Flagged so the diff seam is explicit — see repo memory on getter-only/DTO wire changes.)
- **`MergeReadiness` serialization seam.** `MergeReadiness` is a **stored field** set at parse time (not a computed getter), so STJ writes it intentionally to the FE wire — that is the point. The planner must still confirm whether `ActivePrPollSnapshot`/`Pr` are persisted to disk or an in-process cache anywhere; if so, add a round-trip test (or `[JsonIgnore]` if it should not persist). Repo memory: STJ serializes getter-only props on write — keep `MergeReadiness` a plain field to avoid surprises.
- **Comment/review count parity — exact GraphQL fields (active poll).** The poll's `CommentCount` today comes from REST `pulls/{n}/comments` = **inline review comments**, and review count from `pulls/{n}/reviews`. **`pullRequest.comments.totalCount` is the WRONG field** — in GraphQL that is the *issue-level conversation timeline*, a different dataset. Using it would silently change what drives the SSE `pr-updated` "new activity" trigger (inline-comment activity would stop bumping it; conversation comments would start). Map review-comment count from `reviewThreads.totalCount`-derived or `Σ reviews.nodes.comments.totalCount`, and review count from `reviews.totalCount`. **Required test:** GraphQL `CommentCount` equals the REST `pulls/{n}/comments` count for a PR carrying both inline and conversation comments. (Inbox is unaffected — the inbox batch reader does not fetch comment counts via GraphQL; scope this to the active poll.)

## 10. Testing strategy

- **`MergeReadinessRuleTests`** (Core, pure, exhaustive): every precedence row, terminal-overrides (merged/closed beat everything), each `BLOCKED`×`reviewDecision` combination, unrecognized-enum → `None`, null inputs → `None`. **Cross-axis matrix:** `mergeable == CONFLICTING` paired with each `mergeStateStatus` value (BEHIND, BLOCKED, UNSTABLE, CLEAN, UNKNOWN) must yield `Conflicts`; `mergeable == MERGEABLE` with `mergeStateStatus == DIRTY` must also yield `Conflicts`; `reviewDecision == CHANGES_REQUESTED` with `mergeStateStatus == CLEAN`/`HAS_HOOKS` must yield `ReadyWithChangesRequested` (row 10, the dimmed variant — pin it so a reorder can't collapse it to plain `Ready` or red `ChangesRequested`), while `reviewDecision == CHANGES_REQUESTED` with `mergeStateStatus == BLOCKED` yields red `ChangesRequested`.
- **Inbox batch reader** (`GitHubPrBatchReaderTests` additions): new fields parsed; readiness derived per alias; per-alias isolation preserved; rate-limit cost asserted present.
- **Active-poll batch reader** (new tests, mirror the batch-reader suite): batched query shape across multiple subscribed PRs; derivation; **comment/review count parity — GraphQL count equals the REST `pulls/{n}/comments` count for a PR with both inline and conversation comments** (§9); whole-tick-abort retains last-known value (§7); rate-limit model (429 + 200/RATE_LIMITED); per-alias null tolerance.
- **Frontend** (vitest): inbox chip per state (incl. `None` → nothing, label always present) and detail badge + reason per state, both via the single label/color module; merged/closed never render a mergeable/conflicting badge; `None` chip slot reserves no width.
- **B1 visual gate** (Playwright): screenshots of the indicator across all rendered states (Ready/ReadyWithChangesRequested/Conflicts/BehindBase/ChangesRequested/ReviewRequired/**BlockedByProtection**/Unstable/Merged/Closed) in **light and dark**, validated live before lock — including the inbox terminal-glyph-suppression rows (Merged/Closed show chip, no glyph) and the dimmed `ReadyWithChangesRequested` variant. B1 also verifies: WCAG AA 4.5:1 label-on-chip contrast in both themes (1px-canvas), and the readiness label is announced by a screen reader on both surfaces.

## 11. Scope / slicing (for writing-plans)

Large T3; one PR (per the "Full #593" decision). Expected task order:
1. `MergeReadiness` enum + `MergeReadinessRule.Derive` + exhaustive tests (Core), **and** the shared frontend label/color module (short+long forms, §4 table) — defined once here so both UI tasks reference it, not redefine it.
2. Inbox feed: extend `GitHubPrBatchReader` query (add the 3 readiness scalars) + parse + `PrInboxItem` field + tests.
3. Inbox UI: `InboxRow.tsx` chip + the **complete `.chip-readiness-*` token set (all non-`None` states, both themes)** + tests. The token set is authored in full here (the state space is known at Core time); Task 5 only *references* it, never extends it. Task 3 is therefore a prerequisite for Task 5, not just independently testable.
4. PR-detail full-load feed: `PrDetailGraphQLQuery` (add `reviewDecision`) + `ParsePr` + `Pr` field + tests.
5. PR-detail UI: `PrHeader.tsx` badge + long reason, referencing the Task-1 label module and Task-3 tokens + tests.
6. Slice B: separate batched active-poll GraphQL reader (reuse-vs-sibling decision per §5.3) + `ActivePrPoller` tick wiring (single-PR `PollActivePrAsync` left intact for its 3 non-poller callers) + `ActivePrPollSnapshot`/SSE field + count-parity & whole-tick-abort tests; rate-limit measurement.
7. Visual polish + B1 screenshots.

**Sequencing risk (advisory).** Slice B (Task 6) is structurally independent of the badge — the badge could ship on the existing REST poll with an additive field — but per the "Full #593" decision it ships in this one PR. That makes Task 6 a **prerequisite-risk concentrator**: it can develop in parallel with Tasks 4/5, but the PR cannot merge until Task 6 (new reader, count-parity, rate-limit measurement, SSE wiring) is green. If Task 6 stalls, Tasks 1–5/7 are blocked from shipping. Sequence accordingly.

## 12. Acceptance criteria

- [ ] A color-coded merge-readiness **badge appears on BOTH the inbox and the PR-detail view**, driven by the same `MergeReadiness` value and shared token set.
- [ ] Inbox badge (compact, short state label) covers: Ready, ReadyWithChangesRequested, Conflicts, BehindBase, ChangesRequested, ReviewRequired, BlockedByProtection, Unstable, Merged, Closed (Draft/Unknown → no badge).
- [ ] PR-detail badge shows a **human-readable reason**, derived from `mergeStateStatus` (+ `reviewDecision` for the `BLOCKED` split and the dimmed `ReadyWithChangesRequested` variant), not the collapsed string.
- [ ] On the inbox, Merged/Closed rows show the readiness chip and **suppress** the PR-state glyph (decision A); the chip never renders a mergeable/conflicting badge for terminal PRs.
- [ ] A reviewer-requested-changes-but-mergeable PR renders the dimmed `ReadyWithChangesRequested` chip (green family + amber caveat dot), not plain green `Ready` nor red `ChangesRequested`.
- [ ] `UNKNOWN`/null and push-access-gap cases render **no** indicator without errors; resolve on a later tick (not cached).
- [ ] CI octicon behavior is unchanged (separate, parallel signal).
- [ ] Active poll makes **1 GraphQL call per tick** across all subscribed PRs (was `N × 3` REST); comment/review counts preserved; merge-readiness rides the snapshot/SSE so the badge updates live.
- [ ] Color coding verified in **both** light and dark themes (B1).
- [ ] GraphQL point cost measured (inbox-batch increment + active-poll) and reported in `## Proof`.

## 13. Deferrals / non-goals

- Per-branch-protection-rule detail / named unmet rule + counts (D2) — defer-candidate; needs ruleset reads + classic PAT.
- Removing the legacy `Mergeability` string (§9) — follow-up once consumers migrate.
- Folding CI into the readiness indicator (D1) — explicitly out of scope.
- Slice D (timeline per-commit changed-files batch) — separate epic child.
