# Inbox: group PRs by repository (nested accordions) + repo-centric Recently-closed (#133)

**Issue:** [#133](https://github.com/prpande/PRism/issues/133) — Inbox sections show a flat PR list; group PRs by repo as nested accordions, and rework Recently-closed to be repo-centric.
**Tier / Risk:** T3 (cross-tier: frontend nested-accordion rendering + backend recently-closed repo-cap + an `Inbox` config-schema addition) · gated **B1 (UI-visual)** (`needs-design`). The config-field addition touches persisted config schema but is additive-with-default (§ Config schema); B1 is the firing gate.
**Worktree / branch:** `D:/src/PRism-wt/133-inbox-group-by-repo` · `feat/133-inbox-group-by-repo`.

## Problem

Every inbox section (Review requested / Awaiting author / Authored by me / Mentioned / CI failing / Recently closed) renders a **flat** list of `InboxRow`s. When a user is active across many repositories, a section becomes a long undifferentiated scroll, and there is no way to collapse the PRs of a repo you don't care about right now.

Recently-closed is the worst case and also semantically wrong for the goal: it is capped at the **30 most-recently-closed PRs** (`InboxHistoryConstants.MaxHistoryRows`). Thirty PRs can all sit in two busy repos, so the section answers "what are my last 30 closed PRs" when the user actually wants "**which repos** have I been working in lately." The fix reframes it to be repo-centric.

## Scope (this slice = Option A)

**In scope:**
- Group PRs by repo within **every** section, as nested expand/collapse accordions.
- Recently-closed becomes repo-centric: closed PRs grouped under their repo, repos ordered by most-recent close, capped at the top **N repos** (not N PRs).
- The history **window** becomes a config-backed value (default 14 days) wired so a future Settings control can bind to it — no UI control built in this slice.

**Explicitly deferred to a follow-up issue (Option B):** a real load-more / paginated endpoint for browsing deep closed history. It fights the current snapshot/SSE keep-alive model (recently-closed is a byproduct of the periodic `InboxSnapshot` refresh, overwritten wholesale and pushed over SSE each tick) and needs its own design pass for the reconciliation. This slice deliberately leaves the existing top-N-repo cap with a reworded truncation footer instead.

## Architecture: grouping is a frontend fold; the wire contract is unchanged

Every `PrInboxItem` already carries a `repo` string (e.g. `"acme/api"`) and a `reference.{owner,repo,number}`. Grouping by repo is therefore a **pure presentation fold** over the existing flat `PrInboxItem[]`. The design does the grouping **on the frontend**:

- The `/api/inbox` `InboxResponse` / `InboxSection { id, label, items: PrInboxItem[] }` wire contract is **unchanged**.
- The backend `InboxSnapshot`, `ComputeDiff`, the `InboxUpdated` SSE event, and `IInboxDeduplicator` are **untouched** — they keep operating on flat item lists.

**Rejected alternative — backend emits a grouped `{ repo, items }[]` shape.** This would ripple through `InboxSnapshot`, `ComputeDiff` (per-section ref diffing), the dedup contract, the SSE event, the endpoint serialization, and every backend + frontend test, for no benefit: live sections are small and need no pagination, and the `repo` field is already present client-side. Centralizing a fold that one consumer performs is premature. Keeping grouping in the view also keeps per-repo open/close state where it belongs (the view).

The **only** backend change is to recently-closed's cap and window (§ Backend), because "top N repos" and "configurable window" are data-shape decisions the frontend cannot make from a list the backend has already truncated to 30 PRs.

## Frontend

### `groupByRepo` utility

`frontend/src/components/Inbox/groupByRepo.ts` (co-located with the Inbox components; pure, unit-testable in isolation):

```ts
export interface RepoGroup {
  repo: string;            // "owner/name", the PrInboxItem.repo value
  items: PrInboxItem[];    // PRs in this repo, original order preserved
}

export function groupByRepo(items: PrInboxItem[]): RepoGroup[];
```

Behavior:
- Fold `items` into groups keyed by `pr.repo`, **preserving first-seen repo order** as a stable base, then **order repos by most-recent activity desc** — the max of (`mergedAt ?? closedAt ?? updatedAt`) across the repo's PRs. This precedence intentionally matches the backend's recently-closed ordering (`MergedAt ?? ClosedAt`, § Backend) so a repo the backend ranked "top" doesn't drift mid-list when the frontend re-groups. Ties broken by first-seen order (stable).
- **PR order within a repo is preserved** from the input — the backend already sorts each section (recently-closed by close-time desc; live sections by their query order). The util does not re-sort within a repo.
- Empty input → `[]`.

Ordering rationale: repos the user touched most recently float to the top, matching the recently-closed "what have I worked in lately" framing, and is harmless/sensible for live sections too.

### `RepoGroup` accordion component

`frontend/src/components/Inbox/RepoGroupAccordion.tsx` — a nested accordion that **reuses the exact `InboxSection` header idiom** (`▾`/`▸` caret + label + count), one visual level indented inside the section body.

```tsx
interface Props {
  group: RepoGroup;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen: boolean;
}
```
- Local `useState(defaultOpen)` open/close — **ephemeral**, mirroring `InboxSection`'s existing toggle (not persisted; resets on remount, consistent with how the section toggle already behaves).
- Header: `<button aria-expanded>` with caret, the repo name (mono, matching `InboxRow`'s repo styling), and the PR count.
- Body (when open): the same `section.items.map(InboxRow)` currently in `InboxSection`, scoped to `group.items`.
- Styled in a sibling `RepoGroupAccordion.module.css`, reusing section tokens so the nested level reads as a clear child of the section (indent + lighter/smaller header than the section header).

### `InboxSection` change

`InboxSection.tsx` replaces its flat `section.items.map(InboxRow)` with:

1. `const groups = groupByRepo(section.items);`
2. **Single-repo flatten (Choice 1):** if `groups.length <= 1`, render `InboxRow`s directly (today's flat behavior) — no nested accordion for a single repo (avoids a pointless one-child accordion).
3. Otherwise render `groups.map(g => <RepoGroupAccordion ... defaultOpen={repoDefaultOpen} />)`.

**Repo default-open (Choice 2):** `repoDefaultOpen = section.id !== 'recently-closed'`. Live sections open their repo groups by default (small lists, the PRs are the point); recently-closed collapses its repo groups by default (breadth-of-repos is the point; the user expands the repo they care about). The **section-level** `defaultOpen` is unchanged (recently-closed section still starts collapsed via `InboxPage`).

The empty-state, the `RecentlyClosedFooter` truncation hint, and the `showCategoryChip`/`maxDiff` plumbing are preserved. `maxDiff` is still computed across the whole inbox in `InboxPage` (unchanged), so DiffBars stay comparable across repos and sections.

### Recently-closed footer copy

`RecentlyClosedFooter` is reworded from PR-centric to repo-centric. When the backend repo cap is hit, it reads, e.g.: *"Showing the {N} most-recently-active repos — older history isn't listed. Paste a URL above to open a specific PR."* The truncation signal changes from "items.length >= 30 PRs" to "distinct repo count >= N" (derived client-side from `groupByRepo(section.items).length`, with the cap surfaced as a small shared constant mirrored from the backend — see § Constants).

## Backend (recently-closed only)

`PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, recently-closed materialization block (currently lines ~207–216):

Replace the **PR cap** with a **repo cap**:
- Today: `.OrderByDescending(close-time).Take(MaxHistoryRows /* 30 PRs */)`.
- New: materialize all closed PRs in the window, **group by `Repo`**, order repos by each repo's most-recent close (`max(MergedAt ?? ClosedAt)`) desc, take the **top N repos**, and flatten back to a `PrInboxItem[]` (repos in that order, PRs within a repo still close-time desc). The wire stays flat; the frontend re-groups. PRs within a repo are bounded by the existing `per_page=50` search fetch (no search paging in this slice).

### Config schema (window made configurable)

`HistoryWindowDays` moves from a hard constant into the persisted `InboxConfig` record so a future Settings control binds to it:

- `PRism.Core/Config/AppConfig.cs`: add `int RecentlyClosedWindowDays = 14` as the **trailing, defaulted** parameter of `InboxConfig` (currently `InboxConfig(bool Deduplicate, InboxSectionsConfig Sections, bool ShowHiddenScopeFooter)`). This mirrors the existing trailing-default pattern the config already relies on — `InboxSectionsConfig.RecentlyClosed = true` and `UiConfig.Density = "comfortable"`.
- `AppConfig.Default` constructs `InboxConfig` positionally (`new InboxConfig(true, new InboxSectionsConfig(...), true)`); it picks up the `= 14` default (or passes `14` explicitly for readability — same value).
- `InboxRefreshOrchestrator` reads `_config.Current.Inbox.RecentlyClosedWindowDays` instead of `InboxHistoryConstants.HistoryWindowDays` when calling `QueryClosedHistoryAsync`.
- **Backward-compat (the persisted-schema concern):** `System.Text.Json` honors optional constructor-parameter defaults when a JSON property is absent — the mechanism the codebase **already** depends on for `RecentlyClosed`/`Density`. A `config.json` written before this change has no `recentlyClosedWindowDays` key, so it deserializes to **14** (not 0 — a 0-day window would silently empty the section). The spec requires a regression test deserializing an old-shape `InboxConfig` JSON (key absent) and asserting the window is 14. Adding a trailing param does **not** reorder existing JSON properties, so no migration of on-disk `config.json` is needed.
- **No Settings UI** is added in this slice; only the data seam. `area:settings` work to expose it is out of scope (a future issue can bind a control to this field).

### Constants

`PRism.Core/Inbox/InboxHistoryConstants.cs`:
- `MaxHistoryRows = 30` (PR cap) is **removed** and replaced by `MaxHistoryRepos = 20` (Choice 3, N=20).
- `HistoryWindowDays = 14` is removed from the constants file (now config-backed); if any non-config caller remains, it reads the config value.
- The frontend's truncation-hint threshold references the same N=20 (a small FE constant mirroring the backend, as the cap isn't on the wire). Document the mirror so the two don't silently drift.

## Data flow (unchanged except where noted)

1. `InboxPoller` tick → `InboxRefreshOrchestrator.RefreshAsync` → live-section searches + `QueryClosedHistoryAsync(windowFromConfig)` → shared enrichment (cached by `(ref, updatedAt)`; terminal closed PRs are cache hits after first sight) → materialize → **repo-cap recently-closed** → `InboxSnapshot` → SSE.
2. `/api/inbox` returns the snapshot as today (flat sections).
3. `InboxPage` → `InboxSection` → **`groupByRepo` fold** → `RepoGroupAccordion` (or flat rows if single-repo) → `InboxRow`.

No change to polling cadence, enrichment, dedup, or the SSE diff.

## Accessibility

- Each repo accordion is a `<button aria-expanded>` controlling its body, same pattern the section header already uses (keyboard-operable, AT-announced). The nesting is a list of disclosure buttons inside a section — no `tree`/`grid` role is introduced (avoids the `aria-required-children` class of problems seen in `PrTabStrip`, #174). 
- `InboxRow`'s existing `aria-label` (which already includes the repo) is unchanged, so a row remains self-describing even when reached inside a collapsed-then-expanded repo group.
- Caret glyphs stay `aria-hidden`; the accessible name is the repo label + count.

## Testing

Frontend (vitest + RTL):
- `groupByRepo`: groups by repo; preserves within-repo order; orders repos by most-recent activity desc; stable tie-break; empty input → `[]`; single-repo input → one group.
- `InboxSection`: single-repo section renders flat rows (no accordion); multi-repo section renders one `RepoGroupAccordion` per repo with correct counts; recently-closed repo groups start collapsed, live-section repo groups start open; section-level collapse still hides everything.
- `RepoGroupAccordion`: toggles open/closed; renders its rows only when open; count matches.
- `InboxPage`: existing tests updated for the nested structure; `maxDiff` still spans the whole inbox.

Backend (xunit):
- Recently-closed repo-cap: with closed PRs spanning > N repos, only the top-N most-recently-active repos survive, all their PRs retained; repo order by most-recent close.
- Config window: orchestrator queries with the configured window; **old-shape config (key absent) → 14-day default** (the backward-compat assertion).
- A many-PRs-few-repos fixture proves the cap is on repos, not PRs (the core behavior change vs the old 30-PR cap).

Visual (B1 gate): Playwright screenshots of the inbox with multiple repos per section (real-mode against the BFF repo's recently-closed history) — nested accordions, single-repo flatten, recently-closed repo-collapsed default — embedded on the PR per the project's visual-verification convention.

## Acceptance criteria

- [ ] PRs grouped by repo within each section as nested expand/collapse accordions reusing the section idiom; section-level accordion behavior preserved.
- [ ] Single-repo sections render rows directly (no one-child accordion).
- [ ] Recently-closed is repo-centric: grouped by repo, repos ordered by most-recent close, capped at top **N=20 repos** (not N PRs); footer reworded.
- [ ] History window is config-backed (default 14d, backward-compatible) and read from config by the orchestrator; no Settings UI added.
- [ ] Frontend wire contract (`/api/inbox`) and backend snapshot/diff/SSE are unchanged.

## Out of scope / follow-ups

- **Option B** — load-more / paginated deep closed history (separate issue; needs SSE/keep-alive reconciliation design).
- **Perf follow-up (optional)** — recently-closed runs 2 search calls every tick and the enrichment cache is unbounded in-memory; neither blocks this slice (closed PRs are enrichment cache-hits steady-state). Can be filed separately if desired.
- **Settings control** for the window (`area:settings`) — this slice only lands the data seam.
