# Settings redesign — modal shell, master-detail, polished controls

- **Issue:** [#134](https://github.com/prpande/PRism/issues/134) — *Redesign the Settings page — currently bland, low visual hierarchy*
- **Date:** 2026-06-06
- **Tier / Risk:** T3 · gated **B1 (UI-visual)** — see triage comment on #134
- **Status:** Design (awaiting human spec review) · revised after 2× `ce-doc-review`

## 1. Problem

Today's Settings is a flat vertical stack of four `--surface-1` cards
(`Appearance`, `Inbox sections`, `Connection`, `Auth`) in a 720px centered
column (`frontend/src/pages/SettingsPage.tsx`). It is functional but bland: no
hierarchy beyond the card boxes, native `<select>`/checkbox widgets that render
OS-themed, and a lopsided layout (Auth is a single link; Connection mixes the
over-the-wire host with local file paths). The taxonomy is also incoherent —
`Connection` holds the GitHub host *and* local `config.json`/logs paths, two
unrelated concepts.

## 2. Goals / non-goals

**Goals**
1. Reframe Settings as a **large dismissible modal** opened from the Header,
   preserving the user's underlying context (mid-review, inbox position).
2. Give it a **master-detail** structure (sidebar nav + detail pane) with real
   visual hierarchy.
3. Fix the **taxonomy**: host belongs with the token (over-the-wire identity);
   local file paths become their own quiet diagnostics entry.
4. Replace native widgets with **polished, accessible custom controls**
   (segmented controls, accent swatches, styled switches) per the tool-wide
   design principle.
5. Preserve **every existing control's behavior and persistence byte-for-byte**.
6. **Keep deep-linkable section routes** so other surfaces can open Settings on a
   specific pane. The **named near-term consumer** is a redirect to an upcoming
   **AI-connection settings** pane. *That pane is built in a later slice* — this
   work establishes the route shape and the deep-link mechanism so the consumer
   has a stable entry point to target.

**Non-goals (deferred, by owner decision)**
- Font-size control ([#135](https://github.com/prpande/PRism/issues/135)).
- Moving the Setup/token flow into Settings (first-run epic
  [#216](https://github.com/prpande/PRism/issues/216)).
- The dedicated **AI-connection settings pane** itself — only its route shape is
  anticipated (Goal 6). AI preview stays in Appearance until that pane exists.
- `Cmd+,` keyboard shortcut to open Settings — follow-up.

## 3. Key decisions & rationale

### 3.1 Container: modal, not page
A modal preserves context for a *visit-briefly-and-return* surface and matches
desktop-app convention (PRism is Electron desktop-first). The app has modal
*patterns* to follow (`Modal`, `HostChangeModal`, `ErrorModal`, `Cheatsheet`
overlay) with focus management.

**Reuse caveat:** the existing `Modal` component
(`frontend/src/components/Modal/Modal.tsx`) renders a fixed title + single
`modal-body` slot and is **not** shaped for a sidebar + detail layout.
`SettingsModal` is therefore a **new shell** that reuses the modal *behavioral
contract* (`role="dialog"`, `aria-modal`, ESC/backdrop close, focus-trap, focus
restore) — it does **not** wrap or extend `Modal`. `Modal.tsx` is the reference
to port from. (Refactoring `Modal` to accept an arbitrary layout slot is out of
scope.)

*Rejected:* full page (status quo); full-screen overlay (heavier than needed).

### 3.2 Layout: master-detail (sidebar + detail pane)
Owner-selected over a polished single column and a bento grid. The four sections
have very different weights; a sidebar gives a stable structure and room to grow.

### 3.3 Taxonomy: four sections, two groups
The sidebar has a **primary group** and a divided-off **"System" group**:

| Nav item | Group | Contents | Maps from today |
|----------|-------|----------|-----------------|
| **Appearance** | primary | theme, accent, density, AI preview | `AppearanceSection` |
| **Inbox** | primary | the six section toggles | `InboxSectionsSection` |
| **GitHub Connection** | primary | Replace-token affordance **+** read-only host | `AuthSection` + host from `ConnectionSection` |
| **Files & logs** | System | `config.json` path + logs path (copy-to-clipboard) | rest of `ConnectionSection` |

The **System group is visually de-emphasized** ("quiet"): separated by a
horizontal divider, an uppercase `--text-3` group label, and inactive item text
at `--text-2` — grouped apart but never grayed-out or hidden.

Rationale: host is tied to the token (it scopes what the token authenticates
against) → over-the-wire identity. `config.json`/logs paths are local artifacts →
demoted to a quiet diagnostics entry. Sections stay **separate** (not merged)
because AI settings and Inbox behavior changes are queued and each grows
independently. *Rejected:* a merged "Account & connection" pane.

### 3.4 Routing: routed sections via background-location
Routes go from a single `/settings` to `/settings/:section`
(`appearance` | `inbox` | `github-connection` | `system`), rendered as a **modal
over a background location** (the **react-router v7** —
`react-router-dom ^7` — `location.state.backgroundLocation` pattern; this pattern
is net-new to this codebase, written from the v7 docs, not copied from an in-repo
example):

- The Header gear `Link` carries `state={{ backgroundLocation: currentLocation }}`.
  Two route trees render: a **primary `<Routes>`** against the *effective
  background* (below) — which keeps **Inbox / Setup** mounted behind the scrim —
  plus a **modal-only `<Routes>`** matching `/settings/*` against the live
  location. *(The PR view is **not** rendered by the primary `<Routes>`: the
  `/pr/*` route element is `null`; the PR view is kept visible solely by
  `PrTabHost` resolving against the effective background — see §3.4a. Do not rely
  on the primary `<Routes>` to keep the PR visible.)*
- **Background synthesis (owner: `App.tsx`).** App computes the effective
  background once via `useMemo`:
  `location.state?.backgroundLocation ?? (isSettingsPath ? { pathname: '/' } : location)`.
  This both feeds the primary `<Routes>` and is exposed to chrome via
  `useEffectiveLocation()` (§3.4a). The synthesized `{ pathname: '/' }` covers a
  cold deep-link (no `backgroundLocation` state), so Inbox sits behind the scrim
  rather than the primary `<Routes>` also matching `/settings/*` and rendering
  nothing.
- **Close** (✕ / ESC / backdrop): when `backgroundLocation` exists, navigate to
  it; when it does **not** (cold deep-link / reload-while-open), navigate to `/` —
  never `navigate(-1)`.
- `/settings` (no section) redirects to `/settings/appearance` (preserving any
  `backgroundLocation` state through the redirect).
- **Auth guard:** the guard lives on the **parent `/settings` route element**
  (so child `/settings/:section` matches are gated before they evaluate), reusing
  the same `isAuthed` predicate as `/` and `/pr/*`; an unauthenticated cold
  deep-link redirects to `/setup` synchronously (modal does not flash), preserving
  the #130 first-run gate. The intended section is **not** preserved through the
  auth redirect (the user lands on Inbox after Setup) — acceptable because the
  AI-connection consumer constructs deep-links from within an already-authed
  session.

*Rejected:* plain `useState` for the active section — drops deep-linking, which
Goal 6 requires for the AI-connection consumer.

### 3.4a Keep-alive interaction — the load-bearing unit
This protects the keep-alive experience (sub-tab + scroll preservation) that
ranks above routing convenience.

**Why it's at risk.** Several components are mounted *outside* `<Routes>` and read
the **live** pathname; when the modal flips the live URL to `/settings/*` they
misbehave. The core case: `PrTabHost`
(`frontend/src/components/PrDetail/PrTabHost.tsx`) renders one permanently-mounted
`PrDetailView` per open tab (from `OpenTabsContext`, so **nothing unmounts** — all
state survives), and the live pathname only sets which is `active`
(`PrDetailView.tsx:37`). `PrDetailView` runs reactivation-freshness logic on the
`active` **false→true** transition (`PrDetailView.tsx:111-117`,
`useActivationTransition`) — re-GET + scroll/marker teardown. If `active` flips
when the modal opens/closes *or when navigating between panes*, that refetch
re-fires, which is exactly open bug
[#180](https://github.com/prpande/PRism/issues/180) (Files-tab scroll/selection
reset).

**The fix — one shared resolver + propagated state.**
1. A shared hook **`useEffectiveLocation()`** returns
   `location.state?.backgroundLocation ?? (isSettingsPath ? SYNTHETIC_INBOX : location)`.
   This is the single source of truth for "what app location is really in view,"
   and it is the only audit point a future fifth consumer needs.
2. **Intra-modal navigation must preserve `backgroundLocation`.** Because
   `location.state` is per-history-entry, plain `<Link to="/settings/system">`
   between panes would drop it. A **`SettingsLink`** wrapper (used by `SettingsNav`
   and the `/settings`→`/settings/appearance` redirect) reads the current
   `backgroundLocation` and re-applies it on every intra-modal navigation, so the
   effective background stays `/pr/...` for the whole modal session — `active`
   never flips, across open, **pane-to-pane navigation**, and close.

**Audit of outside-`<Routes>` consumers (result recorded — these four exist
today; all switch from raw `useLocation().pathname` to `useEffectiveLocation()`):**

| Consumer (App.tsx) | Today reads | Without fix | Treatment |
|---|---|---|---|
| `PrTabHost` (:114) | live pathname → `active` view | PR view deactivates → #180 refetch | **Required:** resolve `active` from effective location → stays `active=true`; dimmed PR visible behind scrim |
| `AskAiDrawer`/`DrawerEffects` (:117-118) | `parsePrRefFromPathname(pathname)` → force-close drawer | open Ask-AI drawer **force-closes** the moment Settings opens (context-loss regression) | **Required:** resolve PR ref from effective location → drawer stays open |
| `PrTabStrip` (:94) | `isActiveTab(location.pathname)` | active PR tab chip de-highlights | **Required:** resolve from effective location |
| `useTabUnreadSignal` (:119) | `activeKeyFromPathname` | SSE `pr-updated` for the backgrounded PR marked spuriously unread | **Required:** resolve from effective location |

**Modal placement.** `SettingsModal` renders via a portal **above**
`data-app-shell`, never inside `[data-app-scroll]`, so it cannot perturb the PR
view's shared scroll container.

### 3.5 Controls: polished custom widgets
Native `<select>` (theme, density) → **`SegmentedControl`** (`radiogroup`,
roving-tabindex, `aria-checked`; arrow keys **wrap** first↔last per the ARIA
radiogroup pattern). Accent radios → **`AccentSwatches`** (`radiogroup` of color
swatches). The existing `role="switch"` checkboxes (AI preview, inbox toggles) →
**`Switch`** (styled restyle, same role). Extracted as reusable primitives in
`frontend/src/components/controls/` per the standing "polished controls
everywhere" principle.

**Accent palette.** The swatch set is the existing three accents — `indigo`,
`amber`, `teal` (`AppearanceSection.tsx` `ACCENTS`). If a persisted accent value
is not in the set (out-of-band config edit), the UI **displays** the first swatch
(`indigo`) as selected but does **not** mutate the stored value; the next user
click overwrites it. Mirrors the existing density-normalization defensive
pattern. No "custom color" option in scope.

**Interaction states (all three primitives):** `selected`, `unselected`,
`hover-unselected`, `focus-visible` (the app accent ring), `disabled`.
Backgrounds/borders from the `--surface-*`/`--border-*` ladder; the
`SegmentedControl` filled-selected segment mirrors the existing tab-chip filled
treatment (PR #167 Option B) so the controls read as part of the same system.

### 3.6 Modal shell — sizing, scroll, motion
- **Desktop size:** `width min(880px, 92vw)`, `height min(560px, 86vh)`;
  **min-width `360px`**.
- **Scroll contract:** the **detail pane** scrolls independently
  (`overflow-y: auto`); the **sidebar is fixed**; the modal does not scroll as a
  whole.
- **Animation (supports Goal 1 — desktop-app feel):** entrance
  `opacity: 0→1` + `transform: scale(0.96)→scale(1)` over `--t-med` (150ms) with
  `--ease-out` (both already defined in `tokens.css`); exit reverses. Under
  `prefers-reduced-motion: reduce`, opacity-only, no scale, effectively instant.
  This is a new transition (existing modals have none to inherit).

## 4. Component architecture

```
App  (computes effective background via useMemo; provides useEffectiveLocation)
└─ primary <Routes>  (against effective background)        ← inbox / setup
│                                                            (/pr route = null)
└─ chrome mounted OUTSIDE <Routes>, all reading useEffectiveLocation():
│     PrTabHost (sole PR renderer) · PrTabStrip · AskAiDrawer/DrawerEffects · TabSignals
└─ SettingsModalRoutes  (modal-only <Routes> for /settings/*, live location)
   └─ SettingsModal               ← NEW shell (portal above data-app-shell): scrim,
      │                             focus-trap, ESC/backdrop close, sized box, animation
      ├─ modal header (title + ✕)
      └─ SettingsLayout            ← master-detail
         ├─ SettingsNav            ← sidebar (SettingsLink items); primary + divided System groups
         └─ <Outlet/>              ← AppearancePane | InboxPane | GitHubConnectionPane | SystemPane
```

Shared (new): `frontend/src/components/controls/` (`SegmentedControl`, `Switch`,
`AccentSwatches`, each + `.module.css` + test); `useEffectiveLocation` hook;
`SettingsLink` wrapper.

The four panes reuse the **exact** hooks/handlers from today's section components
(`usePreferences`, `useToast`, `useSubmitInFlight`, the optimistic apply +
rollback). Only markup/widgets change.

**Focus model reconciliation.** The dialog Tab focus-trap (modelled on
`Modal.tsx:70-89`) and the controls' roving-tabindex coexist: unselected
segments/swatches carry `tabindex=-1`, so each `radiogroup` is a single tab stop;
arrow keys move selection within it.

### Header change
The Settings `<Link>` tab becomes a **gear icon button** in the Header utility
area — a react-router `Link` styled as an icon button so it carries
`state={{ backgroundLocation }}` (inline SVG per `diffIcons.tsx`). It is **always
rendered when authed** (not only as a trigger); its active styling
(`aria-current`/active class) is driven by whether a `/settings/*` modal is open
(true on a cold deep-link too). Inbox stays a tab; the `/setup?replace=1`
active-state special-case is preserved.

**Existing-test migration (required).** `header.test.tsx` asserts a Settings
*link* with `aria-current="page"` across several paths; those assertions migrate
to the gear element/semantics, with "gear active" defined for (a) modal open,
(b) full-page `/setup?replace=1`, (c) cold deep-link.

## 5. Behavior-preservation contract

Identical wire behavior — this is a presentation change.

| Control | Preserved behavior |
|---------|--------------------|
| Theme / Accent / Density | optimistic `applyThemeToDocument`/`applyDensityToDocument` + `set(key)`; rollback + re-apply prior value + error toast on failure (current `AppearanceSection` logic verbatim) |
| AI preview | `set('aiPreview')` then `refetchCapabilities()`; rollback/toast on failure |
| Inbox toggles (×6) | `set('inbox.sections.<id>')`; "applies on next refresh" help text + `aria-describedby` retained |
| Host | read-only display of `preferences.github.host` |
| config.json / logs paths | read-only field + copy-to-clipboard with success/error toast. **"Verbatim" = the existing `ConnectionSection` copy handlers + field markup are reused inside the SystemPane wrapper, not re-invented.** Any pre-existing gap (e.g. `navigator.clipboard` permission-denied beyond the existing error branch) is inherited as-is, out of scope. Toasts render via the app-root `ToastProvider` (a sibling of the modal portal), so portal placement doesn't affect them. |
| Replace token | `Link` to `/setup?replace=1`; in-flight-submit guard (`useSubmitInFlight` → `aria-disabled` + tooltip + `preventDefault`) preserved exactly. |

**Replace-token return path (accepted tradeoff).** Clicking `Replace token` leaves
the modal for the full-page `/setup?replace=1` flow; on completion/cancel the user
lands on Inbox (`/`), prior modal/background context **not** restored. The one
Settings action whose context isn't preserved — stated explicitly rather than
implying full preservation. (Restoring it would entangle with #216.)

## 6. Accessibility

- `SettingsModal`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the
  title; focus trap; **backdrop close fires only when pointer-down *and*
  pointer-up land on the scrim** (clicks originating inside the box are no-ops,
  matching `Modal.tsx`); ESC closes.
- **Focus restore on close:** to the gear when it was the trigger; on a cold
  deep-link (no trigger) focus moves to the background's main-content landmark
  (the Inbox heading), never bare `document.body`.
- `SettingsNav`: a labelled `<nav>`; active item `aria-current="page"`, left
  accent border + `--surface-2` fill (tab-chip pattern), hover `--surface-3`,
  focus-visible accent ring, inactive text `--text-2`; **nav items are never
  disabled** — pane load failures surface inline in the pane, not on the nav.
- `SegmentedControl`/`AccentSwatches`: `radiogroup`, roving-tabindex (wrapping),
  `aria-checked`, `fieldset`/`legend` (or `aria-labelledby`) group label.
- **Horizontal nav (responsive, §7) is nav-mode, not control-mode:** it mirrors
  the segmented *styling* but uses `aria-current` + `<nav>` semantics (not
  `aria-checked`/`radiogroup`). It is a distinct presentation of `SettingsNav`,
  not the `SegmentedControl` primitive repurposed.
- `Switch`: `role="switch"` + `aria-checked`; `htmlFor`/`id` label association.
- Each pane keeps an `aria-labelledby` heading.

## 7. Responsive

- **≥720px (modal interior):** sidebar (≈200px) + detail pane.
- **<720px:** modal expands toward full-viewport (capped `95vh`); `SettingsNav`
  collapses to a **horizontal nav bar** (nav-mode per §6) above a full-width pane,
  items ≥44px touch targets, horizontal **scroll-snap** (no wrapping); the active
  chip auto-scrolls into view on open. At the `360px` floor the nav scrolls rather
  than overflows.
- Desktop (Electron) primary; this is secondary.

## 8. Testing strategy

- **Control primitives** (vitest + RTL): renders, reflects value, emits change,
  arrow-nav with **wrap**, `aria-*`, plus `disabled` + `focus-visible` states.
- **Panes** (vitest): renders controls, writes the correct preference key, rolls
  back + toasts on a mocked POST failure (port existing section-component
  assertions).
- **Routing** (vitest): `/settings` → `/settings/appearance`; nav click swaps
  pane + `aria-current`; cold deep-link renders over synthesized Inbox; close →
  background; cold-link close → `/`; unauth cold deep-link → `/setup`.
- **Keep-alive (must-test, §3.4a):** open Settings over `/pr/o/r/123`, then
  **navigate appearance→system→appearance**, then close — assert across the whole
  sequence that the `PrDetailView` stays mounted **and `active`** and the
  reactivation refetch **never fires**; scroll/sub-tab intact. Assert the Ask-AI
  drawer, if open, **stays open** while the modal is open; assert `PrTabStrip`
  keeps the PR tab highlighted; assert no spurious unread on a backgrounded
  `pr-updated`.
- **Focus** (vitest): the dialog trap treats each `radiogroup` as a single tab
  stop (arrow-nav still works inside).
- **Header** (vitest): gear renders/active when authed, carries
  `backgroundLocation`, hidden first-run/rejected-token; migrate prior
  link/`aria-current` assertions.
- **Existing-test migration:** retarget `settings-flow.spec.ts` (four-headings →
  per-pane; copy-path → `/settings/system`; theme/toggle → the right pane) and the
  replace-token specs (`goto('/settings/github-connection')`).
- **Playwright (B1 gate):** modal screenshots — Appearance + GitHub Connection,
  light + dark — **and** one `<720px` collapsed-nav screenshot.

## 9. Risk re-check note

Classified **B1** (visual). The GitHub Connection pane re-renders the existing
read-only host and the existing Replace-token link only.

**Pre-PR re-check checklist** (`issue-resolution-workflow.md` step 7) — the diff
must show:
1. No changes to `useSubmitInFlight`, `useAuth`, or token-storage hooks.
2. `/settings/*` covered by the existing `isAuthed` guard (parent route element).
3. No new API calls originating from the panes.
4. The four outside-`<Routes>` consumers' only change is switching to
   `useEffectiveLocation()`; no change to tab open/close, SSE, or drawer logic
   beyond pathname resolution.

Violation of (1)–(3) → re-classify **B2** and route to the human approach gate.

**Accepted exposure (local-first PoC).** `SystemPane` copies local file paths to
the clipboard (verbatim from today). The path reveals the OS username and
credential-store location — an accepted, documented exposure for a local-first
single-user tool, not a regression. No code change.

## 10. Open questions

Resolved during brainstorming + 2× review. Deferred by explicit decision
(§2 non-goals): font-size (#135), Setup-into-Settings (#216), the dedicated
AI-connection pane (its route shape is anticipated here; the pane ships in a later
slice), and `Cmd+,`.
