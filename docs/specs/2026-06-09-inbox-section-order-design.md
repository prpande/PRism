# Inbox: user-customizable section order (#275)

## Problem

The inbox renders its sections in a single fixed, server-defined order. `/api/inbox`
serializes sections in the canonical `SectionOrder` constant
(`InboxEndpoints.cs:21`: `review-requested → awaiting-author → authored-by-me →
mentioned → recently-closed`), and the frontend renders them verbatim —
`InboxPage.tsx:103` does `visibleSections.map(...)` over whatever order the API
returns. There is no way for a user to change it.

Different users prioritize differently: someone who lives in their review queue
wants `review-requested` on top (the current default suits them); a prolific author
wants `authored-by-me` first; someone who works off pings wants `mentioned` up top.
Today everyone is forced into one ordering. The section order should be a user
preference so the inbox matches how each person actually works.

**Honest scope note.** PRism is a single-user local app, so the archetypes above are
really one person's varying modes, not a population. Two affordances already ship on
this exact surface: per-section **on/off** switches (`InboxPane.tsx`) and **accordion
collapse** on every section header. Those already cover the dominant "this section is
irrelevant to me" case — you disable or collapse it. Reorder earns its place only on
the *residual* case they don't touch: when you want two or more sections **visible**
but in a **different relative priority** than canonical (e.g. an author who reviews
*and* authors but wants their own PRs first). That residual case is the justification;
"hide what I don't want" is already solved and is not what this builds.

This is **ordering/personalization only** — distinct from #262 (the taxonomy itself,
now shipped), #263 (filters — which PRs show, absorbed into #262), and #219 (the
repo-grouping toggle — a within-section layout choice).

## Goal

Let the user reorder the inbox's work sections from Settings → Inbox, persist the
chosen order through the standard preferences pipeline (`config.json`), and apply it
at render time — without ever silently dropping a section, and with a one-click
restore-default.

## Scope decisions (resolved in brainstorming)

These four decisions were settled with the owner before this doc and are the spine
of the design:

1. **Mechanism: a Settings list with move-up/move-down buttons.** Not in-place
   drag-to-reorder on the inbox headers. The inbox section header is already a
   click-to-collapse accordion control; layering drag-vs-click disambiguation,
   keyboard-reorder a11y, touch, and drop indicators onto that contended element is
   high-cost and risky. The Settings → Inbox pane (`InboxPane.tsx`) already renders
   exactly these sections as a row list with on/off switches and the default-sort
   select; reorder controls slot in beside them, are keyboard-accessible by
   construction, and are trivially testable. Drag-and-drop is a deferred future
   enhancement, not part of this slice.

2. **`recently-closed` is pinned to the bottom, outside the reorderable set.** It is
   not a work queue — it is separately sourced, `defaultOpen={false}`, and
   semantically an archive. The reorderable set is the **four work sections**
   (`review-requested`, `awaiting-author`, `authored-by-me`, `mentioned`).
   `recently-closed` always renders last, regardless of the saved order. Reordering
   an archive above live work is a footgun with no real use case.

3. **Storage: a delimited-string preference key in `config.json`, not a JSON array.**
   The order persists as `inbox.sectionOrder` — a comma-delimited string of the four
   work-section ids (e.g. `"mentioned,review-requested,authored-by-me,awaiting-author"`).
   This drops into the **existing scalar patch pipeline with no protocol change**:
   `PreferencesEndpoints` already coerces a single JSON-string patch value, and
   `ConfigStore.PatchAsync` already validates `String`-typed keys. The shape is
   byte-for-byte the same as the `inbox.defaultSort` string key shipped in #262. The
   rejected alternative — a real JSON array (`["mentioned", ...]`) — would have forced
   a `StringArray` field type into the patch protocol, an array-coercion arm in
   `PreferencesEndpoints`, and an array path through the frontend `readKey`/`writeKey`.
   That protocol surgery is not justified for a single four-element list preference;
   see **Rejected alternatives**.

4. **Frontend owns the reordering; the backend only persists.** The backend never
   reorders anything — `/api/inbox` keeps emitting canonical order. The saved
   `sectionOrder` string is applied as a sort at render time in the frontend
   (`InboxPage`), exactly where the `.map` already lives. The backend's role is the
   same passive persistence it already provides for theme, density, default-sort, and
   the section on/off toggles.

## Architecture

Five units, each with one responsibility:

```
config.json                          PreferencesEndpoints / ConfigStore
  inbox.sectionOrder: "a,b,c,d"  ──►  (existing scalar String pipeline; +1 allowlist
        ▲                              entry, +1 InboxConfig field, +1 DTO field,
        │ POST {inbox.sectionOrder}    +1 validation rule)
        │
  PreferencesContext (set/readKey/writeKey)   ── string key, no new machinery
        ▲                                   │
        │ usePreferences()                  │ preferences.inbox.sectionOrder
        │                                   ▼
  InboxPane (Settings)                 InboxPage
   reorder rows + up/down + reset       sortSectionsByOrder(sections, savedOrder)
   (writes the string)                  before .map  (the only render change)
                                              │
                                              ▼
                                         orderInboxSections() — pure, tested unit
```

### Unit 1 — `InboxConfig.SectionOrder` (backend config model)

`AppConfig.cs`: `InboxConfig` gains a `string SectionOrder` field, defaulting to the
canonical work-section order `"review-requested,awaiting-author,authored-by-me,mentioned"`.
It serializes/deserializes as a plain string with no special handling. For older
`config.json` files that lack the key, a missing constructor parameter deserializes
to the record's **default value** via System.Text.Json — the same mechanism that
backfills `DefaultSort = "updated"` from #262 — so old files load with the canonical
order, no migration code needed. (This is distinct from `ReadFromDiskAsync`'s
null-guard path, which backfills whole null *sub-records*, not individual missing
scalar fields.)

Note the wire/disk key split, consistent with `DefaultSort`: the **patch/wire** key is
`inbox.sectionOrder` (camelCase), while the **on-disk** key under the Storage naming
policy is `inbox.section-order` (kebab). The implementer should not assume they match
— this mirrors the existing `inbox.defaultSort` ↔ on-disk `default-sort` split.

`recently-closed` is **not** part of this string — it is pinned in the frontend, so
keeping it out of the persisted order keeps the model to the four reorderable ids.

**Single source of truth for the canonical four-id list.** The ordered id list
appears at two layers — the backend default string (here, the backend SSOT) and the
frontend (used by both the lenient render-time fallback and the restore-default
button). To prevent drift, the **frontend** canonical order is defined **once** as an
exported constant in `sectionOrder.ts` (below) and imported by every frontend consumer
— no second literal in `InboxPane`. Backend and frontend each hold exactly one copy.

### Unit 2 — patch allowlist + validation (`ConfigStore.cs`)

Add `["inbox.sectionOrder"] = ConfigFieldType.String` to `_allowedFields`. Add a
closed-set validation block mirroring the existing `inbox.defaultSort` /
`_allowedSorts` check: the value must be a comma-delimited list whose elements are a
**permutation of the four known work-section ids** — each id is in the known set, no
duplicates, no unknown ids, and all four present. An invalid value throws
`ConfigPatchException` → the endpoint returns `400` rather than persisting an order
the frontend can't render coherently.

Rationale for requiring the full permutation (not a partial list) **at the write
boundary**: the only writer is our own reorder UI, which always emits a full
4-element permutation. Rejecting partial/garbage writes keeps `config.json` clean.
The *render-time* path (Unit 5) is separately tolerant of partial/unknown/stale
input so that a hand-edited or version-skewed file never drops a section — write is
strict, read is lenient.

### Unit 3 — preferences wire shape (`PreferencesDtos.cs`, `PreferencesEndpoints.cs`)

`InboxPreferencesDto` gains a `string SectionOrder` field (serializes as
`sectionOrder` under the camelCase policy — no `[JsonPropertyName]` needed).
`BuildResponse` populates it from `config.Current.Inbox.SectionOrder`. No change to
the POST value-coercion switch — the value is a JSON string, already handled.

**Frontend type-union trap (`PreferencesContext.tsx`).** Adding `inbox.sectionOrder`
to the `PreferenceKey` union is not enough. `InboxSectionKey` is derived as
`Exclude<PreferenceKey, ...>`, and `readKey`/`writeKey` fall through to an
`inbox.sections.<id>` *slice* path for any key not handled by an explicit arm. If
`inbox.sectionOrder` is added to the union but **not** added to the `Exclude` list and
**not** given its own early-return arm in both `readKey` and `writeKey`, it routes
through the slice logic (`writeKey` line ~76: `key.slice('inbox.sections.'.length)`)
and corrupts the write. So the change is three coordinated edits: (1) add to the
`PreferenceKey` union, (2) add to the `Exclude<...>` list that forms `InboxSectionKey`,
(3) add explicit string arms in `readKey` and `writeKey`. A unit test asserting
`set('inbox.sectionOrder', "...")` does **not** touch `inbox.sections.*` guards this.

### Unit 4 — `InboxPane` reorder UI (`InboxPane.tsx`)

The four work-section rows gain **Move up / Move down** buttons (top row's up and
bottom row's down disabled). `recently-closed` renders as a pinned, non-reorderable
bottom row. A **Restore default order** button writes the canonical order.

The displayed row order is derived from `preferences.inbox.sectionOrder` (run through
the same lenient `orderInboxSections` helper as the inbox, over the four work ids) so
Settings and inbox never disagree. The pane holds **no independent row-order state** —
it is purely derived from preferences, so an in-flight POST that later rolls back can
never leave Settings showing an order the server didn't accept.

**The in-flight race (apply-on-success, not optimistic).** `PreferencesContext.set`
is **not** optimistic: `setPreferences(next)` runs only *after* the POST resolves (the
"optimistic" wording in its comments refers to the key-scoped *rollback* on failure,
not a forward apply). For idempotent toggles that is invisible, but reorder moves are
**order-dependent**: each move computes its next permutation from
`preferences.inbox.sectionOrder`, which does not update until the round-trip
completes. Two quick Move-up clicks would both read the same pre-move order and the
second move would be lost. **Resolution: disable all reorder controls (every move
button + restore-default) while any `inbox.sectionOrder` `set()` promise is pending,
re-enabling on settle.** This serializes moves, makes each one compute from a settled
order, and is the simplest correct guard given the apply-on-success model. (Making
`set` globally optimistic is out of scope — it would touch every preference control.)

**Restore-default state.** The restore-default button is **disabled when the current
order already equals the canonical default** (computable from the same derived state),
so clicking it never fires a no-op POST + misleading success toast.

**`recently-closed` pinned treatment.** It renders as the last row with its on/off
switch intact but **no move buttons** — in their place, a static muted "Pinned" tag
(reusing existing pane typography, no new component) so the absence of controls reads
as intentional, not broken. It is never part of the reorderable set.

**On/off is independent of order.** A work section's on/off switch and its position
are orthogonal. `inbox.sectionOrder` **always carries all four work ids** regardless
of which are toggled off; a disabled section keeps its move buttons and its saved
slot, so re-enabling it returns it to that slot. (The inbox only renders enabled
sections, but the persisted order is complete, so no slot is ever lost.)

**Subtitle copy.** The pane subtitle (`InboxPane.tsx:34`, currently "Choose which
lists appear in your inbox") is updated to cover the new capability, e.g. "Choose
which inbox sections appear and in what order."

Each move computes the new full-permutation string and calls
`set('inbox.sectionOrder', next)` — the same apply-on-success/rollback/toast path
every other control in the pane uses. Buttons carry explicit `aria-label`s
(`Move {label} up` / `Move {label} down`), kept on the **disabled** boundary buttons
too (disabled, not hidden, so the label is still announced and the boundary is
discoverable); the reorder region is a labelled `role="group"`. Keyboard users operate
the buttons directly — the accessibility win that picking buttons over drag-and-drop
buys for free.

### Unit 5 — `orderInboxSections()` (pure render-time sort) + `InboxPage` wiring

A pure helper `orderInboxSections(sections, savedOrder)` (new file under
`components/Inbox/`, e.g. `sectionOrder.ts`), unit-tested in isolation. Contract:

- Parse `savedOrder` (the comma string) into an id list; ignore empties/whitespace.
- Stable-sort the input `sections` by each id's index in the parsed order.
- Any section whose id is **not** in `savedOrder` sorts **after** the listed ones,
  in canonical `SectionOrder` order (mirrors the backend's `IndexOf < 0 → last`
  rule). A future new section is therefore appended, never dropped — acceptance
  criterion #3.
- A saved id that matches **no** live section is harmlessly ignored.
- `recently-closed` is **always** forced last, regardless of where it falls in the
  saved order or canonical order. This is the structural pin from scope decision 2.

`InboxPage` calls `orderInboxSections(visibleSections, preferences?.inbox.sectionOrder)`
immediately before the `.map`. When preferences haven't loaded yet (`undefined`), the
helper falls back to canonical order (same as today), so cold-load is unchanged.

The helper consumes `visibleSections` (post-filter), so reorder composes cleanly with
the #262 filter bar — filtering narrows the set, the saved order arranges whatever
remains.

## Data flow

1. User clicks **Move up** on `authored-by-me` in Settings → Inbox.
2. `InboxPane` computes the new permutation string, **disables all reorder controls**,
   and calls
   `set('inbox.sectionOrder', "review-requested,authored-by-me,awaiting-author,mentioned")`.
3. `PreferencesContext.set` POSTs the single-field patch and `ConfigStore.PatchAsync`
   validates the permutation and writes `config.json`. (`set` applies the new snapshot
   on **success**, not before — it is apply-on-success, not optimistic; the controls
   stay disabled until it settles, which serializes order-dependent moves.)
4. On success the server echoes the full preferences snapshot and the controls
   re-enable; on failure the key is rolled back, an error toast shows, and the controls
   re-enable (existing machinery, unchanged).
5. The inbox, reading the same `preferences.inbox.sectionOrder`, re-runs
   `orderInboxSections` and re-renders the sections in the new order. `recently-closed`
   stays pinned at the bottom throughout.

## Error handling

- **Invalid write** (non-permutation, unknown id, dup, wrong length): rejected at
  `ConfigStore` with `ConfigPatchException` → `400`; the frontend's existing
  rollback + "Couldn't save preference" toast fires. The UI never emits such a value,
  so this path is a guard against hand-edited POSTs / future bugs.
- **Corrupt / partial / stale on-disk value** (hand-edited `config.json`): the
  render-time helper is lenient — partial orders append the rest canonically, unknown
  ids are ignored, an empty/malformed string falls back to full canonical order. No
  section is ever dropped. The strict-write/lenient-read split is deliberate. A
  lingering bad on-disk value (e.g. an explicit empty string that STJ does not
  default-backfill) is harmless — it renders as canonical and is overwritten by the
  next move or restore-default.
- **Preferences not yet loaded**: `orderInboxSections(sections, undefined)` returns
  canonical order — identical to today's cold-load behavior.

## Testing

**Backend (`PRism.Web.Tests`, `PRism.Core.Tests`):**
- `ConfigStore.PatchAsync` accepts a valid 4-id permutation and persists it.
- Rejects: an unknown id, a duplicate, a 3-element (incomplete) list, a 5-element
  list, an empty string, and a non-string value — each a `ConfigPatchException`.
- `ReadFromDiskAsync` backfills `SectionOrder` to the canonical default when the key
  is absent from an older `config.json`.
- `GET /api/preferences` includes `inbox.sectionOrder`; round-trips a POST.

**Frontend (`vitest`):**
- `orderInboxSections` unit tests: full permutation reorders; unknown/new id appends
  canonically; stale saved id ignored; `recently-closed` forced last even if listed
  first; empty/`undefined` → canonical; filter-narrowed subset preserves saved order.
- `InboxPane`: move-up/down buttons reorder rows and call `set` with the right string;
  top-up/bottom-down disabled; `recently-closed` has no move buttons; restore-default
  writes canonical and is **disabled when already at the default**; `aria-label`s
  present on disabled boundary buttons; reorder controls are **disabled while a move
  POST is in flight** (two rapid Move-up clicks must not lose the second move — assert
  the pending move serializes); a section toggled off keeps its slot in the persisted
  order (re-enabling restores its position).
- `PreferencesContext`: `set('inbox.sectionOrder', "...")` round-trips via the
  `readKey`/`writeKey` string arms and does **not** touch any `inbox.sections.*` value
  (guards the `Exclude`/slice-fallthrough trap).
- `InboxPage`: sections render in the saved order; `recently-closed` last.

**e2e (`Playwright`):** reorder in Settings, return to inbox, assert section order;
reload, assert persisted (B1 visual proof of the reordered inbox + the Settings pane).

## Scope / non-goals

- **In:** reorder the 4 work sections via Settings buttons; persist as
  `inbox.sectionOrder` string in `config.json`; lenient render-time sort; restore
  default; `recently-closed` pinned.
- **Out (deferred / not this slice):** in-place drag-to-reorder on the inbox headers;
  making `recently-closed` reorderable; per-section custom labels; reordering across
  the filter/sort axis; any change to `/api/inbox`'s emitted order.

## Rejected alternatives

- **JSON-array preference (`inbox.sectionOrder: [...]`).** The "correct" model on the
  wire, but it forces a `StringArray` field type into `ConfigStore`'s scalar-only
  patch protocol, an array-coercion arm in `PreferencesEndpoints`, and an array path
  through `readKey`/`writeKey`. ~3 layers of protocol surgery for one four-element
  list. The delimited string reuses the entire existing scalar pipeline (proven by
  `inbox.defaultSort` two weeks prior) for ~30 lines total. If a second list-shaped
  preference ever appears, promoting to a real array is a localized follow-up — YAGNI
  says don't pay for it now.
- **localStorage (frontend-only persistence).** Zero backend code, and reordering is
  arguably a pure view concern. Rejected because it would be the *only* setting not in
  `config.json`: every sibling control in the same Settings → Inbox pane persists
  through `usePreferences()`, PRism surfaces `configPath` for hand-editing, and the
  issue's own acceptance criterion says "per the standard preferences pipeline." For a
  single local-desktop user the cross-device benefit of a server store is moot, but
  the single-source-of-truth and consistency benefit is real and the string encoding
  makes config.json storage nearly as cheap.
- **In-place drag-to-reorder.** See scope decision 1 — accordion/drag interaction
  conflict and a11y/touch cost, deferred.
- **Making `recently-closed` reorderable.** See scope decision 2 — no use case for an
  archive above live work; fights `defaultOpen={false}`.

## Files touched

- `PRism.Core/Config/AppConfig.cs` — `InboxConfig.SectionOrder` field + default.
- `PRism.Core/Config/ConfigStore.cs` — allowlist entry + permutation validation.
- `PRism.Web/Endpoints/PreferencesDtos.cs` — `InboxPreferencesDto.SectionOrder`.
- `PRism.Web/Endpoints/PreferencesEndpoints.cs` — populate the new DTO field.
- `frontend/src/api/types.ts` — `InboxPreferences.sectionOrder` type.
- `frontend/src/contexts/PreferencesContext.tsx` — `inbox.sectionOrder` in the
  `PreferenceKey` union + `readKey`/`writeKey` string arms.
- `frontend/src/components/Inbox/sectionOrder.ts` — new pure `orderInboxSections`.
- `frontend/src/pages/InboxPage.tsx` — apply the sort before `.map`.
- `frontend/src/components/Settings/panes/InboxPane.tsx` — reorder rows + buttons +
  restore-default.
- Tests alongside each, per the Testing section.

## Acceptance criteria (from #275)

- [x] A user can change the order in which inbox categories appear. *(Unit 4 + 5)*
- [x] The chosen order persists across reloads and sessions, per the standard
  preferences pipeline. *(Units 1–3, `config.json`)*
- [x] Sections not present in the saved order still render — none silently dropped.
  *(Unit 5 lenient sort)*
- [x] A way to restore the default order exists. *(Unit 4 restore-default button)*
