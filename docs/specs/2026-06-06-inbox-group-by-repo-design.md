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
- Fold `items` into groups keyed by `pr.repo`, **preserving first-seen repo order** — the repo of the first item appears first, etc. The util performs **no timestamp sort of its own**.
- **PR order within a repo is preserved** from the input.
- Empty input → `[]`.

**Why first-seen order, not a FE re-sort (resolves the FE/backend ordering-divergence risk).** Each section already arrives ordered by the backend: live sections in their GitHub-query order, and recently-closed ordered by close-time desc *after the repo cap is applied* (§ Backend). First-seen grouping over a close-desc list yields **repos ordered by their most-recent close** for free — which is exactly the "which repos have I worked in lately" framing — without the FE computing any timestamps. This deliberately avoids an earlier design where the FE re-sorted repos by `max(mergedAt ?? closedAt ?? updatedAt)`: that key could disagree with the backend's `MergedAt ?? ClosedAt ?? UpdatedAt` for closed PRs whose enrichment was dropped (null close timestamps → backend bottoms them out, a FE `?? updatedAt` tail would float them mid-list), producing visible mid-list drift. By making the **backend emission order authoritative** and the FE merely preserve it, the two can't diverge, and live-section order is left untouched (first-seen preserves the backend query order rather than imposing a new sort #133 never asked for).

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
- Local `useState(defaultOpen)` open/close — **ephemeral** (not persisted; resets on remount). Note this default is computed inside `InboxSection` from `section.id` (below), unlike the section-level `defaultOpen` which is a prop from `InboxPage`; a future Settings-driven or persisted default would need to thread a prop here. Accepted for this slice.
- Header: `<button aria-expanded>` with caret + repo name (mono, matching `InboxRow`'s repo styling) + a **count badge = total PR count in the group** (same semantic as the section-level count; *not* an unread count). On a collapsed recently-closed group this badge is the only at-a-glance signal of how many PRs are inside.
- Body (when open): `group.items.map(InboxRow)`, each row receiving `enrichment={enrichments[prId(pr)]}` exactly as `InboxSection` does today, plus `showRepo={false}` (below).

**Visual hierarchy (D1 — read as a child of the section, not a peer).** The section header today is `padding: var(--s-3) var(--s-4)`, `font-size: var(--text-sm)`, `font-weight: 500`, `color: var(--text-2)`, with a 3px left accent bar on the `<section>` wrapper. The repo header in `RepoGroupAccordion.module.css`:
- `padding-left` = section header's + one `--s-4` step (≈16px indent); other padding matches.
- `font-size: var(--text-sm)` (same) but `font-weight: 400` (vs section's 500) — weight, not size, carries subordination so the repo name stays scannable.
- **No** card background, border-radius, or left accent bar — it sits flush inside the section `.body`; only the indent + lighter weight signal "child."
- `:hover` → `background: var(--surface-2)` (matching `InboxRow`'s hover); `:focus-visible` → the project focus ring (the same treatment `InboxRow` uses). *(The existing `InboxSection` `.header` has neither — this slice does **not** retroactively add hover/focus to the section header, to avoid an unguarded visual/behavior change to existing UI under #133's gate. Adding the repo-header hover may make that absence visibly inconsistent; surface it at the B1 visual review and decide there whether a matching section-header hover — and the pre-existing section-header focus-visible a11y gap — warrant a separate small follow-up.)*

**In-row repo redundancy (D4).** `InboxRow` renders `pr.repo` in its meta line; inside a repo group headed by that repo it's pure noise (worst in recently-closed, many rows per repo). Add a `showRepo?: boolean` prop to `InboxRow` (default `true`, preserving every existing caller incl. the single-repo flatten path). `RepoGroupAccordion` passes `showRepo={false}`. **Suppress the repo `<span>` and the `dotsep` separator immediately after it as one conditional fragment** (`{showRepo && (<><span class=mono>{pr.repo}</span><span class=dotsep>·</span></>)}`) — dropping only the span leaves an orphaned leading `·` before the author. A vitest assertion checks `showRepo={false}` renders no leading separator. The `aria-label` still includes the repo (unchanged) so AT/disambiguation is preserved; the group header carries the full `owner/name`, so same-name-different-owner repos (distinct `pr.repo` keys → distinct groups) stay disambiguated.

**Unread-bar alignment (D5).** `InboxRow`'s unread accent bar is `position:absolute; left:0` within the row. Apply the group indent via `padding-left` on the group's **body container** (not a margin on the row), so the unread bar stays at the row's own left edge and reads as aligned to the indented rows — a consistent inset, not a bar floating at the section edge.

### `InboxSection` change

Two frontend rendering choices drive the logic. `InboxSection.tsx` replaces its flat `section.items.map(InboxRow)` with:

> **Single-call-site gateability (for #219).** Grouping is shipped **unconditionally default-on** in this slice. It is deliberately kept to one call site so the follow-up Settings toggle ([#219](https://github.com/prpande/PRism/issues/219)) wraps exactly this in `if (groupingEnabled) … else <flat rows>` — no inert preference field is added now (the gate + pref + UI are one coherent unit built in #219, where `ConfigFieldType.Bool` already suffices).

1. `const groups = groupByRepo(section.items);`
2. **Single-repo flatten (Choice 1):** if `groups.length <= 1`, render `InboxRow`s directly (today's flat behavior, rows show the repo) — no nested accordion for a single repo (avoids a pointless one-child accordion).
3. Otherwise render `groups.map(g => <RepoGroupAccordion ... defaultOpen={repoDefaultOpen} />)`.

**Repo default-open (Choice 2):** `repoDefaultOpen = section.id !== 'recently-closed'`. Live sections open their repo groups by default (small lists, the PRs are the point); recently-closed collapses its repo groups by default (breadth-of-repos is the point; the user expands the repo they care about). The **section-level** `defaultOpen` is unchanged (recently-closed section still starts collapsed via `InboxPage`).

The empty-state, the `RecentlyClosedFooter` (now an unconditional caption, § Footer), and the `showCategoryChip`/`maxDiff` plumbing are preserved. `maxDiff` is still computed across the whole inbox in `InboxPage` (unchanged), so DiffBars stay comparable across repos and sections.

### Recently-closed footer copy

`RecentlyClosedFooter` becomes an **unconditional, honest caption** under the recently-closed section, replacing the old conditional 30-PR truncation hint. New copy: *"Repositories with PRs you've closed recently — most recent first."*

**No window value or count is interpolated** (deliberate). Interpolating `{window}` would force the value onto the frontend (the `/api/inbox` wire is unchanged, so the FE has no window — it would need `usePreferences` plumbing or a hardcoded `14` that drifts from config), and naming "last N days" overclaims completeness the ≤50-per-sub-query sample doesn't guarantee. "most recent first" is accurate to the close-desc/first-seen order and needs no new data; "closed recently" avoids the "active" overclaim (the ranking is by most-recent *close*, not activity volume). `RecentlyClosedFooter`'s current `count` prop is dropped — it takes no props now.

**Why unconditional, not a truncation hint.** The backend already clamps to N repos and emits a flat list; the FE only sees `≤ N` repos and **cannot observe whether truncation occurred** — a count-based `groupByRepo(...).length >= N` signal fires a false "older history isn't listed" at exactly N repos with nothing dropped, and would require a fragile FE-constant mirror of the backend cap that can silently drift. Dropping truncation *detection* removes the mirror entirely (no FE cap constant), is always true, and avoids pointing the user back to GitHub (the old "paste a URL" copy read as an apology). If a real truncation indicator is wanted later, the backend should surface a `truncated` boolean on the section — deferred with Option B, where deep history actually matters. The always-present URL bar still opens any specific PR.

## Backend (recently-closed only)

Two changes, both localized.

**1. Recency-sort the search (`PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`).** The current closed-history queries are `search/issues?q=...&per_page=50` with **no `sort` param** — so GitHub returns a `best-match` (relevance) slice of ≤50 per sub-query, *not* the most-recently-closed ones. Re-sorting that relevance sample by close-time and capping repos would compute the "active repos" ranking over the wrong input (a busy repo's PRs could fall entirely outside the relevance sample and the repo would vanish). Add `&sort=updated&order=desc` to both closed-history sub-queries so the page is the most-recently-touched slice (closing a PR updates `updated_at`; GitHub search has no `sort=closed`). This makes the ≤50/sub-query sample a *recency* sample. **Honest limitation:** it is still a sample of ≤50 per sub-query — the repo ranking operates over a recency-bounded sample, **not** "all closed PRs in the window." True completeness needs search paging, which is Option B. **Axis note:** the *fetch* sorts by `updated_at` while the *cap/order* (below) sorts by `ClosedAt`/`MergedAt` — these axes differ. A PR closed within the window but bumped by a late comment can enter the sample on update activity, and a recently-closed repo whose PRs have no recent updates could fall outside the ≤50 slice. The `closed:>={cutoff}` filter (already on the query) bounds this to *within-window* reshuffling, not out-of-window leakage; full fidelity is Option B. The footer copy (§ Footer) is written to not over-promise.

**2. Repo cap, replacing the PR cap (`PRism.Core/Inbox/InboxRefreshOrchestrator.cs`, recently-closed materialization block, currently lines ~207–216).**
- Today: `.OrderByDescending(MergedAt ?? ClosedAt ?? MinValue).Take(MaxHistoryRows /* 30 PRs */)`.
- New: keep the existing `.OrderByDescending(MergedAt ?? ClosedAt ?? UpdatedAt)` close-desc sort (note the fallback changes from `DateTimeOffset.MinValue` to `UpdatedAt` so a dropped-enrichment row with null close timestamps sorts by its real `updatedAt` rather than sinking to the bottom — `UpdatedAt` is always populated). **Make it a total order with a deterministic tiebreaker** — append `.ThenByDescending(i => i.Reference.Number).ThenBy(i => i.Repo, StringComparer.Ordinal)`. Without it, when two repos' newest-close timestamps tie (bulk-merges; or dropped-enrichment rows all sharing `UpdatedAt`), the repo landing at rank N vs N+1 is decided by the non-deterministic `Task.WhenAll` sub-query concat order in `QueryClosedHistoryAsync`, so a repo group could **flicker in/out across SSE ticks** with no underlying change. Then compute the set of the **top N distinct repos** by first appearance in that (now total) close-desc order, and **filter the close-desc list to PRs in those repos**, instead of `Take(30)`. The emitted list stays a flat `PrInboxItem[]` in close-desc order; the frontend's first-seen `groupByRepo` then renders repos in most-recent-close order with no FE sort. PRs within a repo are bounded by the `per_page=50` search fetch (no paging this slice).

### Config schema (window made configurable)

`HistoryWindowDays` moves from a hard constant into the persisted `InboxConfig` record so it is hand-editable in `config.json` today and a future Settings control can bind to it.

> **Prior-deferral note.** `docs/specs/2026-06-02-merged-pr-history-deferrals.md` (lines 44–48) explicitly deferred promoting `HistoryWindowDays` to config, with the trigger *"revisit when an Int config field type exists in `ConfigStore.PatchAsync`."* That trigger is **still unmet** — `ConfigStore._allowedFields` carries only `ConfigFieldType.String` and `ConfigFieldType.Bool`. This slice revisits the deferral **at the owner's explicit request** for a configurable window, but scopes it honestly: it lands the *config-record seam* (hand-editable + deserialized + read by the orchestrator), **not** a patchable-via-API field. See the scoping bullet below.

- `PRism.Core/Config/AppConfig.cs`: add `int RecentlyClosedWindowDays = 14` as the **trailing, defaulted** parameter of `InboxConfig` (currently `InboxConfig(bool Deduplicate, InboxSectionsConfig Sections, bool ShowHiddenScopeFooter)`). The `= 14` default lives in the **C# constructor parameter** (not a separate deserializer default); `System.Text.Json` honors that same param default when the JSON key is absent (§ Backward-compat). Mirrors the existing trailing-default pattern the config already relies on — `InboxSectionsConfig.RecentlyClosed = true` and `UiConfig.Density = "comfortable"`.
- `AppConfig.Default` (AppConfig.cs:20) currently constructs `new InboxConfig(true, new InboxSectionsConfig(...), true)`. **Update it to pass the window explicitly** — `new InboxConfig(true, new InboxSectionsConfig(...), true, 14)` — for clarity rather than relying on the silent default.
- `InboxRefreshOrchestrator` reads `_config.Current.Inbox.RecentlyClosedWindowDays` instead of `InboxHistoryConstants.HistoryWindowDays` when calling `QueryClosedHistoryAsync`.
- **Backward-compat (the persisted-schema concern):** `System.Text.Json` honors optional constructor-parameter defaults when a JSON property is absent — the mechanism the codebase **already** depends on for `RecentlyClosed`/`Density` (proven green by `ConfigStorePatchAsyncDottedPathTests.InitAsync_LegacyConfigWithoutDensity_DefaultsToComfortable` / `…WithoutRecentlyClosed_DefaultsToTrue`). Storage serialization uses `KebabCaseJsonNamingPolicy` (`JsonSerializerOptionsFactory.Storage`), so the on-disk key is **`recently-closed-window-days`** (kebab), not camelCase. A pre-change `config.json` lacks that key → deserializes to **14** (not 0 — a 0-day window would silently empty the section). Add a regression test that round-trips an old-shape `AppConfig` JSON (key absent) **through `JsonSerializerOptionsFactory.Storage`** (so the naming policy is exercised, not hand-spelled) and asserts the window is 14. A trailing param does not reorder existing JSON, so no on-disk migration is needed.
- **Scope of "configurable" in this slice:** config-record seam only. Exposing it as a Settings *control* additionally requires a `ConfigFieldType.Int` in `ConfigStore.PatchAsync`'s `_allowedFields` (the prior deferral's unmet trigger) — that, plus the UI control, is a **follow-up prerequisite** (§ Out of scope), not built here. The window is therefore tunable by editing `config.json` now, and Settings-bindable once the Int field-type lands.

### Constants

`PRism.Core/Inbox/InboxHistoryConstants.cs`:
- `MaxHistoryRows = 30` (PR cap) is **removed** and replaced by `MaxHistoryRepos = 20` (Choice 3, N=20). **Rationale for 20:** it comfortably exceeds the number of repos an individual closes PRs in over a 14-day window (so the cap rarely fires — which is also why deferring deep-browse/Option B is safe), while bounding a pathological wide-fan-out user to a scannable collapsed list. It is a tunable heuristic, not load-bearing; revisit if real usage shows users regularly hitting it. This is a **backend-only** constant — the FE no longer mirrors a cap value (the footer is unconditional; § Footer), so there is no cross-tier drift risk.
- `HistoryWindowDays = 14` is removed from the constants file (now config-backed via `InboxConfig.RecentlyClosedWindowDays`); the orchestrator reads the config value. The old `InboxSection.tsx` FE constant `MaxHistoryRows = 30` is **deleted** (it backed the removed truncation hint).

## Data flow (unchanged except where noted)

1. `InboxPoller` tick → `InboxRefreshOrchestrator.RefreshAsync` → live-section searches + `QueryClosedHistoryAsync(windowFromConfig)` → shared enrichment (cached by `(ref, updatedAt)`; terminal closed PRs are cache hits after first sight) → materialize → **repo-cap recently-closed** → `InboxSnapshot` → SSE.
2. `/api/inbox` returns the snapshot as today (flat sections).
3. `InboxPage` → `InboxSection` → **`groupByRepo` fold** → `RepoGroupAccordion` (or flat rows if single-repo) → `InboxRow`.

No change to polling cadence, enrichment, dedup, or the SSE diff.

## Accessibility

- Each repo accordion is a `<button aria-expanded>` controlling its body, same pattern the section header already uses (keyboard-operable, AT-announced). The nesting is a list of disclosure buttons inside a section — no `tree`/`grid` role is introduced (avoids the `aria-required-children` class of problems seen in `PrTabStrip`, #174). 
- `InboxRow`'s existing `aria-label` (which already includes the repo) is unchanged, so a row remains self-describing even when reached inside a collapsed-then-expanded repo group — this is why dropping the *visible* repo span via `showRepo={false}` is safe for AT.
- Caret glyphs stay `aria-hidden`. The repo header's accessible name disambiguates the count rather than announcing a bare number — e.g. `"acme/api, 4 pull requests"` (an `aria-label` on the button, or visually-hidden text), so AT users aren't left guessing what "4" means.

## Testing

Frontend (vitest + RTL):
- `groupByRepo`: groups by repo; **preserves first-seen repo order** (repo of the first item first) and within-repo order; performs no timestamp sort; empty input → `[]`; single-repo input → one group. (A close-desc input yields most-recent-close repo order — assert this with a close-desc fixture to lock the FE/backend contract.)
- `InboxSection`: single-repo section renders flat rows (no accordion, rows show repo); multi-repo section renders one `RepoGroupAccordion` per repo with correct counts; recently-closed repo groups start collapsed, live-section repo groups start open; section-level collapse still hides everything.
- `RepoGroupAccordion`: toggles open/closed; renders its rows only when open; count badge matches group size; rows render with `showRepo={false}` (repo span absent inside the group).
- `InboxRow`: `showRepo={false}` hides the repo span **and its following separator** (assert no leading `·` orphan precedes the author); default (`true`) unchanged.
- `RecentlyClosedFooter`: renders the unconditional caption with no props (the old `count` prop is gone).
- `InboxPage`: existing tests updated for the nested structure; `maxDiff` still spans the whole inbox.

Backend (xunit):
- Recently-closed repo-cap: with closed PRs spanning > N repos, only the top-N most-recently-*closed* repos survive, all their PRs retained; emitted list is close-desc so first-seen grouping yields most-recent-close repo order.
- **Rewrite the existing `InboxRefreshOrchestratorTests.RecentlyClosed_CapsAtMaxRows_KeepingNewest`** — it references the now-removed `InboxHistoryConstants.MaxHistoryRows` (a compile break) and asserts the removed 30-PR cap. Replace it with the repo-cap test above. Sweep for any other reader of `MaxHistoryRows`/`HistoryWindowDays`.
- A many-PRs-few-repos fixture proves the cap is on repos, not PRs (the core behavior change vs the old 30-PR cap), and that a repo whose PRs are all newest is fully retained.
- Dropped-enrichment ordering: a closed PR with null `MergedAt`/`ClosedAt` sorts by `UpdatedAt` (not bottom-of-list), keeping backend emission order consistent with the FE's first-seen grouping.
- **Stable top-N at a tie:** two repos whose newest closes share an identical timestamp produce a deterministic repo set + order across repeated runs regardless of sub-query concat order (locks the `.ThenByDescending(Reference.Number).ThenBy(Repo)` tiebreaker so repo groups don't flicker across SSE ticks).
- Config window: orchestrator queries with the configured window; **old-shape `AppConfig` JSON round-tripped through `JsonSerializerOptionsFactory.Storage` with the `recently-closed-window-days` key absent → 14-day default** (the backward-compat assertion; exercises the kebab naming policy rather than hand-spelling the key).

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
- **Settings control + `ConfigFieldType.Int`** (`area:settings`) — this slice lands only the config-record seam. A user-facing window control additionally needs an `Int` field type added to `ConfigStore.PatchAsync`'s `_allowedFields` (currently String/Bool only — the prior deferral's unmet trigger) plus the UI. File as the prerequisite follow-up before any Settings binding.
- **Backend `truncated` signal** — if a real "older history exists" indicator is wanted on recently-closed, surface a boolean from the backend (the FE can't infer it from a pre-clamped list); naturally pairs with Option B.
- **[#219](https://github.com/prpande/PRism/issues/219) — Settings toggle to turn grouping off** (flat-list fallback). This slice ships grouping default-on and gateable at one call site; #219 adds the `inbox.groupByRepo` Bool preference + the gate + the Settings control as one unit. **Note for #219:** its "flat" mode renders the *new* repo-capped recently-closed list (≤N repos × their PRs) flat — **not** the pre-#133 30-PR cap, which is gone. Flat-mode does not reproduce the old volume.
