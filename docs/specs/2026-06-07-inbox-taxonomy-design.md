# Inbox categorization rethink + fast filter/sort (#262, absorbs #263)

## Problem

The Inbox organizes a user's PRs into six fixed categorical sections
(`review-requested`, `awaiting-author`, `authored-by-me`, `mentioned`,
`ci-failing`, `recently-closed`). Investigating #225 (cross-section dedup)
surfaced that the premise — sections are messy and need a unified-list rewrite —
does not hold: the section model is sound on its axis. But two real defects and a
missing capability remain:

1. **`ci-failing` is a category error.** It is not a *relationship* like the other
   sections; it is a *CI-state predicate*, wired as `authored-by-me ∩ failing`. Its
   scope is therefore arbitrary — a PR failing CI that you are *reviewing* never
   appears (it only gets the per-row CI dot). "Failing" is already a cross-cutting
   axis the per-row dot expresses everywhere; modelling it as a section is the
   mistake.
2. **`awaiting-author`'s label contradicts its query.** The query is
   `reviewed-by:@me` kept only when the author has *pushed commits since your last
   review* — i.e. the author has responded and the ball is back on **you** to
   re-review. The label "Awaiting author" reads as *waiting on them*.
3. **No way to narrow the inbox.** As it grows, users need "just failing checks",
   "just repo X", "just authored by me", plus free-text — a fast filter/sort. This
   is #263, which depends on the categorization decision and is **absorbed here**.

Two structural weaknesses ride along: section ordering relies on an undefined
`Dictionary<>` enumeration order (documented-fragile caveat in
`InboxRefreshOrchestrator.cs:170-185`), and the dedup behaviour is invisible and
uncontrollable (#225's residual ask).

This is the upstream IA decision; #263 (filters), #264 (CI indicator), and #219
(repo-grouping toggle) interact with it.

## Verified codebase facts (2026-06-07, against the PRism tree)

- **Section queries** (`PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs:12-25`):
  `review-requested:@me`, `reviewed-by:@me` (then `IAwaitingAuthorFilter` keeps only
  PRs with commits newer than the viewer's last review), `author:@me`, `mentions:@me`.
  `ci-failing` has **no query** — it is derived in the orchestrator.
- **`ci-failing` derivation** (`InboxRefreshOrchestrator.cs:145-166`,
  `ResolveVisibleSections():270-281`): CI is probed by `ICiFailingDetector` against
  the **`authored-by-me` superset only**; `ci-failing` = that subset where
  `Ci == Failing`. `authored-by-me` is fetched whenever *either* section is enabled.
  Consequence: `PrInboxItem.ci` is populated **only for authored PRs**; it is
  `CiStatus.None` for review-requested / mentioned PRs.
- **`CiStatus`** is `none | pending | failing` — **no `passing`** yet
  (`frontend/src/api/types.ts:79`; #264 will add it).
- **Dedup** (`PRism.Core/Inbox/InboxDeduplicator.cs`): two hardcoded `(winner, loser)`
  pairs — `review-requested > mentioned`, `ci-failing > authored-by-me`. On-by-default
  (`AppConfig.cs:20/38`), not in the wire DTO or `ConfigStore` patch allowlist. Dedup
  *demotes*, never drops: disabling the winner section falls the PR back into the loser.
- **`recently-closed`** is a separate `QueryClosedHistoryAsync` pass (two sub-queries:
  `involves:@me`, `reviewed-by:@me`), materialized **after** dedup
  (`InboxRefreshOrchestrator.cs:201-234`), repo-capped + window-bounded.
- **Snapshot wire shape** (`frontend/src/api/types.ts:115-132`):
  `InboxResponse { sections: InboxSection[]; enrichments; lastRefreshedAt;
  tokenScopeFooterEnabled }`, `InboxSection { id; label; items: PrInboxItem[] }`.
  Section **order** in the array rides on backend `Dictionary` enumeration order.
- **`PrInboxItem`** carries: reference, title, author, avatarUrl, repo, updatedAt,
  pushedAt, iterationNumber, commentCount, additions, deletions, headSha, ci,
  lastViewedHeadSha, lastSeenCommentId, mergedAt, closedAt. **No review-state / draft**
  (that is #259).
- **Frontend render**: `InboxPage.tsx` maps `sections` → `InboxSection` (accordion:
  caret + label + count; repo-grouped inside via #133 `groupByRepo`, default-on).
  `InboxToolbar.tsx` is an empty placeholder (221 B). Settings `InboxPane.tsx` renders
  six section on/off `Switch`es.

## Goals

- Keep the section model (no unified list). Fix the two categorization defects.
- Add a **search-led, client-side filter + sort layer** over the sections (absorbs #263).
- Make `ci-failing` a **CI filter axis** that covers all sections, via lazy probing.
- Make section ordering **explicit at the serialization boundary**.

## Non-goals

- No unified ranked list; no ranking function (owner-rejected during brainstorm).
- No restructure of the four relationship sections (no merging review-requested +
  awaiting-author). Out of scope and collides with in-flight #227.
- No review-state / draft **data** work — that is #259. This slice *reserves* the
  Review facet but ships it inert.
- No repo-grouping on/off toggle — that is #219, kept separate (orthogonal: the repo
  *filter* narrows; repo *grouping* organizes).
- No saved/sticky filters; no server-side filtering of section queries.

## Design

### Category changes

1. **`ci-failing` section → CI filter axis.** Remove `ci-failing` as a section
   (backend stops materializing it; frontend stops rendering it; Settings drops its
   toggle, 6 → 5). CI state becomes a filter facet (below). The
   `ci-failing > authored-by-me` dedup pair is deleted (no section to collapse); only
   `review-requested > mentioned` remains, hardcoded-on.
2. **`awaiting-author` → relabel "Needs re-review."** Section **id stays
   `awaiting-author`** (wire/string stability, state.json keys, tests); only the
   **display label** changes (backend `SectionLabels` map + `InboxPane` row label +
   the empty-copy string). Query and filter logic unchanged.
3. **`recently-closed` stays a section** (history mode, distinct data source).

### The filter / sort bar (frontend, client-side over the snapshot)

A search-led bar rendered in the (currently empty) `InboxToolbar`, above the sections:

- **Free-text** (first-class): a width-spanning input matching `title` **or** `repo`,
  case-insensitive substring. Debounced (~120 ms).
- **Facet dropdowns** to its right:
  - **CI** — `failing | pending` now; `passing` added when #264 lands `CiStatus.Passing`.
    Engaging a CI facet triggers the lazy probe (below).
  - **Repo** — owner/repo values present in the current snapshot.
  - **Author** — author logins present in the current snapshot.
  - **State** — `open | merged | closed` (derived from `mergedAt`/`closedAt`; open is
    the default population, merged/closed come from the `recently-closed` section).
  - **Review** — **inert/disabled** with a "needs #259" affordance; wired but
    non-functional until the payload exists. (Decision: render disabled, not hidden, so
    the axis is discoverable and #259 is a drop-in.)
- **Sort** (right-aligned): `Updated` (default) · `Recently pushed` · `Diff size` ·
  `Comments`. Sort applies **within** each section (sections are not reordered).
- **Active-state affordances:** active facets highlight; a summary line shows
  "`N` filters · showing `X` of `Y` PRs · Clear".

**Filter semantics.** Filters AND across axes; multiple values within one facet OR.
Applied as a pure function over `InboxResponse.sections[].items` in the frontend —
**no server round-trip**, instant. Section on/off toggles (Settings) remain
server-side and orthogonal.

**Empty sections under an active filter are hidden** (only sections with ≥1 match
render). With no active filter, behaviour is unchanged (empty sections show their
existing empty copy). `recently-closed` keeps its existing default-collapsed behaviour.

**Persistence: transient.** Filters live in component state; a reload clears them. The
**sort default** is the one durable piece — persisted as a new scalar preference
(`inbox.defaultSort`, default `updated`) via the existing `ConfigStore` allowlist +
`usePreferences` pattern. (Filters are momentary triage; a sort default is a taste.)

### CI lazy probe (CI-3) — backend

Engaging a CI facet must reflect CI state for **all** visible PRs, not just authored
ones. New on-demand path:

- **Endpoint:** `POST /api/inbox/ci-probe` taking a list of `{ owner, repo, number,
  headSha }` and returning `{ ref, headSha, ci }[]`. Reuses `ICiFailingDetector`'s
  check-runs logic, generalized from "authored superset" to "an arbitrary PR set".
- **Frontend** calls it only for **currently visible** PRs whose `ci == none` (not yet
  probed) when a CI facet is engaged; merges results into local state; shows a brief
  per-row "checking…" state. Results cached client-side **keyed by `(ref, headSha)`**
  so re-engaging or re-renders don't re-probe; a new head-SHA invalidates.
- **Budget:** server caps concurrency (reuse the detector's existing cap of 8) and
  bounds the request set (visible PRs only, hard cap e.g. 50). This pays the
  Checks-API cost **only when the filter is used**, never per refresh tick — the reason
  ci-failing was authored-only originally.
- Authored PRs already carry `ci` from the normal refresh, so they need no probe.

### Explicit section ordering (backend wire change)

`InboxResponse.sections` is already an **array** on the wire, so order is expressible;
the fragility is that the backend builds it from `Dictionary` enumeration. Make the
order **explicit and load-bearing**: define a canonical `SectionOrder` constant
(`review-requested`, `awaiting-author`, `authored-by-me`, `mentioned`,
`recently-closed`) and order the serialized array by it at the `/api/inbox` boundary,
independent of dictionary enumeration. Removes the documented caveat. No new wire field
needed (the array's position *is* the order); add a backend ordering step + a test that
pins it.

## Component breakdown

**Frontend (new):**
- `InboxToolbar.tsx` — becomes the filter/sort bar (was a placeholder).
- `useInboxFilters` hook — holds filter/sort state, exposes the filter predicate +
  comparator; derives available Repo/Author facet values from the snapshot.
- `applyInboxFilters(sections, filters, sort)` — pure function (filter + sort, hide
  empties). Unit-tested in isolation.
- `useCiProbe` hook — lazy CI probe call + `(ref, headSha)` cache + in-flight state.
- Filter primitives: `FilterFacet` dropdown, `FilterSearchInput`, `FilterSummary`.

**Frontend (changed):**
- `InboxPage.tsx` — thread filters through; render filtered/sorted sections; hide
  empties when filtering.
- `InboxSection.tsx` — accept pre-filtered items; CI "checking…" row state.
- Settings `InboxPane.tsx` — six rows → five (drop `ci-failing`); relabel
  `awaiting-author` → "Needs re-review"; add the `inbox.defaultSort` control.
- `api/types.ts` — `inbox.defaultSort` preference; CI-probe request/response types.

**Backend (changed/new):**
- `InboxRefreshOrchestrator` — stop materializing the `ci-failing` section; keep CI
  probing the authored superset for the per-row dot; remove the `ci-failing` branch
  from `ResolveVisibleSections`.
- `InboxDeduplicator` — drop the `ci-failing > authored-by-me` pair.
- `InboxSectionsConfig` — remove `CiFailing` (migration note below); 6 → 5 fields.
- New `POST /api/inbox/ci-probe` endpoint + a `ProbeAsync(IReadOnlyList<PrRef+headSha>)`
  generalization of the detector.
- Canonical `SectionOrder` + ordering step at the `/api/inbox` serializer; pinning test.
- `inbox.defaultSort` in `AppConfig`/`InboxConfig` + `ConfigStore` allowlist + DTO.

### Config migration (`InboxSectionsConfig.CiFailing` removal)

`state.json` persists `InboxConfig.Sections`. Dropping the `CiFailing` bool must
deserialize old configs without throwing: rely on the existing trailing-default /
tolerant-deserialization pattern (#133/#219 precedent) — an unknown `ciFailing` key in
a persisted config is **ignored** on read, and the record no longer emits it on write.
Add a test loading a pre-change `state.json` (with `ciFailing: true/false`) and asserting
a clean load. No data loss: the user's other section toggles are preserved.

## Testing strategy (TDD)

- **`applyInboxFilters`** (pure): free-text title/repo match; each facet; AND-across /
  OR-within; sort comparators; empties hidden when filtering, shown when not.
- **`useInboxFilters`**: facet-value derivation from a snapshot; clear resets all.
- **`useCiProbe`**: probes only `ci == none` visible PRs; `(ref, headSha)` cache hit
  skips re-probe; new head-SHA invalidates; in-flight state.
- **CI-probe endpoint**: maps a PR set → CI states; concurrency cap; set-size cap;
  auth/empty-token behaviour consistent with the detector.
- **Orchestrator**: `ci-failing` section absent from snapshot; authored per-row CI dot
  still populated; dedup no longer references `ci-failing`.
- **Ordering**: serialized `sections[]` follows `SectionOrder` regardless of build order.
- **Config migration**: old `state.json` with `ciFailing` loads clean; round-trips
  without the key.
- **Settings**: five section rows; "Needs re-review" label; `defaultSort` control
  persists.
- **e2e (B1)**: filter bar narrows live; emptied section hides; CI facet shows
  checking → result; sort reorders within sections; light + dark.

## Risk classification (for the human gate)

- **Tier:** T3 (slice-sized, new behaviour, cross-cutting FE+BE).
- **Risk:** **gated — B1 UI.** New filter bar, a removed section, relabeled section,
  and section-under-filter behaviour all need a human visual assert against a real
  account. `design` + `needs-design` labels.
- **No B2 surface:** no auth/PAT/token-storage change; the CI-probe endpoint reads
  check-runs only (no scope change — the detector already reads them); no submit
  pipeline, cross-tab stamp, persisted-schema migration beyond the tolerant
  section-config drop (covered by a migration test), desktop seam, or security surface.
  The `state.json` section-config change is additive-tolerant, not a structural
  migration.

## Rejected alternatives

- **Unified ranked list + filters** (the issue's framing): owner-rejected — invents a
  ranking function, discards a learnable categorical IA, churns in-flight #227/#259.
- **CI filter over today's authored-only payload (CI-2):** reproduces the exact
  authored-only scope gap the change exists to fix; rejected in favour of lazy probe.
- **Probe CI for all PRs every refresh tick (CI-1):** unbounded Checks-API cost against
  the rate limits that made ci-failing authored-only to begin with.
- **Expose a dedup toggle (#225 literal ask):** after `ci-failing` leaves, one sensible
  pair remains; a Settings control for it is low value. Leave hardcoded-on, document,
  close #225's thread as working-as-intended.
- **Saved/sticky filters:** filters are momentary triage; persisting them is the wrong
  model. Only the sort *default* persists.
- **Renaming the `awaiting-author` section id:** would churn state.json keys, SSE
  `changedSectionIds`, and tests for a display-only fix. Label-only change instead.

## Deferrals / follow-ups

- **#259** review-state / draft payload → activates the inert **Review** facet (and a
  draft filter). Drop-in once the payload lands.
- **#264** `CiStatus.Passing` → adds the `passing` value to the CI facet.
- **#219** repo-grouping on/off toggle — separate, orthogonal.
- **#225** — close its conceptual thread here (dedup is visible-by-design via this spec;
  no toggle shipped).

## Open questions

- None blocking. (Resolved in brainstorm: surface = search-led bar; empties hidden;
  CI = lazy probe CI-3; filters transient, sort-default persisted; dedup hardcoded;
  label = "Needs re-review".)
