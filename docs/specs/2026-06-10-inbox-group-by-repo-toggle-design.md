# Inbox group-by-repo toggle (#219)

**Issue:** [#219](https://github.com/prpande/PRism/issues/219) — Settings toggle to turn Inbox repo-grouping on/off (flat-list fallback)
**Tier:** T2 — Light. **Risk:** gated B1 (UI-visual; `needs-design` label). Visual gate fires at green-and-ready.
**Date:** 2026-06-10

## Problem

[#133](https://github.com/prpande/PRism/issues/133) grouped Inbox PRs by repository (nested accordions) within every section, shipping **default-on**. Some users prefer the old flat list — there is currently no way to turn grouping off. This slice adds a Settings toggle that switches the Inbox between **grouped-by-repo** (default) and **flat** rendering.

## Scope

**In:** a single Bool preference `inbox.groupByRepo` (default `true`) and its Settings control, gating the one existing `groupByRepo()` call site in `InboxSection.tsx`.

**Out:** the deferred #133 recently-closed **window** control. That is an `int` field; exposing it requires a net-new `ConfigFieldType.Int` in `ConfigStore.PatchAsync`'s allowlist (the prior deferral's still-unmet trigger), plus bounds-checking design. It stays a separate deferred item — the two are only superficially paired ("both live in Inbox Settings"). Owner decision 2026-06-10: just the toggle.

## Approach: mirror the `showActivityRail` (#283) Bool exactly

`inbox.showActivityRail` is a Bool inbox preference that already threads through every layer this toggle needs. `inbox.groupByRepo` mirrors it one-for-one, then adds a single frontend render gate. `ConfigStore.PatchAsync` already supports `ConfigFieldType.Bool` — **no new field type**.

### Backend (4 files)

1. **`PRism.Core/Config/AppConfig.cs`** — append `bool GroupByRepo = true` as the **trailing, defaulted** parameter of `InboxConfig` (immediately after `bool ShowActivityRail = false`). The `= true` default lives on the C# constructor parameter; `System.Text.Json` honors it when the JSON key is absent. `AppConfig.Default`'s positional `new InboxConfig(true, new InboxSectionsConfig(...), true, 14)` construction stays valid (the remaining params fall to their defaults). A trailing param does not reorder existing on-disk JSON → no migration.

2. **`PRism.Core/Config/ConfigStore.cs`** — two additions, both mirroring the `inbox.showActivityRail` lines:
   - Allowlist: `["inbox.groupByRepo"] = ConfigFieldType.Bool,`
   - Write arm: `"inbox.groupByRepo" => _current with { Inbox = _current.Inbox with { GroupByRepo = (bool)value! } },`

3. **`PRism.Web/Endpoints/PreferencesDtos.cs`** — add a `GroupByRepo` (bool) field to `InboxPreferencesDto`, positioned to match the DTO's existing parameter convention (alongside `ShowActivityRail`).

4. **`PRism.Web/Endpoints/PreferencesEndpoints.cs`** — in `BuildResponse`, pass `config.Current.Inbox.GroupByRepo` into the `InboxPreferencesDto` construction.

### Frontend (4 files)

5. **`frontend/src/api/types.ts`** — add `groupByRepo: boolean` to the inbox preferences type (the shape backing `preferences.inbox`), matching where `showActivityRail` lives.

6. **`frontend/src/components/Settings/panes/InboxPane.tsx`** — a `Switch` at the **foot of the pane, immediately after the "Show activity rail" row** (sibling inbox-wide display toggle):
   - `id="inbox-group-by-repo"`, label **"Group by repository"**
   - `checked={preferences.inbox.groupByRepo}`
   - `onChange={(next) => set('inbox.groupByRepo', next).catch(() => {})}`
   - A short help line, e.g. "Off shows a flat PR list in every section."

7. **`frontend/src/pages/InboxPage.tsx`** — read `preferences?.inbox.groupByRepo ?? true` (lenient `?.` read, mirroring how `sectionOrder` / `showActivityRail` are consumed) and pass it as a new `groupByRepo` prop to every `InboxSection`.

8. **`frontend/src/components/Inbox/InboxSection.tsx`** — accept a new prop `groupByRepo = true` (defaulted `true` so existing callers/tests that omit it keep today's behavior). Replace the render gate:
   - Today: `groups.length <= 1 ? <flat rows> : <accordions>`
   - New: `const grouped = groupByRepo && groups.length > 1;` then `grouped ? <accordions> : <flat rows>`

   The `groupByRepo(section.items)` call, the single-repo flatten, `RecentlyClosedFooter`, the empty-copy path, and the `forceOpen`/filter/`userToggled` section-header logic are all **untouched** — the toggle only swaps accordion-vs-flat inside the already-open section body.

## Behavioral notes

- **Recently-closed when off renders flat over #133's data, not a literal pre-#133 revert.** #133 changed the recently-closed *backend* to a repo cap (`MaxHistoryRepos = 20`) instead of a PR cap (`MaxHistoryRows = 30`). The toggle is a **frontend rendering** switch: when off, recently-closed shows flat `InboxRow`s over whatever PRs the backend sent (≤20 repos' worth), ungrouped. It does **not** (and should not) reshape the backend feed — a display preference reshaping server data would be a scope leak. This is the correct, intended behavior.
- **Lenient read everywhere.** Both the `InboxSection` prop default (`= true`) and the `InboxPage` read (`?? true`) default to grouped, so a missing preference (legacy config, mid-load `preferences === null`) renders today's default-on behavior rather than flickering flat.
- **Apply timing.** Like other inbox prefs, the change applies on the next inbox render/refresh; the pane's existing "Changes apply on the next inbox refresh" help already covers this. No new poll/refetch.

## Testing (test-first)

**Backend (xUnit):**
- `ConfigStore.PatchAsync` accepts `inbox.groupByRepo` `true`/`false`; rejects a non-bool value (type error) — mirror existing `inbox.showActivityRail` patch tests.
- **Backward-compat:** a legacy `AppConfig` JSON lacking the `group-by-repo` key, round-tripped through `JsonSerializerOptionsFactory.Storage` (so `KebabCaseJsonNamingPolicy` is exercised), deserializes `GroupByRepo == true`. Mirror `…WithoutRecentlyClosed_DefaultsToTrue`.
- `PreferencesEndpoints`: GET surfaces `groupByRepo`; POST `{ "inbox.groupByRepo": false }` round-trips and the follow-up GET reflects it.

**Frontend (vitest):**
- `InboxSection`: with a multi-repo section, `groupByRepo={false}` renders flat `InboxRow`s and **no** `RepoGroupAccordion`; `groupByRepo={true}` renders accordions. Single-repo section stays flat regardless (existing behavior).
- `InboxPane`: the "Group by repository" switch renders, reflects `preferences.inbox.groupByRepo`, and calls `set('inbox.groupByRepo', <next>)` on toggle.

**Visual (B1):** screenshot the Inbox grouped (default) vs. toggled-off flat, and the Settings pane with the new control, for the owner's eyeball-assert at green-and-ready.

## Acceptance criteria

- [ ] `inbox.groupByRepo` Bool preference exists end-to-end (config record → ConfigStore allowlist+write → DTO → endpoint → frontend type), default `true`.
- [ ] Legacy config without the key defaults to `true` (round-trip test green).
- [ ] "Group by repository" switch appears at the foot of the Inbox Settings pane and toggles the preference.
- [ ] Inbox renders nested repo accordions when on, flat `InboxRow` lists in every section when off.
- [ ] Existing section-level accordion / filter / recently-closed-footer behavior preserved.

## Out of scope / follow-ups

- #133 recently-closed window control (blocked on `ConfigFieldType.Int`).
- No e2e spec added: vitest + the B1 visual assert cover the rendering switch; the existing inbox e2e suite is not extended for a display toggle (revisit only if the toggle proves regression-prone).
