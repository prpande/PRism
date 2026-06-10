# Inbox group-by-repo toggle (#219)

**Issue:** [#219](https://github.com/prpande/PRism/issues/219) — Settings toggle to turn Inbox repo-grouping on/off (flat-list fallback)
**Tier:** T2 — Light. **Risk:** gated B1 (UI-visual; `needs-design` label). Visual gate fires at green-and-ready.
**Date:** 2026-06-10

## Problem

[#133](https://github.com/prpande/PRism/issues/133) grouped Inbox PRs by repository (nested accordions) within every section, shipping **default-on**. Some users prefer the old flat list — there is currently no way to turn grouping off. This slice adds a Settings toggle that switches the Inbox between **grouped-by-repo** (default) and **flat** rendering.

## Scope

**In:** a single Bool preference `inbox.groupByRepo` (default `true`) and its Settings control, gating the one existing `groupByRepo()` call site in `InboxSection.tsx`.

**Out:** the deferred #133 recently-closed **window** control. That is an `int` field; exposing it requires a net-new `ConfigFieldType.Int` in `ConfigStore.PatchAsync`'s allowlist (the prior deferral's still-unmet trigger), plus bounds-checking design. It stays a separate deferred item — the two are only superficially paired ("both live in Inbox Settings"), and the window control is **not a blocker** for #219 (the two preferences are orthogonal: the window reshapes the backend feed via `QueryClosedHistoryAsync`, this toggle is a pure frontend render switch). Owner decision 2026-06-10: just the toggle.

## Approach: mirror the `showActivityRail` (#283) Bool exactly

`inbox.showActivityRail` is a Bool inbox preference that already threads through every layer this toggle needs. `inbox.groupByRepo` mirrors it one-for-one, then adds a single frontend render gate. `ConfigStore.PatchAsync` already supports `ConfigFieldType.Bool` — **no new field type**.

### Backend (4 files)

1. **`PRism.Core/Config/AppConfig.cs`** — add `bool GroupByRepo = true` as the **new final parameter** of `InboxConfig`, placed on the line *after* the current last parameter `bool ShowActivityRail = false` (so `GroupByRepo` becomes the trailing param; `ShowActivityRail` keeps its position). The `= true` default lives on the C# constructor parameter; `System.Text.Json` honors it when the JSON key is absent. `AppConfig.Default`'s positional `new InboxConfig(true, new InboxSectionsConfig(...), true, 14)` construction (4 positional args) **stays valid unchanged** — both `ShowActivityRail` and the new `GroupByRepo` fall to their parameter defaults. A trailing param does not reorder existing on-disk JSON → no migration. **Comment upkeep:** `ShowActivityRail`'s inline comment currently ends "Appended LAST so the positional `new InboxConfig(true, …, 14)` default construction stays valid." Since `ShowActivityRail` is no longer last, move that trailing-default rationale onto `GroupByRepo` (or reword to "appended as trailing defaulted params") so the comment doesn't misstate which param is last.

2. **`PRism.Core/Config/ConfigStore.cs`** — two additions, both mirroring the `inbox.showActivityRail` lines:
   - Allowlist: `["inbox.groupByRepo"] = ConfigFieldType.Bool,`
   - Write arm: `"inbox.groupByRepo" => _current with { Inbox = _current.Inbox with { GroupByRepo = (bool)value! } },`

3. **`PRism.Web/Endpoints/PreferencesDtos.cs`** — add a `GroupByRepo` (bool) field to `InboxPreferencesDto`, positioned to match the DTO's existing parameter convention (alongside `ShowActivityRail`).

4. **`PRism.Web/Endpoints/PreferencesEndpoints.cs`** — in `BuildResponse`, pass `config.Current.Inbox.GroupByRepo` into the `InboxPreferencesDto` construction.

### Frontend (5 files)

> The `showActivityRail` mirror is **5** frontend files, not 4: besides the type/pane/page/section below, the key threads through `PreferencesContext.tsx`, where the `PreferenceKey` union, the `InboxSectionKey` `Exclude<>` list, `readKey`, and `writeKey` live. Two of those edits are compile-blocking — omitting them was the spec's most important gap (caught by feasibility review).

5. **`frontend/src/api/types.ts`** — add `groupByRepo: boolean` to the inbox preferences interface (the shape backing `preferences.inbox`), matching where `showActivityRail` lives. *(This makes `groupByRepo` a required field — see Testing for the existing fixtures that must gain it or `tsc -b` fails.)*

6. **`frontend/src/contexts/PreferencesContext.tsx`** — mirror the four `inbox.showActivityRail` touch-points (each a one-liner beside the existing `showActivityRail` arm):
   - **`PreferenceKey` union** — add `| 'inbox.groupByRepo'`. *(Compile-blocking: without it, `set('inbox.groupByRepo', …)` in InboxPane fails `tsc`.)*
   - **`InboxSectionKey = Exclude<PreferenceKey, …>`** — add `'inbox.groupByRepo'` to the excluded list. *(Compile-blocking / correctness: without it, `writeKey`'s fallback slices the key as an `inbox.sections.*` id and corrupts the snapshot.)*
   - **`readKey`** — add `if (key === 'inbox.groupByRepo') return prefs.inbox.groupByRepo;`
   - **`writeKey`** — add `if (key === 'inbox.groupByRepo') return { ...prefs, inbox: { ...prefs.inbox, groupByRepo: value as boolean } };`

7. **`frontend/src/components/Settings/panes/InboxPane.tsx`** — a `Switch` at the **foot of the pane, immediately after the "Show activity rail" row**, mirroring that row's exact DOM structure (`<Switch …/>` → `<div className={pane.spring} />` → help `<span>`):
   - `id="inbox-group-by-repo"`, label **"Group by repository"**
   - `checked={preferences.inbox.groupByRepo}`
   - `onChange={(next) => set('inbox.groupByRepo', next).catch(() => {})}`
   - `describedById="inbox-group-by-repo-help"`, with a help `<span id="inbox-group-by-repo-help" className={pane.help}>` carrying copy like "Off shows a flat PR list in every section." **Do not** reuse the section-level `HELP_ID` (it carries the apply-timing note for the order controls — wrong context for AT users on this switch).

8. **`frontend/src/pages/InboxPage.tsx`** — read `preferences?.inbox.groupByRepo ?? true` (lenient `?.` read, mirroring how `sectionOrder` / `showActivityRail` are consumed) and pass it as a new `groupByRepo` prop to every `InboxSection`.

9. **`frontend/src/components/Inbox/InboxSection.tsx`** — accept a new prop `groupByRepo = true` (defaulted `true` so existing callers/tests that omit it keep today's behavior). Replace the render gate:
   - Today: `groups.length <= 1 ? <flat rows> : <accordions>`
   - New: `const grouped = groupByRepo && groups.length > 1;` then `grouped ? <accordions> : <flat rows>`

   The flat path is the **existing** `section.items.map(pr => <InboxRow … />)` branch reused verbatim — it passes neither `showRepo` (so InboxRow's `showRepo` default of `true` keeps the repo name visible on each flat row, including multi-repo) nor `grouped` (so flat rows render at root indent, same as today's single-repo flatten). The `groupByRepo(section.items)` call, `RecentlyClosedFooter`, the empty-copy path, and the `forceOpen`/filter/`userToggled` section-header logic are all **untouched** — the toggle only swaps accordion-vs-flat inside the already-open section body.

## Behavioral notes

- **Recently-closed when off renders flat over #133's data, not a literal pre-#133 revert.** #133 changed the recently-closed *backend* to a repo cap (`MaxHistoryRepos = 20`) instead of a PR cap (`MaxHistoryRows = 30`). The toggle is a **frontend rendering** switch: when off, recently-closed shows flat `InboxRow`s over whatever PRs the backend sent (≤20 repos' worth), ungrouped. It does **not** (and should not) reshape the backend feed — a display preference reshaping server data would be a scope leak. Three consequences of "flat ≠ old flat list," all intended and acceptable:
  - **Order differs.** Grouped clusters PRs by repo (first-seen order); flat renders the backend's raw close-time-descending interleave. A user with interleaved cross-repo closes sees a *re-ordered* list, not merely a de-chromed one.
  - **Reveal differs.** Grouped recently-closed accordions start **collapsed** (`repoDefaultOpen = !isRecentlyClosed`); flat shows every row immediately. Toggling off instantly reveals all recently-closed rows.
  - **Cap differs.** The flat list inherits the 20-*repo* cap, so it can be longer than the old 30-row list and can omit a very-recent close belonging to the 21st+ repo. A future "a PR I just closed is missing from the flat list" report is anticipated, not a regression introduced here.
- **Per-repo accordion expand state is transient.** `RepoGroupAccordion` holds each repo's open/closed state in local `useState` seeded once from `defaultOpen`. Toggling grouping off unmounts the accordions; toggling back on remounts them at their `defaultOpen` baseline. Any per-repo collapse the user had set is lost on a round-trip. This is acceptable — no persistence of per-repo expand state is required, and the implementer should not try to preserve it across unmounts.
- **Lenient read everywhere.** Both the `InboxSection` prop default (`= true`) and the `InboxPage` read (`?? true`) default to grouped. For a **default (grouped) user** this means no flicker during mid-load (`preferences === null`). For a user who **saved `groupByRepo: false`**, there is a possible one-frame *grouped* flash if inbox `data` paints before `preferences` resolves, then it settles to flat — acceptable because `preferences` (single app-root GET, #143) normally resolves with or before inbox data; we do not gate the section render on it to avoid added latency.
- **Apply timing.** Like other inbox prefs, the change applies on the next inbox render/refresh; the pane's existing "Changes apply on the next inbox refresh" help already covers this. No new poll/refetch.

## Testing (test-first)

**Backend (xUnit):**
- `ConfigStore.PatchAsync` accepts `inbox.groupByRepo` `true`/`false`; rejects a non-bool value (type error) — mirror existing `inbox.showActivityRail` patch tests.
- **Backward-compat:** a legacy `AppConfig` JSON lacking the `group-by-repo` key, round-tripped through `JsonSerializerOptionsFactory.Storage` (so `KebabCaseJsonNamingPolicy` is exercised), deserializes `GroupByRepo == true`. Mirror `…WithoutRecentlyClosed_DefaultsToTrue`.
- `PreferencesEndpoints`: GET surfaces `groupByRepo`; POST `{ "inbox.groupByRepo": false }` round-trips and the follow-up GET reflects it.

**Frontend (vitest):**
- `InboxSection`: with a multi-repo section, `groupByRepo={false}` renders flat `InboxRow`s and **no** `RepoGroupAccordion`; `groupByRepo={true}` renders accordions. Single-repo section stays flat regardless (existing behavior). Assert a flat multi-repo row still shows its repo name (`showRepo` default holds).
- `InboxPane`: the "Group by repository" switch renders, reflects `preferences.inbox.groupByRepo`, and calls `set('inbox.groupByRepo', <next>)` on toggle.

**Fixture upkeep (do this first — `groupByRepo` is a required field).** Adding `groupByRepo: boolean` to the inbox prefs interface breaks every full-object preference fixture under `tsc -b` until each gains the key. Known sites: `frontend/src/components/AppearanceSync.test.tsx`, the `InboxPane.test.tsx` preference builder, and `frontend/e2e/fixtures/preferences.ts`. Grep the suite for `showActivityRail` to find them all, and **verify with `tsc -b` (not vitest/esbuild, which skip type-checking)** per the repo's known `tsc -b` gotcha.

**Visual (B1):** screenshot the Inbox grouped (default) vs. toggled-off flat — **including a multi-repo Recently-closed section in both states** so the owner eyeballs the order/reveal change — plus the Settings pane with the new control, for the owner's eyeball-assert at green-and-ready.

## Acceptance criteria

- [ ] `inbox.groupByRepo` Bool preference exists end-to-end (config record → ConfigStore allowlist+write → DTO → endpoint → frontend type), default `true`.
- [ ] Legacy config without the key defaults to `true` (round-trip test green).
- [ ] "Group by repository" switch appears at the foot of the Inbox Settings pane and toggles the preference.
- [ ] Inbox renders nested repo accordions when on, flat `InboxRow` lists in every section when off.
- [ ] Existing section-level accordion / filter / recently-closed-footer behavior preserved.

## Out of scope / follow-ups

- #133 recently-closed window control (blocked on `ConfigFieldType.Int`).
- No e2e spec added: vitest + the B1 visual assert cover the rendering switch; the existing inbox e2e suite is not extended for a display toggle (revisit only if the toggle proves regression-prone).
