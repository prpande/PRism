# Default the activity rail ON (#439)

**Status:** spec (T2, B1-gated). Source issue: [#439](https://github.com/prpande/PRism/issues/439).

## Problem

`inbox.showActivityRail` previously defaulted to **false** (prior to #439), so the activity
rail — which since #137 renders **real** GitHub activity (`received_events` + notifications +
watching via `useActivity()`) — was hidden out of the box. Most users never discovered a
working, useful surface. Defaulting it ON puts it in front of early testers, who can still
turn it off in Settings. Same shape as #283 (AI preview defaulted on).

## Decision

Flip the single backend default the whole stack reads from:
`PRism.Core/Config/AppConfig.cs` → `InboxConfig.ShowActivityRail` **`false → true`**.

`PreferencesEndpoints` and `InboxPreferencesDto` already pass `config.Current.Inbox.ShowActivityRail`
straight through — there is no second backend default to flip. The DTO param has no
default value; it is always constructed from config.

**Preservation semantics (verified empirically — corrected from an earlier draft).**
`ShowActivityRail`'s default lives on the **constructor parameter** (`bool ShowActivityRail = true`),
and `AppConfig.Default` constructs `InboxConfig` without passing it. STJ on .NET 10 **honors
the constructor-parameter default** for a missing JSON key, so:
- A config that explicitly persisted `show-activity-rail: false` **keeps false** (the on-disk
  value wins).
- A config whose `inbox` block is present but **lacks** the `show-activity-rail` key **inherits
  the new default `true`** — it gets the rail on. This is the accepted #283-style "predates-the-key
  inherits-the-new-default" edge, and here it is *desirable* (more existing testers discover the
  rail). It is now pinned by a regression test (`LoadAsync_with_inbox_present_but_showActivityRail_key_absent`).

This differs mechanically from #283's `AiPreview`, whose default lives in the `AppConfig.Default`
factory (the constructor param is required, no default), so a present-`ui`-missing-`aiPreview`
config gets `default(bool)=false`. The constructor-default-vs-factory-default distinction is the
reason the two flags behave differently for the missing-key case — verified, not assumed.

Narrow windows (`< INBOX_RAIL_MIN_WIDTH = 1180px`) stay single-column regardless (#300 viewport
gate), and below that width `useActivity()` never mounts, so no background fetch fires.

## Scope

### Production
- `AppConfig.cs:54` — `bool ShowActivityRail = false` → `true`; update the trailing
  comment (it says "default OFF").
- `frontend/src/pages/InboxPage.tsx:38` — replace the stale comment calling the rail
  "a fabricated, non-AI mockup" (false since #137 wired it to real `/api/activity` data).
  The render-time fallback `?? false` at line 44 **stays** — it is the pre-preferences-load
  state, not the default; keeping it false avoids a rail flash-then-hide for opted-out
  users (preferences resolve quickly from the local backend).

### Backend contract tests (assert the new default)
- `tests/PRism.Core.Tests/Config/ConfigStoreTests.cs:22` and `:239` — `BeFalse()` → `BeTrue()` + comments.
- **New** `ConfigStoreTests.LoadAsync_with_inbox_present_but_showActivityRail_key_absent` — pins the
  missing-key-inherits-`true` behavior described under Preservation semantics (the #283-analog
  regression test this spec adds, since the existing round-trip test doesn't exercise a missing key).
- `tests/PRism.Web.Tests/Endpoints/PreferencesEndpointsTests.cs:44` — `BeFalse()` → `BeTrue()` + comment.
- `PreferencesEndpointsTests.cs:181–205` — the GET-defaults-false/POST-round-trips test.
  With the default now `true`, its `POST true` no longer exercises a state change. **Rework**
  it: assert initial `true`, POST **`false`**, assert `false`, GET `false` — so the round-trip
  still proves a real write+read in the meaningful direction. Rename accordingly.

### Frontend unit-test defaults
- `frontend/src/pages/InboxPage.test.tsx:100` (`setHooks` helper `?? false`) and `:397`
  (second-describe `beforeEach` baseline) → `true`, to mirror the new product default.
  **Safe:** the rail also requires `mockViewportWide(true)`; no test combines a wide
  viewport with an un-overridden rail default, and every rail-off test already passes an
  explicit `false`. The rail-on/off behavior tests are unaffected.
- `InboxPage.activityGate.test.tsx` — `showRailRef.value` (default `false`) is set
  explicitly by **both** tests (off at L58, on at L69); there is no un-overridden default
  to flip. No change beyond a clarifying note.

### E2e harness — deliberately keep the rail pinned OFF (see Rejected alternatives)
The e2e suite already forces the rail off in two places, independent of the config default:
- `frontend/e2e/fixtures/preferences.ts` `makeDefaultPreferences().inbox.showActivityRail = false`
  (mock-mode specs mock `/api/preferences` with this — insulated from the config flip).
- `frontend/e2e/helpers/s4-setup.ts` `resetBackendState` POSTs `{ 'inbox.showActivityRail': false }`
  (real-backend specs force it off per test — also insulated).

**Keep both forcing `false`; update their comments** to record that #439 flipped the
**product** default to true while the harness pins the rail off for these specs. The reason
is **redundancy/hygiene, not flakiness**: in e2e the rail is fed by `FakeActivityProvider`
(a deterministic fixed feed — the dedicated `inbox-activity-rail.png` baseline already
screenshots it stably), so a rail-inclusive default baseline would not be flaky — it would
just duplicate that coverage and add rail noise to specs (PR-detail, settings, AI-gating)
that aren't testing it. Same hygiene `resetBackendState` already applies to `aiPreview`/`contentScale`.

**Coverage is not lost.** After the flip, the two real user states are both covered:
`inbox-activity-rail.png` (rail on) is pixel-identical to what a fresh wide-window user now
sees by default, and `inbox.png` (rail off) covers the opted-out wide user. Consequence:
**no inbox/PR-detail visual baselines change**, so none need regeneration — not because the
default is untested, but because its appearance is already locked by the dedicated rail baseline.

## Acceptance criteria
- [ ] Fresh install (no `config.json`) → `GET /api/preferences` returns `inbox.showActivityRail: true`
      (asserted by `PreferencesEndpointsTests` / `ConfigStoreTests`); rail renders on windows ≥ 1180px.
- [ ] An existing config with an explicit `show-activity-rail: false` keeps false; a config with an
      `inbox` block but no `show-activity-rail` key inherits the new default `true` (the verified,
      now-regression-tested behavior under Preservation semantics).
- [ ] Narrow windows stay single-column with no `useActivity()` fetch (unchanged #300 gate).
- [ ] The stale "fabricated mockup" comment is corrected.
- [ ] Backend + frontend suites green; no e2e baseline regen required (harness pins rail off; rail-on
      appearance already covered by `inbox-activity-rail.png`).

## B1 visual gate (owner)
UI-visible default change → pause at green-and-ready for the owner's eyeball-assert. Concrete
checklist (run on a ≥ 1180px window with no existing `config.json`):
1. The fresh inbox renders **two-column with the rail visible** in its settled state.
2. During cold load, the rail column shows its own loading skeleton rather than appearing blank.
   **Known minor transition:** `showRail` uses the `?? false` pre-load fallback, so the cold-load
   skeleton renders single-column for one frame before preferences resolve, then settles to
   two-column — a brief width shift, not a content flash. Confirm it isn't jarring at local speed.
3. Resize below 1180px → rail disappears (single-column), no errors.
4. The Settings → Inbox "Show activity rail" toggle still reflects/writes the value.

**Transparency at the gate:** the issue lists "regenerate inbox visual baselines" as in-scope,
but **no baselines changed** — the harness pins the rail off for the shared specs and the rail-on
appearance is already locked by `inbox-activity-rail.png` (see E2e harness section). If the owner
would instead prefer the canonical `inbox.png` to *be* the rail-on default (retiring the
now-equivalent `inbox-activity-rail.png`), that's a small follow-up — surfaced, not silently decided.

## Consideration (owner sign-off, not a blocker)
Rail-on means `useActivity()` fans out to **three** GitHub endpoints (received_events,
notifications, watching) — but **not per inbox load**. `ActivityProvider` is a process-wide
singleton with a 60s TTL cache, and `useActivity` polls every 90s, so inbox loads / remounts /
multiple tabs all hit the same cached entry. Effective upstream cost is at most **one 3-call
fan-out per ~60s per PRism process** (one process per single-user desktop install) — ~3.6% of the
5,000/hr authenticated budget at steady state, only while a wide inbox tab is open. The mitigation
(server-side dedup/TTL) already shipped with #137; nothing is deferred here. The fan-out floor is
3 but timeline enrichment adds bounded per-PR reads scaled by notification volume, still behind
the same 60s cache. Clearly acceptable for the dogfooding stage; the min-width gate suppresses it
on narrow windows and the toggle remains.

## Rejected alternatives
- **Flip `makeDefaultPreferences` / drop the `resetBackendState` pin so the new default flows
  into e2e baselines.** Rejected for **redundancy**, not flakiness: the e2e rail is deterministic
  (`FakeActivityProvider`), so a rail-inclusive `inbox.png` would not be flaky — it would just
  converge with the existing `inbox-activity-rail.png` and add rail noise to specs that aren't
  testing it. The shared baseline deliberately pins the rail off and tests it in one dedicated
  spec — the same hygiene `resetBackendState` already applies to `aiPreview`/`contentScale`. If
  the owner wants the canonical baseline to mirror the rail-on default, that is a separate
  follow-up (make the `inbox` parity test enable the rail, retire the redundant `inbox-activity-rail`).
- **Flip the `InboxPage.tsx:44` `?? false` render fallback to `?? true`.** Rejected: it governs
  the pre-load frame, not the default; `?? true` would flash a rail then hide it for users who
  opted out.
