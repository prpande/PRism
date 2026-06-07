# Inbox categorization rethink + fast filter/sort (#262, absorbs #263)

> **Revision note (post ce-doc-review, 2026-06-07).** The CI axis moved from an
> on-demand lazy-probe endpoint (brainstorm "CI-3") to a **server-side probe over
> all inbox PRs during refresh**. The review surfaced that the lazy-probe design
> deadlocked (failing PRs in filter-emptied/collapsed sections could never be
> probed) and shifted the trust boundary to client-supplied repo coordinates. The
> server-side approach dissolves both and fixes the per-row CI dot's authored-only
> scope as a side effect. See **Rejected alternatives** for the full reasoning. The
> `State` and inert `Review` facets were also dropped (see Scope).

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
   `changedSectionIds`, tests); only the **display label** changes (backend
   `SectionLabels` map + `InboxPane` row label + empty-copy string). The label is
   deliberately **causally neutral** — "Needs re-review" holds for any PR whose head
   advanced past your last review, regardless of *who* pushed (the filter keys on SHA
   inequality, not author attribution, so "the author responded" would be an
   over-claim).
3. **`recently-closed` stays a section** (history mode, distinct data source).

### CI probing moves server-side (the key change)

During each refresh, the orchestrator probes CI for **all inbox section PRs**, not just
the authored superset, by feeding the full distinct PR set to the existing
`ICiFailingDetector`. Because the detector already caches by `(ref, headSha)`, runs on
the REST core budget (5000/hr, separate from the Search secondary limit), is capped at
8 concurrent, and degrades gracefully on 403/429/404, the marginal cost is bounded:
cold-start probes ≈ inbox size; steady state re-probes only PRs whose head changed.

Consequences:
- `PrInboxItem.ci` is populated for **every** section, so the per-row CI dot is correct
  everywhere (fixes a latent authored-only limitation), and the CI **filter is a pure
  client-side predicate over the snapshot** — instant, no endpoint, no "checking" state,
  no deadlock.
- The detector's `DetectAsync` parameter is renamed from `authoredItems` to a neutral
  `items` (the logic is already scope-agnostic — it probes per-ref). The orchestrator's
  CI fan-out runs over `sectionsAsItems` (distinct by ref) instead of only
  `authored-by-me`. `ResolveVisibleSections`' "force authored when ci-failing enabled"
  hack is removed (ci-failing is gone).
- **`recently-closed` is excluded from CI probing** — CI is a live-PR concept; closed
  PRs get `ci == none` and the CI facet does not apply to that section.
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
  - **CI** (first position) — `failing | pending`. Pure client-side over the
    now-fully-populated `ci` field.
  - **Repo** — owner/repo values present in the snapshot.
  - **Author** — author logins present in the snapshot.
  Each facet is a **checkbox popover**; the trigger shows the facet name when nothing is
  selected and a count when ≥1 is selected (e.g. "Repo (2)"). Repo/Author popovers
  include an inline type-to-filter when their value list is long.
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
A pinning test asserts the order regardless of build order. The frontend ignores any
unknown section id (forward-compat against a version-skewed backend still emitting
`ci-failing`).

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
- `PreferencesContext.tsx` — `inbox.defaultSort` read/write branch.
- `api/types.ts` — `defaultSort` preference + `PreferenceKey` member.

**Backend (changed):**
- `InboxRefreshOrchestrator` — stop materializing `ci-failing`; run the CI detector over
  **all** distinct section PRs (excluding `recently-closed`) so `ci` populates
  everywhere; drop the `ci-failing` branch from `ResolveVisibleSections`.
- `GitHubCiFailingDetector` / `ICiFailingDetector` — rename `authoredItems` → `items`
  (scope-agnostic; no behavioural change beyond input set).
- `InboxDeduplicator` — drop the `ci-failing > authored-by-me` pair.
- `InboxSectionsConfig` — remove `CiFailing` (6 → 5 fields) + migration test.
- `SectionLabels` — "Needs re-review" for `awaiting-author`.
- Canonical `SectionOrder` + ordering step at the `/api/inbox` serializer + pinning test.
- `AppConfig`/`InboxConfig` `DefaultSort` + `ConfigStore` allowlist arm + DTO + value
  validation.

## Testing strategy (TDD)

- **`applyInboxFilters`** (pure): free-text title/repo match; CI/Repo/Author facets;
  AND-across / OR-within; sort comparators incl. tie-break; empties hidden when
  filtering, shown when not; all-match-nothing → zero-state, not `EmptyAllSections`.
- **`useInboxFilters`**: facet-value derivation; clear resets all incl. free-text.
- **Orchestrator**: `ci-failing` section absent; `ci` populated for review-requested /
  mentioned PRs (not just authored); `recently-closed` left `none`; dedup no longer
  references `ci-failing`.
- **Detector**: probing a mixed (authored + non-authored) set populates CI for all;
  cache hit by `(ref, headSha)` skips re-probe; degraded results uncached (existing
  contract preserved under the renamed param).
- **Ordering**: serialized `sections[]` follows `SectionOrder` regardless of build order;
  unknown section id ignored by the frontend.
- **Config migration**: old `config.json` with `ciFailing` loads clean; round-trips
  without the key.
- **`inbox.defaultSort`**: read/write routes to the scalar branch (not
  `sections['defaultSort']`); invalid value rejected by `PatchAsync`; Settings select
  persists and re-hydrates.
- **Settings**: five section rows; "Needs re-review" label; `PasteUrlInput` still present.
- **e2e (B1)**: filter bar narrows live; CI facet filters failing across sections;
  emptied sections hide; all-match-nothing shows the zero-state; sort reorders within
  sections; `PasteUrlInput` coexists; light + dark.

## Design decisions deferred to the plan (implementation-level)

These are real decisions but belong in `writing-plans`, not this spec; flagged so they
are not forgotten: exact keyboard model for the facet popovers (open/close/arrow/Esc,
focus return) and `aria-live` wording for the summary line (follow existing PRism
control patterns); the design-token surface level for the toolbar + active-facet
highlight (mirror the existing toolbar/Settings tokens); debounce leading-edge vs
trailing; and the precise two-row vs one-row toolbar layout that keeps `PasteUrlInput`
and the filter controls uncramped. Desktop/Electron is the primary target, so narrow-
viewport responsive behaviour is out of scope.

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

## Open questions

- **CI probe cost owner-confirm:** widening CI probing to all inbox PRs per refresh is
  affordable on the REST budget with the existing head-SHA cache, but it does shift from
  pay-when-used to pay-every-tick (justified because it also fixes the per-row dot). If
  the owner prefers pay-when-used, the fallback is the (more complex) fixed CI-3 with the
  four mitigations above. Recommendation: server-side probe.
