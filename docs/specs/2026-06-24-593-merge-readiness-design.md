# Rich, color-coded PR merge-readiness indicator (inbox + PR detail) — Design

**Issue:** #593 · **Also closes:** #516 (inbox PR number) · **Epic:** #598 (Slice C, absorbing Slice B) · **Date:** 2026-06-24
**Classification:** T3 (net-new cross-tier behavior: inbox + PR detail + backend), **gated B1 — UI-visual** (color coding, both themes). Human spec/plan review gates retained.

## 1. Goal

Show a **rich, color-coded merge-readiness indicator** on both the **inbox** and the **PR-detail** page so a user can tell at a glance whether a PR can merge — and if not, *why not*. Replace today's bare `mergeability` chip (raw `MERGEABLE`/`CONFLICTING` text, no color, no merged-PR guard) and add an inbox indicator where there is none today.

This slice also folds in **epic #598 Slice B**: the PR-detail active poller currently makes **3 REST calls per tick per subscribed PR** (`/pulls/{n}`, `/pulls/{n}/comments?per_page=1`, `/pulls/{n}/reviews?per_page=1`). We replace that with **one aliased-batch GraphQL query per tick across all subscribed PRs**, reusing the #532 `GitHubPrBatchReader` pattern. The same query supplies the live merge-readiness signal, so the badge updates without a full reload. (**Slice C = this #593 merge-readiness badge; it "absorbs" Slice B** because the batched poll query it needs *is* Slice B's deliverable — there is no separate Slice C backend output beyond the badge plus the absorbed Slice B reader. Slice D remains a separate epic child, §13.)

Backend derivation is the single source of truth; the frontend renders color + copy. No new diff/DTO breakage beyond the additive fields described below.

**Folds in #516 — inbox PR number.** While reworking the inbox row's leading status cluster (D6), we also render the PR number (`#<number>`, already in the DTO as `pr.reference.number`) — frontend-only, no field. Today the inbox row shows everything *but* the number, while the Activity rail shows it prominently; #516 closes that inconsistency. Placement/styling are resolved by the approved mockup (see §6): a **mono, muted `#N` at the leading edge of the title**, matching the existing repo-label/Activity-rail number treatment, not a pill (keeps it off the metric-pill row, #357). This is bundled here purely because it touches the same two files the inbox task already rewrites (`InboxRow.tsx` + its CSS) and shares the same B1 visual gate and parity-baseline regen — one pass over the row layout, not two.

## 2. Locked decisions

- **D1 — CI stays a separate, parallel signal.** The existing CI octicon (`GitHubCiFailingDetector`, REST: check-runs + legacy commit-status) is **untouched**. Merge-readiness does **not** subsume it. Rationale: `statusCheckRollup` (GraphQL) covers modern Actions only and would lose legacy-status coverage; the epic explicitly keeps the inbox CI detector on REST. Check-*failure* detail is therefore the CI dot's job, not the readiness indicator's.
- **D2 — `BLOCKED` reason is `mergeStateStatus`-level only.** No branch-protection/ruleset reads, no per-rule counts, no classic-PAT-scope dependency. Granularity within `BLOCKED` comes from `reviewDecision` (already in the query), not from extra API calls.
- **D3 — Slice B batches across all subscribed PRs.** One aliased GraphQL query per poll tick for every subscribed PR (cap 100/query, mirroring `GitHubPrBatchReader`). `N × 3` REST → `1` GraphQL per tick.
- **D4 — `UNKNOWN` handled by cadence, not bespoke logic.** GitHub computes `mergeable`/`mergeStateStatus` asynchronously; the first read often returns `UNKNOWN`/null. The existing poller re-reads every tick, so `UNKNOWN` resolves naturally **when the viewer has push access**. Discipline: **never cache `UNKNOWN`** (the same rule `GitHubCiFailingDetector` applies to `Pending`). Caveat: for **no-push-access / review-only PRs**, `mergeStateStatus` stays `UNKNOWN` *permanently* — that is a stable terminal `None`, not a transient one. It is correct and cheap (scalar fields), but the never-cache rule means those rows re-derive every tick forever; §8 measurement covers this steady-state case.
- **D5 — The readiness badge is open-PR-only.** It renders **only for open, non-draft PRs**. **Merged, Closed, Draft, and Unknown → NO badge.** The PR-state glyph already conveys merged/closed/draft; a readiness pill there would duplicate it (this *is* the issue's "fix merged-PR badge" — stop showing a mergeability pill on terminal PRs). Terminal/draft/unknown are still computed server-side (honest data, terminal-wins precedence); the frontend renders nothing, exactly as it does for CI `none`.
- **D6 — CI octicon relocates to the left, beside the PR-state glyph.** Today the CI octicon sits mid-row (end of `.midCol`). It moves into the leading status cluster next to `PrStateGlyph` (`.status`), grouping the two status glyphs; the new readiness badge takes the **right** side (leading the `.tail`). This separates the CI signal (left) from the readiness signal (right) and keeps D1 intact (CI is still its own REST-sourced glyph, just repositioned). Cost: an inbox visual change → parity-baseline regen.
  - **Alignment contract — the relocated CI slot reserves a fixed width even when empty.** Because the CI octicon now leads the row, *ahead* of the PR number/title, a row with no CI to report (`pr.ci === 'none'`) must still occupy the same horizontal slot — otherwise PR numbers and titles wedge left and the column loses its vertical alignment. The CI slot is a fixed-width box (the octicon's box size); when there is nothing to show it renders an empty spacer of that exact width, not nothing. (This is the *opposite* of the right-side badge slot, which reserves **no** width — see §5: a trailing badge that collapses can't misalign anything before it, but a leading CI glyph that collapses shifts the whole row.)
- **D7 — The badge carries a hover/focus tooltip on both surfaces.** Hovering or keyboard-focusing the badge (inbox row and PR-detail header) opens a small accessible popover showing the **expanded reason** plus a bounded set of **already-gathered** readiness facts (reviewer-decision counts, updated-at, a state-specific one-liner). The extra facts must come from data the fetch already returns — no new API calls, no ruleset reads (honors D2). Richer facts that would need extra calls (exact commits-behind, named failing checks [D1], named protection rule [D2]) are deferred.

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
- **Terminal states win** (Merged/Closed before everything) — this fixes the issue's merged-PR contradiction *by construction*: a merged PR can never derive a stale `Conflicts`/`Behind` lower-precedence state. `Derive` still **returns** `Merged`/`Closed` (honest backend signal), but per D5 the **badge renders nothing** for them — the PR-state glyph carries terminal state. So the rendered badge set is the eight open-PR states (rows 4–11); `Merged`, `Closed`, and `None` render no badge.
- **`BLOCKED` granularity** is purely the review/protection axis (D1: check-failure is the CI dot's job). `ChangesRequested` (a reviewer explicitly blocked, red/actionable) reads differently from `ReviewRequired` (needs approvals, yellow/waiting) and `BlockedByProtection` (approved but a required check / other rule unmet, yellow).
- `reviewDecision` subdivides two buckets: `BLOCKED` (rows 6–8) and the clean-but-changes-requested case (row 10). It is never a standalone state. **Resolved (owner decision):** a PR with `reviewDecision == CHANGES_REQUESTED` but `mergeStateStatus == CLEAN` (a reviewer requested changes where protection does **not** require review) can technically merge, so it is **not** red `ChangesRequested`; but showing plain green `Ready` would hide the open request. It renders as `ReadyWithChangesRequested` — a **dimmed-green** chip with an amber caveat dot (short "Ready (changes)", long "Ready — changes requested"). This keeps the can-this-merge truth (green family) while flagging the caveat.
- **`mergeable == CONFLICTING` is an independent conflict source.** Row 4 ORs it in deliberately so a PR with `mergeable == CONFLICTING` but `mergeStateStatus ∈ {BEHIND, BLOCKED, UNSTABLE, UNKNOWN}` still resolves to `Conflicts` — conflicts dominate. This cross-axis behavior is enumerated in the §10 test matrix so a future row-reorder cannot regress conflicts-hidden-behind-BEHIND.
- Colors are the starting mapping; final pixels are B1-validated live in both themes.

**Labels — single source-of-truth module, two forms per state (frontend-owned).** One state→label module exposes a **short** form (inbox compact badge) and a **long** reason string (PR-detail). The two forms are intentionally different text, not a contradiction; presentation/CSS controls compactness, not separate maps. Only the **8 open states** below render a badge; `Merged`/`Closed`/`None` carry no badge label (D5).

| State | Short (inbox) | Long (detail reason) |
|---|---|---|
| Conflicts | "Conflicts" | "Has conflicts" |
| BehindBase | "Behind" | "Out of date with base" |
| ChangesRequested | "Changes requested" | "Changes requested" |
| ReviewRequired | "Review required" | "Review required" |
| BlockedByProtection | "Blocked" | "Blocked by branch protection" |
| Unstable | "Unstable" | "Checks unstable" |
| ReadyWithChangesRequested | "Ready (changes)" | "Ready — changes requested" |
| Ready | "Ready" | "Ready to merge" |

The four yellow states (BehindBase, ReviewRequired, BlockedByProtection, Unstable) are color-identical; their short labels are distinct with **no shared prefix** that truncation could collapse, so the text axis always disambiguates them (see §6 label-always-visible contract). **What "at a glance" means precisely:** color carries the **tier** (red = blocked/act-now, yellow = waiting/caution, green = ready), and the **label** carries the specific *why* within a tier. Among the four yellows — which are not equivalent actions (BehindBase = author rebases; ReviewRequired = needs someone's approval; Unstable = a check is settling; BlockedByProtection = a rule unmet) — the label, not the color, is load-bearing. A per-yellow distinguishing glyph (so the four are scannable without reading) is a deliberate **deferral** (§13), not an oversight: the label-always-visible contract makes the text the reliable signal first; glyph differentiation is an enhancement to evaluate after the label baseline ships.

## 5. Data flow — three feeds, one derivation

`MergeReadiness` is exposed on three DTOs, each populated from signals its fetch already has (plus `reviewDecision`):

1. **Inbox** — `PrInboxItem.MergeReadiness`. Extend the #532 `GitHubPrBatchReader` GraphQL query (per alias) with `mergeable mergeStateStatus reviewDecision`; derive in the batch reader's parse path; expose on `PrInboxItem`. **`Derive` needs a `PrState`, and `RawPrInboxItem` carries `IsDraft` but has *no* `State`/`PrState` member** (only `MergedAt`/`ClosedAt` timestamps) — reconstruct `PrState` for the inbox call from those (open when both null, else merged/closed), the established `PrStates.FromGitHub`-style pattern; do not assume a raw `state` field exists. `IsDraft` is taken from the raw item. Runs in the existing inbox-refresh batch — **no new round-trips**; measure incremental point cost per epic rule.
2. **PR-detail full load** — `Pr.MergeReadiness` (on the `Pr` record inside `PrDetailDto`). `GetPrDetailAsync`'s `PrDetailGraphQLQuery` today reads `mergeable` into `Mergeability` and **discards `mergeStateStatus`** (it already fetches it; despite the inline comment, no real "collapse" happens). **Add `reviewDecision`** to the query and feed `mergeable + mergeStateStatus + reviewDecision + state + isDraft` into `Derive` in `GitHubPrParser.ParsePr`; expose. The legacy `string Mergeability` field is retained for now (see §9) but no longer drives the UI.
3. **PR-detail active poll (Slice B)** — `ActivePrPollSnapshot.MergeReadiness` + the `pr-updated` SSE payload. Replace the poll tick's 3 REST calls with **one batched GraphQL across all subscribed PRs**. Architecture notes for the planner:
   - **The existing `PollActivePrAsync(PrReference, ct)` single-PR seam stays** — it has three non-poller callers that are inherently single-PR/synchronous-to-a-request (`PrDetailLoader` head probe on mount, `PrSubmitEndpoints` pre-submit head check, the `SubmitPipeline` pre-finalize re-poll). Slice B does **not** mutate that shared method; it adds a **separate batched multi-ref path** the `ActivePrPoller.TickAsync` loop calls once per tick.
   - The batched reader mirrors `GitHubPrBatchReader` (shared transport `GitHubGraphQL.PostAsync`, `rateLimit{cost remaining}`, per-alias isolation, 100-cap). The planner must decide whether to **parameterize/reuse** `GitHubPrBatchReader` or add a sibling class, and justify it on query-shape grounds (the poll needs `mergeable mergeStateStatus reviewDecision state isDraft` + comment/review counts per PR, not the inbox reader's review-history selection) — do not silently duplicate.
   - **Per-PR isolation reconciliation:** today each ref has its own backoff (`NextRetryAt`), first-poll detection, and `ActivePrUpdated` diff. Per-*alias* null isolation survives (one bad PR drops just that PR), but a whole-tick failure now affects every subscribed PR at once — see §7 degradation contract.
   - Snapshot carries the derived readiness + the comment/review counts (with REST-equivalent semantics, see §9), so the badge updates live without a full reload.

**Tooltip extra-fact fields (D7).** The reviewer-decision counts must come from GitHub's **collapsed per-author** view, **not** raw review history. The inbox batch's existing `reviews(last:100){ nodes{...} }` selection is the full review *timeline* — a reviewer who requested changes then re-approved appears as two nodes, so counting raw nodes double-counts and can show a stale "changes requested" inside a green `Ready` badge (the exact hazard `GitHubPrParser.MapReviewState`/`ParseViewerReview` already guard against by selecting max-`submittedAt` per author and excluding `DISMISSED`/`PENDING`). Instead add a `latestReviews(first:100){ nodes{ author{ login } state } }` connection (one already-collapsed node per author) and count only `APPROVED` / `CHANGES_REQUESTED`, excluding `COMMENTED`/`DISMISSED`/`PENDING`. "Updated 2h ago" reuses `UpdatedAt`, already on every DTO. These ride the existing fetches (a new sibling connection on the same `pullRequest`, no new round-trip; point cost still scales with page sizes, not field/connection count — confirm at §8). The PR-detail full load already fetches review state, so this is a no-op there; the derivation fix applies to **both** surfaces. Expose the derived counts as small optional fields on the inbox item / detail / snapshot DTOs (or compute on the frontend from the collapsed review states) — the planner picks the lighter seam.

Frontend types (`frontend/src/api/types.ts`): add `mergeReadiness` (+ the optional tooltip-fact fields) to the inbox item type and the PR-detail type; consume in `InboxRow.tsx` and `PrHeader.tsx` via the shared badge + tooltip components; thread the poll field through `useActivePrUpdates` → `PrDetailView`.

## 6. Presentation

A **color-coded badge appears on BOTH surfaces** (inbox and PR detail) for **open, non-draft PRs only** (D5), driven by the same `MergeReadiness` value and the same `.chip-readiness-*` token set — a compact variant on the inbox, an expanded variant on detail. **Merged, Closed, Draft, and Unknown (`None`) render no badge** — the PR-state glyph carries terminal/draft state, and the badge slot reserves no space (matches the CI `none` pattern). This *is* the merged-PR fix: terminal PRs stop showing any mergeability pill.

**Label-always-visible contract (accessibility floor).** On both surfaces the **short text label is always rendered** — never collapsed to a bare color dot or an icon-only mark. Color is reinforcement, not the sole signal (WCAG 1.4.1, Use of Color); the four color-identical yellow states are distinguishable by label alone. B1 may tune chip width/padding but **may not** introduce a label-less variant; "the contract is a color-coded badge *with its label*, not a bare dot." The label may not truncate to a shared prefix.

- **Inbox row (`InboxRow.tsx`)** — three layout changes:
  - **PR number `#N` (folds in #516).** Render `#{pr.reference.number}` as a mono, muted prefix at the leading edge of the title (its own `.num`-style span; same mono/secondary treatment as the repo label and the Activity rail). It precedes the title text; long titles still ellipsize after it. **Truncation priority:** the title column keeps a minimum readable width (≈10ch) at the narrowest supported viewport; if `#N` + title cannot both fit, the **`#N` truncates/hides before the title does** (the number is the less critical of the two), and 5-digit numbers (`#10000+`) are validated at min width. No new DTO field — the number is already in the inbox item.
  - **CI octicon relocates left (D6).** Move the CI octicon out of `.midCol` into the leading `.status` cluster next to `PrStateGlyph`. `.status` today is a single 16px grid track holding only the glyph, so this needs a **layout decision the planner must name**: widen the leading track (e.g. `auto`/two-glyph) or add a dedicated CI grid column, and adjust the `--inbox-tail-w` math accordingly. The CI slot within it is a **fixed-width box**: when `pr.ci === 'none'` it renders an **`aria-hidden`, non-focusable, presentational** empty spacer of the octicon's width (not nothing) so the PR number/title stay column-aligned across rows with and without CI (D6 alignment contract). The CI signal continues to ride the row `aria-label` via the existing `ciSuffix` (which already emits nothing when `ci === 'none'`), so the spacer adds no screen-reader noise. The compact readiness **badge** (chip, short label per §4) then leads the right-side `.tail`, separated from CI. CI keeps its existing REST source and `aria-label` semantics — only its position changes. (Inbox visual change → parity-baseline regen.)
  - **`.tail` density (badge + existing metric pills).** The badge joins a `.tail` that already holds metric pills (#357). Priority order: the **badge is highest-priority** (always visible when present); metric pills wrap/drop before the badge does when the tail is space-constrained. State the min `.tail` width at which the badge is the sole survivor.
  - **Layout-shift:** the badge slot reserves **no horizontal space** when there is no badge (open PR resolving from `None`, or any terminal/draft row). This is intentionally the *opposite* of the fixed-width CI slot on the left: a **trailing** badge that collapses can't misalign anything before it, whereas a **leading** CI glyph that collapses would shift the whole row — hence CI reserves width and the badge does not. So a badge appearing after the first poll resolution doesn't shift the row.
- **PR-detail (`PrHeader.tsx`, the `chip chip-mergeability-${...}` render)** — replace the bare mergeability chip with the expanded color-coded badge **+ long reason** (§4 table) for open PRs; render nothing for terminal/draft (the header's existing state chips cover those). Reuses the shared `.chip-readiness-*` token set.

**Tooltip (D7) — hover/focus popover on both surfaces.** The badge opens a small popover on hover **and** keyboard focus, carrying:
1. the **expanded reason** (the §4 long label, with its color chip);
2. a **state-specific one-line explanation** (full set below — all 8 open states, not just examples);
3. **already-gathered facts** where present — reviewer-decision counts ("Changes requested by 2 · 1 approval", from the collapsed `latestReviews` connection per §5) and "Updated 2h ago" (from `UpdatedAt`). No new API calls, no ruleset reads (honors D2). Facts needing extra calls are deferred (§13). When a count is zero, suppress that count's clause rather than printing "0 approvals". When `latestReviews`/`reviewDecision` are unavailable (no-push-access / review-only PR, §9), suppress the counts line entirely rather than show "0 · 0".

| State | Tooltip one-liner |
|---|---|
| Conflicts | "Resolve merge conflicts to continue." |
| BehindBase | "Update this branch with its base before merging." |
| ChangesRequested | "A reviewer requested changes." |
| ReviewRequired | "Waiting on a required approving review." |
| BlockedByProtection | "A branch-protection rule is not yet satisfied." |
| Unstable | "Required checks haven't all passed yet." |
| ReadyWithChangesRequested | "Mergeable, but a reviewer requested changes." |
| Ready | "This PR can be merged." |

No reusable tooltip primitive exists today (the app uses native `title=`, which can't carry styled multi-line content). Rather than build a speculative shared framework for a single consumer (per scope review — cf. `ChangeMinimap`'s existing inline positional tooltip), this slice adds a **badge-local accessible popover** owned by the shared badge component (which already serves both inbox and detail, so one implementation covers both surfaces). Extract it to a shared primitive only when a *second*, unrelated consumer appears (tracked as a follow-up, §13). Interaction contract:
- **Open:** on hover after a **300 ms** delay (avoids flicker while scanning a 20-row inbox); **immediately** on keyboard focus.
- **Non-interactive:** the popover is display-only, so it closes on badge pointer-leave / blur — the pointer is not expected to move into it. (If a future fact becomes a link, revisit.)
- **Singleton:** opening any badge popover closes any currently-open one (shared open-id ref/context), so tabbing the inbox can't accumulate popovers or overlap them.
- **Live update:** if the readiness value changes via SSE while the popover is open, **re-render its content in place** (reason, one-liner, counts, and "Updated" age all bound to the current snapshot — no frozen copy); if the badge transitions to `None` (terminal/draft) while open, **close immediately** (there is no longer a trigger).
- **Dismiss:** Escape and blur. `role="tooltip"`, wired via `aria-describedby`. Positioned to avoid row clipping (planner picks portal vs. `overflow:visible`/anchored-popover; a virtualized/`overflow:hidden` inbox row makes this load-bearing — decide in Task 3/4).
- **Touch:** PRism today is a **pointer + keyboard** desktop app (web + Electron); a touch/tap-to-open gesture is **out of scope** (§13). If touch support lands later, the popover gains a tap trigger or the long label inlines at touch widths.

**Accessibility.** The badge is now a **focusable** element (it owns the tooltip trigger), with a visible focus ring (existing `:focus-visible` token). The short label is appended to the inbox row's `aria-label` (e.g. "PR #593 … — Ready") via the single source-of-truth label module; on detail the long reason is visible text. The tooltip content is associated via `aria-describedby` so its extra facts are announced on focus. Screen-reader announcement + keyboard-open/dismiss are B1-gate checks (§10).

**Tokens.** New `.chip-readiness-*` rules in `tokens.css` map each state to PRism's existing semantic soft/fg pairs (`--success-soft`/`--success-fg` green, `--warning-soft`/`--warning-fg` yellow, `--danger-soft`/`--danger-fg` red), plus a new `--merged-soft` purple pair (`--merged-fg` already exists) and a neutral `--surface-3`/`--text-2` gray for Closed. Because PRism's oklch surface scale is **theme-asymmetric** (light descends, dark ascends/compressed — repo memory), each rule resolves through theme-scoped tokens (the semantic pairs are already per-theme; `--merged-soft` adds both). Label-on-chip text must clear **WCAG AA 4.5:1** contrast in both themes, measured live at B1 (1px-canvas method), not eyeballed from a screenshot.

- **`ReadyWithChangesRequested` is a concrete token, not "mix it however."** Define a named `--readiness-ready-caveat-soft` pair as the dimmed-green background: `color-mix(in oklch, var(--success-soft) 60%, var(--surface-3))` as the **starting** value, authored per theme (the asymmetric scale means the same mix reads differently in light vs. dark — B0-tune the percentage so it is visibly distinct from both plain `--success-soft` Ready **and** the yellow family, while the label still clears 4.5:1). The chip keeps `--success-fg` for the label so it stays green-family.
- **Amber caveat dot:** a 6px filled circle, **leading** the label, color `--warning-fg`, `aria-hidden` (the label "Ready (changes)" carries the meaning; the dot is visual reinforcement only — consistent with the label-always-visible contract, and it must not read as a separate status glyph next to the relocated CI octicon). Its color must clear **WCAG 3:1 non-text contrast** against the dimmed-green background in both themes — a distinct check from the 4.5:1 label check (§10 B1).

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
- **Tooltip reviewer-count derivation** (the §5 collapsed-count rule): a reviewer who `CHANGES_REQUESTED`-then-`APPROVED` counts as **one approval, zero changes-requested** (pins that counts come from `latestReviews` per-author, not raw history); `COMMENTED`/`DISMISSED`/`PENDING` are excluded from both counts; counts unavailable (review-only PR) suppress the line.
- **Frontend** (vitest): badge per **open** state (8 rendered states), label always present, via the single label/color module; **merged/closed/draft/unknown render NO badge** (open-only, D5); empty badge slot reserves no width; CI octicon renders in the leading `.status` cluster (relocated, D6); **a `ci === 'none'` row still reserves the fixed-width CI slot so its PR number/title align with a row that has CI** (D6 alignment contract); tooltip opens on hover **and** focus, closes on Escape/blur, carries the reason + extra facts, and is wired via `aria-describedby`; **tooltip is a singleton** (opening one closes another); **a state change while the tooltip is open re-renders its content in place**, and a transition to `None` closes it; the amber caveat dot is `aria-hidden`; **(#516) the `#<number>` renders on every row** as a mono/muted title prefix, and the title (not `#N`) survives at the narrowest width.
- **B1 visual gate** (Playwright): screenshots across the 8 rendered open states (Ready/ReadyWithChangesRequested/Conflicts/BehindBase/ChangesRequested/ReviewRequired/**BlockedByProtection**/Unstable) in **light and dark**, plus the open tooltip popover, validated live before lock — and confirmation that Merged/Closed/Draft rows show **no** badge (glyph only). B1 also verifies: WCAG AA 4.5:1 label-on-chip (and tooltip text) contrast in both themes (1px-canvas); **the dimmed-green `ReadyWithChangesRequested` chip is at-a-glance distinct from both plain `Ready` and the yellow family in both themes**, and its amber dot clears **3:1 non-text contrast**; the relocated CI octicon; and that the badge label + tooltip facts are announced by a screen reader on both surfaces.

## 11. Scope / slicing (for writing-plans)

Large T3; one PR (per the "Full #593" decision). Expected task order:
1. `MergeReadiness` enum + `MergeReadinessRule.Derive` + exhaustive tests (Core), **and** the shared frontend label/color module (short+long forms, §4 table) — defined once here so both UI tasks reference it, not redefine it.
2. Inbox feed: extend `GitHubPrBatchReader` query (add the 3 readiness scalars) + parse + `PrInboxItem` field + tests.
3. **Badge-local accessible popover** (owned by the shared badge component, not a speculative standalone primitive — §6): 300 ms-hover/immediate-focus open, non-interactive, singleton, live-update-in-place + close-on-`None`, `role="tooltip"` + `aria-describedby`, Escape/blur dismiss, clip-safe positioning + tests. (Built before the UI tasks that consume it; extract to a shared primitive only when a second consumer appears.)
4. Inbox UI: `InboxRow.tsx` — relocate CI octicon into `.status` (D6) with the fixed-width empty-CI spacer (alignment contract); render the `#N` PR number (mono/muted title prefix, **closes #516**); add the open-only readiness **badge** (short label) leading `.tail`, wired to the Task-3 tooltip; the **complete `.chip-readiness-*` token set (all 8 open states, both themes)** authored here (Task 6 only references it, never extends it); tests. (Inbox visual change → parity-baseline regen.)
5. PR-detail full-load feed: `PrDetailGraphQLQuery` (add `reviewDecision`) + `ParsePr` + `Pr` field + the `reviews` node `state` scalar for tooltip counts + tests.
6. PR-detail UI: `PrHeader.tsx` badge + long reason + tooltip, referencing the Task-1 label module and Task-4 tokens + tests.
7. Slice B: separate batched active-poll GraphQL reader (reuse-vs-sibling decision per §5.3) + `ActivePrPoller` tick wiring (single-PR `PollActivePrAsync` left intact for its 3 non-poller callers) + `ActivePrPollSnapshot`/SSE field + count-parity & whole-tick-abort tests; rate-limit measurement.
8. Visual polish + B1 screenshots.

**Sequencing risk + fallback trigger.** Slice B (Task 7) is structurally independent of the badge — the badge could ship on the existing REST poll with an additive field — but per the "Full #593" decision it ships in this one PR. That makes Task 7 a **prerequisite-risk concentrator**: it can develop in parallel with Tasks 5/6, but the PR cannot merge until Task 7 (new reader, count-parity, rate-limit measurement, SSE wiring) is green. Multiple reviewers flagged this as the single largest ship-delay vector (the user-facing badge held hostage to a backend perf refactor). **Concrete fallback (not "sequence accordingly"):** Tasks 1–6 (the entire user-facing feature + #516) must reach green *independently* of Task 7. If Task 7 is not green by the time 1–6 are, **carve Slice B out** into a follow-up perf-only PR (the badge ships on the existing REST poll with the additive `MergeReadiness` field; Slice B then lands with zero UI change). This preserves the "one PR" intent as the default while removing the hostage risk. **Owner decision pending** — confirm the one-PR default with this carve-out escape hatch, or opt for an upfront 2-PR split (PR1 badge+#516+D6 on REST poll; PR2 Slice B).

## 12. Acceptance criteria

- [ ] A color-coded merge-readiness **badge appears on BOTH the inbox and the PR-detail view** for **open, non-draft PRs only**, driven by the same `MergeReadiness` value and shared token set.
- [ ] Inbox badge (compact, short state label) covers the 8 open states: Ready, ReadyWithChangesRequested, Conflicts, BehindBase, ChangesRequested, ReviewRequired, BlockedByProtection, Unstable.
- [ ] **Merged, Closed, Draft, and Unknown render NO badge** on either surface (the merged-PR fix); the empty slot reserves no width.
- [ ] PR-detail badge shows a **human-readable reason**, derived from `mergeStateStatus` (+ `reviewDecision` for the `BLOCKED` split and the dimmed `ReadyWithChangesRequested` variant), not the collapsed string.
- [ ] A reviewer-requested-changes-but-mergeable PR renders the dimmed `ReadyWithChangesRequested` chip (green family + amber caveat dot), not plain green `Ready` nor red `ChangesRequested`.
- [ ] **CI octicon is relocated** into the leading status cluster next to the PR-state glyph (D6); its REST source and `aria-label` semantics are unchanged; readiness badge sits on the right.
- [ ] A row with **no CI to report still reserves the fixed-width CI slot**, so PR numbers/titles stay horizontally aligned with rows that have CI (D6 alignment contract).
- [ ] **(#516)** Every inbox PR row shows its PR number as a mono, muted `#<number>` at the leading edge of the title, consistent with the Activity-rail/repo-label treatment and not crowding the title or metric pills; verified in both themes.
- [ ] The badge opens a **hover/focus tooltip** on both surfaces showing the expanded reason + already-gathered facts (reviewer-decision counts, updated-at); keyboard-openable and Escape-dismissible; `aria-describedby`-wired. No new API calls / ruleset reads.
- [ ] `UNKNOWN`/null and push-access-gap cases render **no** indicator without errors; resolve on a later tick (not cached).
- [ ] Active poll makes **1 GraphQL call per tick** across all subscribed PRs (was `N × 3` REST); comment/review counts preserved; merge-readiness rides the snapshot/SSE so the badge updates live.
- [ ] Color coding verified in **both** light and dark themes (B1).
- [ ] GraphQL point cost measured (inbox-batch increment + active-poll) and reported in `## Proof`.

## 13. Deferrals / non-goals

- Per-branch-protection-rule detail / named unmet rule + counts (D2) — defer-candidate; needs ruleset reads + classic PAT.
- **Richer tooltip facts that need extra fetches** (D7) — exact commits-behind count, *named* failing checks (that's the CI octicon's job, D1), *named* protection rule / required-approval counts (D2 ruleset reads). The tooltip ships with only already-gathered facts (reviewer-decision counts, updated-at, state explanation); these richer facts are a follow-up if wanted.
- Removing the legacy `Mergeability` string (§9) — follow-up once consumers migrate.
- Folding CI into the readiness indicator (D1) — explicitly out of scope.
- **Touch / tap-to-open tooltip** — PRism is pointer+keyboard desktop today; touch gesture support for the badge popover is a follow-up (§6 D7).
- **Per-yellow distinguishing glyph** — a small per-state glyph so the four color-identical yellow states are scannable without reading the label (§4); evaluate after the label baseline ships.
- **Extracting the badge popover into a shared Tooltip primitive** — only when a second, unrelated consumer appears (§6); this slice keeps it badge-local.
- Slice D (timeline per-commit changed-files batch) — separate epic child.
