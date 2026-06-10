# Inbox categorization rethink + fast filter/sort (#262, absorbs #263)

> **Revision note (post ce-doc-review, 2026-06-07).** The CI axis moved from an
> on-demand lazy-probe endpoint (brainstorm "CI-3") to a **server-side probe over
> all inbox PRs during refresh**. The review surfaced that the lazy-probe design
> deadlocked (failing PRs in filter-emptied/collapsed sections could never be
> probed) and shifted the trust boundary to client-supplied repo coordinates. The
> server-side approach dissolves both and fixes the per-row CI dot's authored-only
> scope as a side effect. See **Rejected alternatives** for the full reasoning. The
> `State` and inert `Review` facets were also dropped (see Scope).
>
> **Revision note 2 (post ce-doc-review round 2, 2026-06-08).** Round 2 verified that
> the round-1 server-side widening is not free: a CI `429` **throws**
> (`RateLimitExceededException`) and — because the orchestrator has no CI fault
> continuation — discards the **entire** snapshot for that tick, so widening the probe
> set couples the no-CI sections (`review-requested`, `awaiting-author`, `mentioned`)
> to CI rate-limit pressure they have no dependency on today; and degraded probes
> (fine-grained-PAT `403` on the Checks API, transient `5xx`) return `ci == none`,
> indistinguishable from passing, so a "pure client-side" CI filter would **silently
> under-match**. The owner chose **Option A**: keep the server-side probe but add CI
> **fault-isolation** (a CI fault degrades only that tick's CI to `none` + retries
> next tick; it never discards section data) and a **`ciProbeComplete` snapshot flag**
> driving a "CI status may be incomplete" hint on the CI facet, so under-match is
> visible not silent. The CI facet trigger also carries the **failing count when
> unselected** (restores the at-a-glance "N failing" the removed section gave). The
> slice **decomposes into PRs** (see Implementation decomposition). Doc-accuracy fixes
> (`SectionLabels`→`Labels`, `sectionsAsItems`→`rawSec3`, the false "frontend ignores
> unknown section id" claim) and interaction-gap fills (filter expand/collapse, facet
> value derivation, `recently-closed` under filter) are folded in below.

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
   appears (it only gets the per-row CI dot, and even that dot is authored-only
   today). "Failing" is a cross-cutting axis, not a relationship; modelling it as a
   section is the mistake.
2. **`awaiting-author`'s label contradicts its query.** The query is
   `reviewed-by:@me` kept only when the PR's head SHA advanced past your last
   review — i.e. it changed since you reviewed and the ball is back on **you** to
   re-review. The label "Awaiting author" reads as *waiting on them*.
3. **No way to narrow the inbox.** As it grows, users need "just failing checks",
   "just repo X", "just authored by me", plus free-text — a fast filter/sort. This
   is #263, which depends on the categorization decision and is **absorbed here**.

Two structural weaknesses ride along: section ordering relies on an undefined
`Dictionary<>` enumeration order (documented-fragile caveat in
`InboxRefreshOrchestrator.cs:170-185`, built into the array at `InboxEndpoints.cs`),
and the dedup behaviour is invisible and uncontrollable (#225's residual ask).

This is the upstream IA decision; #263 (filters), #264 (CI indicator), and #219
(repo-grouping toggle) interact with it.

## Verified codebase facts (2026-06-07, against the PRism tree)

- **Section queries** (`PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs:12-25`):
  `review-requested:@me`, `reviewed-by:@me` (then `IAwaitingAuthorFilter` keeps only
  PRs whose head SHA differs from the viewer's last-reviewed SHA), `author:@me`,
  `mentions:@me`. These run on the GitHub **Search** API (30-rpm secondary limit) —
  the reason the section set is kept small. `ci-failing` has **no query**.
- **CI detection** (`PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`): probes
  `GET repos/{o}/{r}/commits/{sha}/check-runs` + combined status — the **REST core**
  API (5000/hr), a *different and far larger* budget than Search. It **already caches
  by `(PrReference, headSha)`** (`ConcurrentDictionary _cache`), is concurrency-capped
  at 8, and handles 429/403(fine-grained)/404. Today the orchestrator runs it against
  the **`authored-by-me` superset only** (`InboxRefreshOrchestrator.cs:145-158`), so
  `PrInboxItem.ci` is populated for authored PRs and is `CiStatus.None` everywhere else.
- **`CiStatus`** is `none | pending | failing` — **no `passing`** yet
  (`frontend/src/api/types.ts:79`; #264 will add it).
- **Dedup** (`PRism.Core/Inbox/InboxDeduplicator.cs`): two hardcoded `(winner, loser)`
  pairs — `review-requested > mentioned`, `ci-failing > authored-by-me`. On-by-default,
  not in the wire DTO or patch allowlist. Dedup *demotes*, never drops.
- **`recently-closed`** is a separate `QueryClosedHistoryAsync` pass, materialized
  **after** dedup, repo-capped (`MaxHistoryRepos`) + window-bounded. It is the **only**
  section whose items carry non-null `mergedAt`/`closedAt`.
- **Snapshot wire shape** (`frontend/src/api/types.ts:115-132`):
  `InboxResponse { sections: InboxSection[]; enrichments; lastRefreshedAt;
  tokenScopeFooterEnabled }`. Section **order** in the array is built from backend
  `Dictionary` enumeration at the `/api/inbox` serializer (`InboxEndpoints.cs`).
- **`PrInboxItem`** carries reference, title, author, avatarUrl, repo, updatedAt,
  pushedAt, iterationNumber, commentCount, additions, deletions, headSha, ci,
  lastViewedHeadSha, lastSeenCommentId, mergedAt, closedAt. **No review-state / draft**
  (that is #259).
- **Config persistence:** `InboxSectionsConfig` is part of `AppConfig`, persisted by
  `ConfigStore` to **`config.json`** (`ConfigStore.cs:48`). `state.json` is a *separate*
  store (`AppStateStore`, review sessions / tab stamps). Tolerant deserialization
  (unknown keys skipped, not rejected) is a property of `ConfigStore` /
  `JsonSerializerOptionsFactory.Storage`, **not** `state.json`.
- **Preference plumbing:** `PreferencesContext.tsx` `readKey`/`writeKey` branch on
  theme/accent/aiPreview/density and then **assume every remaining key is
  `inbox.sections.*`** (`key.slice('inbox.sections.'.length)`). There is **no scalar
  inbox preference today** — every inbox key is a section bool. `ConfigStore`'s patch
  allowlist (`_allowedFields`) types fields as `Bool` or `String`.
- **`InboxToolbar.tsx`** is **not** empty — it renders `<PasteUrlInput />` (a
  functional PR-URL paste box with its own tests). The filter bar must *coexist* with
  it, not replace it.
- **`InboxPage.tsx:23,84`** computes `allEmpty = sections.every(items.length === 0)`
  and renders `<EmptyAllSections />` ("Nothing in your inbox…") when true. A filter
  that matches nothing makes every section empty → this fires with wrong copy unless
  gated.
- **Frontend render**: `InboxPage` maps `sections` → `InboxSection` (accordion: caret
  + label + count; repo-grouped inside via #133 `groupByRepo`, default-on). Section
  bodies and repo-groups mount only when expanded (`{open && …}`); `recently-closed`
  is default-collapsed. Settings `InboxPane.tsx` renders six section `Switch`es.

## Goals

- Keep the section model (no unified list). Fix the two categorization defects.
- Add a **search-led, client-side filter + sort layer** over the sections (absorbs #263).
- Make `ci-failing` a **CI filter axis** that covers all sections, by probing CI for
  the whole inbox server-side (which also fixes the per-row dot's authored-only scope).
- Make section ordering **explicit at the serialization boundary**.

## Non-goals

- No unified ranked list; no ranking function (owner-rejected during brainstorm).
- No restructure of the four relationship sections; no merging. (Collides with #227.)
- No review-state / draft **data** work — that is #259. The Review axis is **deferred
  entirely** (no inert control shipped; see Scope).
- No repo-grouping on/off toggle — that is #219, kept separate (orthogonal: the repo
  *filter* narrows; repo *grouping* organizes).
- No saved/sticky filters; only the sort *default* persists. No State (open/merged/
  closed) facet (see Scope).

## Design

### Category changes

1. **`ci-failing` section → CI filter axis.** Remove `ci-failing` as a section
   (backend stops materializing it; frontend stops rendering it; Settings drops its
   toggle, 6 → 5). CI state becomes a filter facet. The `ci-failing > authored-by-me`
   dedup pair is deleted (no section to collapse); only `review-requested > mentioned`
   remains, hardcoded-on. **Tradeoff (accepted):** today `ci-failing` is a default-on
   section — the user sees their failing PRs with zero interaction. As a filter it is
   one click away instead of always-visible. The win is correctness (failing across
   *all* relationships, not just authored) + correct per-row dots everywhere; the cost
   is that "show me what's failing" becomes a deliberate filter. Mitigated by making
   the CI facet a prominent, first-position facet in the bar.
2. **`awaiting-author` → relabel "Needs re-review."** Section **id stays
   `awaiting-author`** (wire/string stability, state.json session keys, SSE
   `changedSectionIds`, tests); only the **display label** changes (the backend
   `Labels` map in `InboxEndpoints.cs:9-17` — the `["awaiting-author"]` entry — plus the
   `InboxPane` row label + empty-copy string). The label is
   deliberately **causally neutral** — "Needs re-review" holds for any PR whose head
   advanced past your last review, regardless of *who* pushed (the filter keys on SHA
   inequality, not author attribution, so "the author responded" would be an
   over-claim).
3. **`recently-closed` stays a section** (history mode, distinct data source).

### CI probing moves server-side (the key change)

During each refresh, the orchestrator probes CI for **all inbox section PRs**, not just
the authored superset, by feeding the full distinct PR set to the existing
`ICiFailingDetector`. The detector already caches by `(ref, headSha)`, runs on the REST
core budget (5000/hr, separate from the Search secondary limit), and is capped at 8
concurrent, so steady-state cost is changed-heads-only; cold-start probes ≈ inbox size.

**CI fault-isolation (Option A — required, not optional).** Today the detector throws
`RateLimitExceededException` on `429` (`GitHubCiFailingDetector.cs:104,206`), the
orchestrator's CI call is unguarded (`InboxRefreshOrchestrator.cs:149`), and the
orchestrator deliberately has **no** fault continuation (`:75-76`) — so any CI fault
propagates to `InboxPoller`'s tick-level catch and discards the **whole** snapshot.
That fragility is tolerable while CI probes only the small authored superset; widening
it to every section makes it likely and couples the no-CI sections to CI rate pressure.
The widening therefore **must** wrap the CI fan-out so a `429`/fault leaves the affected
PRs at `ci == none` **for that tick only** (retried next tick, exactly as degraded
probes already are — they are not cached, `GitHubCiFailingDetector.cs:49`) and **never**
discards section data. Net effect: the inbox becomes *more* resilient than today (a CI
rate-limit no longer freezes the whole inbox), at the cost of transiently-incomplete CI.

**`ciProbeComplete` flag (handles the under-match).** Degraded probes return `ci == none`,
indistinguishable from passing/no-checks, so a CI filter over an incompletely-probed
snapshot silently under-matches — persistently for fine-grained-PAT users, whose Checks
API `403`s every tick (#213 documents FG-PAT as supported). The snapshot therefore carries
a `bool ciProbeComplete` (false whenever ≥1 probe degraded this tick); when it is false and
the CI facet is engaged, the filter bar shows a non-blocking "CI status may be incomplete"
hint. Under-match becomes **visible**, not silent. (This is the honest cost of Option A vs
the removed always-visible section — surfaced, not hidden.)

Consequences:
- `PrInboxItem.ci` is populated for **every** section (subject to probe success), so the
  per-row CI dot is correct everywhere (fixes a latent authored-only limitation), and the
  CI **filter is a client-side predicate over the snapshot** — instant, no endpoint, no
  per-request "checking" state, no deadlock. The `ciProbeComplete` hint covers the
  degraded-probe gap.
- The detector's `DetectAsync` parameter is renamed from `authoredItems` to a neutral
  `items` (the logic is already scope-agnostic — it probes per-ref). The orchestrator's
  CI fan-out source is the **distinct-by-ref raw live set** (today `rawSec3`), with
  `ciByRef` built **before** `MaterializePrInboxItem` consumes it (`:146-150,189`) — not
  the post-materialization `sections` dict. `ResolveVisibleSections`' "force authored when
  ci-failing enabled" branch (`:276`) is removed (ci-failing is gone).
- **`recently-closed` is excluded from CI probing** — CI is a live-PR concept; closed
  PRs get `ci == none` and the CI facet does not apply to that section (it flows through
  the separate `closedRaw` path and never enters the live raw set).
- **`passing`** still waits on #264. Until then the CI facet offers `failing` and
  `pending`; the snapshot already distinguishes them. A probed-not-failing-not-pending
  PR is `none` (indistinguishable from "no checks") until #264 adds `passing` — so the
  CI facet ships with **`failing` and `pending` values only**, no "passing" value, and
  the empty-result copy (below) covers "nothing failing."

### The filter / sort bar (frontend, client-side over the snapshot)

A search-led bar in `InboxToolbar`, **alongside the existing `PasteUrlInput`** (paste
box retained — e.g. paste input on one row, filter controls on the next), above the
sections:

- **Free-text** (first-class): a width-spanning input matching `title` **or** `repo`,
  case-insensitive substring, debounced (~120 ms). Inline clear (✕) button when
  non-empty; `Esc` clears it.
- **Facets** (multi-select; values OR within a facet, facets AND across):
  - **CI** (first position) — `failing | pending`. Client-side over the `ci` field. The
    CI trigger shows the **failing count even when no CI value is selected** (e.g.
    "CI · 3") — this restores the at-a-glance "how many are failing" that the removed
    `ci-failing` section header gave for free; when `ciProbeComplete` is false the trigger
    also carries the "CI status may be incomplete" hint (see CI probing).
  - **Repo** — owner/repo values present in the snapshot.
  - **Author** — author logins present in the snapshot.
  Each facet is a **checkbox popover**; the trigger shows the facet name when nothing is
  selected and a count when ≥1 is selected (e.g. "Repo (2)" — except CI, which always
  shows its failing count). Repo/Author popovers include an inline type-to-filter when
  their value list is long. **Facet value lists derive from the full snapshot, not the
  currently-filtered result set** (no cascading): selecting "CI: failing" does not prune
  the Repo list. This is the right default for triage — the user always sees every repo,
  and a zero-result combination explains itself via the zero-state — and it avoids a
  re-derivation path on every filter change.
- **Sort** (right-aligned): `Updated` (default) · `Recently pushed` · `Diff size` ·
  `Comments`. Sort applies **within** each visible section (sections are not reordered),
  including `recently-closed`. Comparators are defined over `PrInboxItem`; ties break by
  `reference.number` for a stable order.
- **Active-state affordances:** active facets highlight; a summary line shows
  "`N` filters · showing `X` of `Y` PRs · Clear". The summary line is **hidden when no
  filter is active**; the toolbar reserves its height so engaging a filter does not
  shift the section list. `Clear` resets **all** filters including free-text.

**Filter semantics.** A pure function over `InboxResponse.sections[].items` in the
frontend — no server round-trip, instant for every facet (CI included, since `ci` is in
the snapshot). Section on/off toggles (Settings) remain server-side and orthogonal.

**Empty-state behaviour.**
- With **no active filter**: unchanged. Empty sections show existing empty copy;
  `EmptyAllSections` shows iff the inbox is genuinely empty.
- With an **active filter**: emptied sections are **hidden** (only sections with ≥1
  match render). `EmptyAllSections` is suppressed while filtering. If the filter matches
  **nothing across all sections**, a distinct zero-state renders — "No PRs match your
  filters · Clear" — with the filter bar still visible. This is separate from the
  no-token `EmptyAllSections` copy.

**Expand/collapse under filter.** When a section transitions from hidden-by-filter to
visible-by-filter (the filter now matches ≥1 of its rows), it renders **expanded**
regardless of its prior collapsed state — restoring its prior collapsed state would hide
the very matches the filter surfaced. A manual collapse the user makes *during* a filter
session persists for that session; clearing the filter restores the pre-filter
expand/collapse state. `recently-closed` (default-collapsed) is the one exception: when a
filter matches rows inside it, it renders **visible but still collapsed**, with the match
count on its header — so the user knows matches exist there without history auto-expanding.

**`recently-closed` under a CI facet.** Its items always carry `ci == none` (excluded from
probing), so any CI-value selection matches zero of them and the section hides — a
permanent consequence of selecting *any* CI value (history is never CI-bearing). This is
intended (a "show me failing" triage filter should not surface closed PRs). The Repo and
Author facets apply to `recently-closed` normally.

**Persistence: transient.** Filters live in component state; reload clears them. The
**sort default** is the one durable piece (see below).

### `inbox.defaultSort` preference (first non-section inbox preference)

Persisting a sort default is **not** a drop-in of the section-bool pattern — it is the
first scalar inbox preference, so it requires explicit plumbing:
1. **`AppConfig`/`InboxConfig`:** add `string DefaultSort` (default `"updated"`).
2. **`ConfigStore._allowedFields`:** add `inbox.defaultSort` as a `String` field +
   a `PatchAsync` arm. Validate the value against the allowed set
   (`updated|pushed|diff|comments`); reject unknown values (the existing string fields
   are unvalidated, but a bad sort key would render undefined, so this one is checked).
3. **Wire DTO:** add `defaultSort` to `InboxPreferencesDto` + `BuildResponse` + the
   `PreferenceKey` union.
4. **`PreferencesContext.readKey/writeKey`:** add an explicit `inbox.defaultSort` branch
   **before** the `inbox.sections.*` fallthrough (otherwise the slice logic mis-routes
   it into `sections['defaultSort']` and corrupts optimistic state).
5. **Settings control:** a labeled **select/dropdown** (not a switch) in `InboxPane`,
   placed after the five section rows, applied immediately like the switches.

### Explicit section ordering (backend wire change)

Define a canonical `SectionOrder` constant
(`review-requested`, `awaiting-author`, `authored-by-me`, `mentioned`,
`recently-closed`) and order the serialized `sections[]` by it at the `/api/inbox`
boundary, independent of `Dictionary` enumeration. Removes the documented fragility.
A pinning test asserts the order regardless of build order. No frontend change is needed
for unknown ids: `InboxPage.tsx:85-94` already maps **every** section it receives and
renders it with a fallback label (`InboxEndpoints.cs:45`), and the Electron build bundles
the same backend + frontend (no independent-deploy version skew is reachable), so a stale
`ci-failing` from a downgraded backend would simply render with its label — not be
silently dropped. **Do not** add silent-drop-on-unknown-id logic: it would lose PRs that
appear only in an unrecognized section. (An earlier draft mis-claimed the frontend already
ignores unknown ids; it does not, and it should not.)

### Config migration (`InboxSectionsConfig.CiFailing` removal)

`config.json` (via `ConfigStore`) persists `InboxConfig.Sections`. Dropping the
`CiFailing` bool must deserialize old configs cleanly: rely on `ConfigStore`'s tolerant
deserialization (`JsonSerializerOptionsFactory.Storage` does not set
`UnmappedMemberHandling.Disallow`, so an unknown `ciFailing` key is skipped on read; the
record no longer emits it on write). Add a test loading a pre-change **`config.json`**
(with `ciFailing: true/false`) through `ConfigStore` and asserting a clean load with the
other section bools preserved. No data loss.

## Component breakdown

**Frontend (new):**
- `useInboxFilters` hook — filter/sort state + the filter predicate + comparator;
  derives Repo/Author facet values from the snapshot.
- `applyInboxFilters(sections, filters, sort)` — pure function (filter + sort + hide
  empties). Unit-tested in isolation.
- Filter primitives: `FilterFacet` (checkbox popover), `FilterSearchInput`,
  `FilterSummary`, the zero-match state.

**Frontend (changed):**
- `InboxToolbar.tsx` — hosts the filter/sort bar **and** keeps `PasteUrlInput`.
- `InboxPage.tsx` — thread filters through; render filtered/sorted sections; hide
  empties when filtering; gate `EmptyAllSections` on `!filterActive`; render the
  zero-match state.
- Settings `InboxPane.tsx` — six rows → five (drop `ci-failing`); relabel
  `awaiting-author` → "Needs re-review"; add the `inbox.defaultSort` select.
- `PreferencesContext.tsx` — add `inbox.defaultSort` read/write branch **before** the
  `inbox.sections.*` fallthrough; remove the `inbox.sections.ci-failing` arm of the
  `PreferenceKey` union.
- `api/types.ts` — add `defaultSort` preference + `PreferenceKey` member; add
  `ciProbeComplete: boolean` to `InboxResponse`; remove the `ci-failing` key from
  `InboxSectionsPreferences`.
- Per-row CI dot — now rendered in previously-dotless sections (`review-requested`,
  `mentioned`, `awaiting-author`); add a tooltip / `aria-label` ("CI: failing" / "CI:
  pending") so the dot is self-describing where users have no prior exposure to it.
  (Verify whether the authored-context dot already carries one; if so, just ensure it
  applies in the new locations.)
- Filter bar — consume `ciProbeComplete`: when false and the CI facet is engaged, show
  the non-blocking "CI status may be incomplete" hint.

**Backend (changed):**
- `InboxRefreshOrchestrator` — stop materializing `ci-failing`; run the CI detector over
  the **distinct-by-ref raw live set** (`rawSec3`, excluding `recently-closed`'s
  `closedRaw` path) so `ci` populates everywhere; build `ciByRef` **before**
  `MaterializePrInboxItem`; drop the `ci-failing` branch from `ResolveVisibleSections`
  (`:276`). **Wrap the CI fan-out in fault-isolation** (reverses the deliberate
  no-continuation choice at `:75-76`, now that probe volume is large): a `429`/fault
  leaves affected refs at `ci == none` for the tick and is retried next tick — it must
  **not** propagate to the tick-level catch and discard the snapshot. Set
  `ciProbeComplete = false` on the snapshot when ≥1 probe degraded this tick.
- `GitHubCiFailingDetector` / `ICiFailingDetector` — rename `authoredItems` → `items`
  (scope-agnostic; no behavioural change beyond input set); update the interface XML-doc
  comment (currently says "For each authored PR …") to match the widened scope.
- `InboxDeduplicator` — drop the `ci-failing > authored-by-me` pair.
- `InboxSectionsConfig` — remove `CiFailing` (6 → 5 fields) + migration test.
- `Labels` map (`InboxEndpoints.cs`) — "Needs re-review" for `awaiting-author`.
- Canonical `SectionOrder` + ordering step at the `/api/inbox` serializer + pinning test.
- `InboxResponse` snapshot — add `ciProbeComplete` (serialized at the `/api/inbox`
  boundary; default `true`, set `false` when ≥1 CI probe degraded this tick).
- `AppConfig`/`InboxConfig` `DefaultSort` + `ConfigStore` allowlist arm + DTO + value
  validation. **Positional-record gotcha:** `InboxConfig`'s last param is the defaulted
  `RecentlyClosedWindowDays = 14` and `AppConfig.Default` constructs it positionally —
  add `DefaultSort` with a default (or before the trailing defaulted param) and update the
  `AppConfig.Default` call site.

## Testing strategy (TDD)

- **`applyInboxFilters`** (pure): free-text title/repo match; CI/Repo/Author facets;
  AND-across / OR-within; sort comparators incl. tie-break; empties hidden when
  filtering, shown when not; all-match-nothing → zero-state, not `EmptyAllSections`.
- **`useInboxFilters`**: facet-value derivation; clear resets all incl. free-text.
- **Orchestrator**: `ci-failing` section absent; `ci` populated for review-requested /
  mentioned PRs (not just authored); `recently-closed` left `none`; dedup no longer
  references `ci-failing`. **CI fault-isolation**: a detector `429`/throw leaves the
  snapshot's section data intact (sections still publish), affected refs are `ci == none`,
  and `ciProbeComplete == false` — the tick is **not** discarded (regression test against
  the round-2 finding). A clean tick sets `ciProbeComplete == true`.
- **Detector**: probing a mixed (authored + non-authored) set populates CI for all;
  cache hit by `(ref, headSha)` skips re-probe; degraded results uncached (existing
  contract preserved under the renamed param).
- **Ordering**: serialized `sections[]` follows `SectionOrder` regardless of build order;
  an unknown section id renders with a fallback label (not dropped).
- **Config migration**: old `config.json` with `ciFailing` loads clean; round-trips
  without the key.
- **`inbox.defaultSort`**: read/write routes to the scalar branch (not
  `sections['defaultSort']`); invalid value rejected by `PatchAsync`; Settings select
  persists and re-hydrates.
- **Settings**: five section rows; "Needs re-review" label; `PasteUrlInput` still present.
- **e2e (B1)**: filter bar narrows live; CI facet filters failing across sections;
  emptied sections hide and re-reveal **expanded**; all-match-nothing shows the zero-state;
  sort reorders within sections; `PasteUrlInput` coexists; light + dark. **Separate B1
  assert (always-on, independent of the filter):** the per-row CI dot now appears on
  `review-requested` / `mentioned` / `awaiting-author` rows that were previously dotless —
  a B1 reviewer must verify this unconditional change, not only filter behaviour.

## Design decisions deferred to the plan (implementation-level)

These are real decisions but belong in `writing-plans`, not this spec; flagged so they
are not forgotten: exact keyboard model for the facet popovers (open/close/arrow/Esc,
focus return) and `aria-live` wording for the summary line (follow existing PRism
control patterns); the design-token surface level for the toolbar + active-facet
highlight (mirror the existing toolbar/Settings tokens); debounce leading-edge vs
trailing; and the precise two-row vs one-row toolbar layout that keeps `PasteUrlInput`
and the filter controls uncramped. Desktop/Electron is the primary target, so narrow-
viewport responsive behaviour is out of scope.

## Implementation decomposition (for `writing-plans`)

This slice is four loosely-coupled units; `writing-plans` owns the final split, but the
recommended decomposition is:

- **PR1 — backend (no UI gate).** `ci-failing` removal + dedup-pair drop +
  `ResolveVisibleSections` cleanup; CI fan-out widening **with fault-isolation +
  `ciProbeComplete`**; `authoredItems`→`items` rename + XML-doc update; canonical
  `SectionOrder` + pinning test; `InboxSectionsConfig` field removal + `config.json`
  migration test. Backend-only, hermetically testable.
- **PR2 — filter/sort bar (B1-gated).** `useInboxFilters`, `applyInboxFilters`, filter
  primitives, `InboxToolbar` integration, `EmptyAllSections` gating + zero-match state,
  expand/collapse-under-filter, per-row CI dot in new sections + tooltip, the CI-trigger
  failing count + incomplete hint. This is where the human visual asserts live.
- **PR3 — `inbox.defaultSort` preference.** `AppConfig`/`ConfigStore` allowlist arm + DTO
  + value validation + `PreferencesContext` branch + `InboxPane` select. Independent of
  PR1/PR2; can fold into PR2 or ship separately.

PR1 must merge before PR2 (PR2's CI facet depends on `ci` being populated inbox-wide).

## Risk classification (for the human gate)

- **Tier:** T3 (slice-sized, new behaviour, cross-cutting FE+BE).
- **Risk:** **gated — B1 UI.** New filter bar, a removed section, a relabeled section,
  section-under-filter behaviour, and the new per-row CI dots in previously-dotless
  sections all need a human visual assert against a real account. `design` +
  `needs-design` labels.
- **No B2 surface.** The original lazy-probe endpoint that *would* have taken
  client-supplied repo coordinates (a security trust-boundary shift flagged in review)
  is **removed** — CI is now probed server-side over snapshot-sourced PRs via the
  existing detector, the same trust boundary as today. No auth/PAT/token-storage change;
  no new client-input endpoint; no submit pipeline, cross-tab stamp, persisted-schema
  migration beyond the tolerant `config.json` section-config drop (covered by a test),
  desktop seam, or security surface. The CI probe widening is a read-volume increase on
  the REST budget, not a new capability or scope.

## Rejected alternatives

- **Unified ranked list + filters** (the issue's framing): owner-rejected — invents a
  ranking function, discards a learnable categorical IA, churns in-flight #227/#259.
- **CI-3 — lazy on-demand probe via `POST /api/inbox/ci-probe`** (the brainstorm choice,
  reversed in review): (a) **deadlocks** — a pure client-side CI predicate drops every
  `ci==none` row, emptying and hiding the non-authored sections before their PRs can be
  probed, so failing PRs you review never surface; (b) probing only DOM-visible PRs
  misses collapsed sections / repo-groups and the default-collapsed `recently-closed`;
  (c) takes **client-supplied `{owner,repo,number,headSha}`** and probes with the user's
  PAT — an arbitrary-repo probe vector needing snapshot-membership validation, a
  body-size cap, and SHA/owner/repo input validation to be safe; (d) contradicts the
  "instant" filter contract and needs bespoke latency/error/timeout UX. The server-side
  probe avoids all four.
- **Original "CI-1 is unbounded cost" objection (corrected):** check-runs is on the REST
  **core** budget (5000/hr), not the Search **secondary** limit (30/min) that constrains
  the section queries — and the detector already caches by `(ref, headSha)`, so
  steady-state cost is changed-heads-only. Probing all inbox PRs per tick is affordable;
  the earlier objection conflated the two budgets.
- **Inert/disabled `Review` facet reserved for #259:** ships a dead, non-functional
  control (confusing, untestable affordance, dead chrome). Dropped — #259 adds a working
  Review facet when its payload lands; until then the axis simply does not exist in the UI.
- **`State` (open/merged/closed) facet:** near-redundant and misleading — the four
  relationship sections are all `is:open`, so `merged`/`closed` can only ever surface the
  repo-capped, window-bounded `recently-closed` subset, which the section toggle already
  governs. Dropped to keep the bar lean; revisit only if a real need appears.
- **Expose a dedup toggle (#225 literal ask):** after `ci-failing` leaves, one sensible
  pair remains; a Settings control for it is low value. Leave hardcoded-on, document,
  close #225's thread as working-as-intended.
- **Saved/sticky filters:** filters are momentary triage; only the sort *default* persists.
- **Renaming the `awaiting-author` section id:** churns state.json keys, SSE
  `changedSectionIds`, and tests for a display-only fix. Label-only change instead.

## Deferrals / follow-ups

- **#259** review-state / draft payload → adds a **working** Review facet (and a draft
  filter) when it lands. Not reserved in the UI before then.
- **#264** `CiStatus.Passing` → adds the `passing` value to the CI facet (and a
  green per-row dot state).
- **#219** repo-grouping on/off toggle — separate, orthogonal.
- **#225** — close its conceptual thread here (dedup is visible-by-design via this spec;
  no toggle shipped).

## Resolved decisions (owner-confirmed)

- **CI approach → Option A (server-side probe + fault-isolation + `ciProbeComplete`).**
  Owner-confirmed 2026-06-08 over the pay-when-used fallback. The pay-every-tick cost is
  accepted because it delivers the core #262 goal (failing across *all* relationships) and
  fixes the per-row dot; the round-2 failure modes (whole-snapshot discard on `429`, silent
  filter under-match) are neutralized by fault-isolation + the incomplete hint rather than
  by reverting.
- **Section ordering stays in this slice.** Removing `ci-failing` reshapes the
  section-materialization path whose order is Dictionary-enumeration-fragile; pinning it is
  adjacent and cheap. Not split to a separate issue.
- **Decompose into PRs → yes** (see Implementation decomposition).
