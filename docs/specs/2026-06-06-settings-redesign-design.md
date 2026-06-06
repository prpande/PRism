# Settings redesign — modal shell, master-detail, polished controls

- **Issue:** [#134](https://github.com/prpande/PRism/issues/134) — *Redesign the Settings page — currently bland, low visual hierarchy*
- **Date:** 2026-06-06
- **Tier / Risk:** T3 · gated **B1 (UI-visual)** — see triage comment on #134
- **Status:** Design (awaiting human spec review)

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

**Non-goals (deferred, by owner decision)**
- Font-size control ([#135](https://github.com/prpande/PRism/issues/135)).
- Moving the Setup/token flow into Settings (first-run epic
  [#216](https://github.com/prpande/PRism/issues/216)).
- A dedicated AI settings section — AI preview stays in Appearance until that
  section exists (YAGNI).
- `Cmd+,` keyboard shortcut to open Settings — follow-up.

## 3. Key decisions & rationale

### 3.1 Container: modal, not page
A modal preserves context for a *visit-briefly-and-return* surface and matches
desktop-app convention (PRism is Electron desktop-first). The app already has
modal infrastructure (`Modal`, `HostChangeModal`, `ErrorModal`, `Cheatsheet`
overlay) with focus management. The redesigned content is **container-agnostic**
— it would drop into a page unchanged — so this is a low-risk framing choice.

*Rejected:* full page (status quo) — navigates away from context; *full-screen
overlay* (Discord-style) — heavier than needed, the dismissible centered modal
gives the same content-preservation with a lighter feel.

### 3.2 Layout: master-detail (sidebar + detail pane)
Owner-selected over a polished single column and a bento grid. The four sections
have very different weights; a sidebar gives a stable structure and room to grow.

### 3.3 Taxonomy: four sections, two groups
The sidebar has a **primary group** and a divided-off **quiet "System" group**:

| Nav item | Group | Contents | Maps from today |
|----------|-------|----------|-----------------|
| **Appearance** | primary | theme, accent, density, AI preview | `AppearanceSection` |
| **Inbox** | primary | the six section toggles | `InboxSectionsSection` |
| **GitHub Connection** | primary | Replace-token affordance **+** read-only host | `AuthSection` + host from `ConnectionSection` |
| **Files & logs** | System (quiet) | `config.json` path + logs path (copy-to-clipboard) | rest of `ConnectionSection` |

Rationale: host is tied to the token (it scopes what the token authenticates
against) → they form the over-the-wire identity. `config.json`/logs paths are
local artifacts → categorically different, demoted to a quiet diagnostics entry.
Sections are kept **separate** (not merged) because AI settings and Inbox
behavior changes are already queued and each section will grow independently.

*Rejected:* merging Auth+Connection into one "Account & connection" pane — a
broad heading would muddy as AI/account features land.

### 3.4 Routing: routed sections via background-location
Routes go from a single `/settings` to `/settings/:section`
(`appearance` | `inbox` | `github-connection` | `system`), rendered as a **modal
over a background location** (react-router v6 `location.state.backgroundLocation`
pattern):

- The Header gear `Link` carries `state={{ backgroundLocation: currentLocation }}`.
  The app renders the normal `<Routes>` against `backgroundLocation` (so the
  inbox/PR view stays mounted behind the scrim) **plus** a second modal-only
  `<Routes>` matching `/settings/*`.
- **Close** (✕ / ESC / backdrop) navigates back to the background route.
- A **cold deep-link** to `/settings/github-connection` (no `backgroundLocation`
  state) renders the modal over a **default Inbox background**.
- `/settings` (no section) redirects to `/settings/appearance`.

*Rejected:* plain `useState` for the active section — simpler, but drops
deep-linking (which the owner wants for forward-looking section links) and the
"close = back" affordance.

### 3.5 Controls: polished custom widgets
Native `<select>` (theme, density) → **`SegmentedControl`** (a `radiogroup` with
arrow-key navigation, `aria-checked`). Accent radios → **`AccentSwatches`**
(`radiogroup` of color swatches). The existing `role="switch"` checkboxes (AI
preview, inbox toggles) → **`Switch`** (a styled restyle, same role). These are
extracted as **reusable primitives** so the tool-wide "polished controls
everywhere" principle can reuse them.

## 4. Component architecture

```
App
└─ (background <Routes>)            ← inbox / pr / setup, unchanged
└─ SettingsModalRoutes             ← rendered when backgroundLocation set OR path is /settings/*
   └─ SettingsModal                ← Modal shell: scrim, focus-trap, ESC/backdrop close, sized box
      ├─ modal header (title + ✕)
      └─ SettingsLayout            ← master-detail
         ├─ SettingsNav            ← sidebar: primary group + divided System group; <Outlet/> target
         └─ <Outlet/>              ← one of:
            ├─ AppearancePane      ← reuses AppearanceSection logic
            ├─ InboxPane           ← reuses InboxSectionsSection logic
            ├─ GitHubConnectionPane← Auth (Replace token) + host
            └─ SystemPane          ← config.json + logs copy-path rows
```

Shared control primitives (new): `frontend/src/components/controls/`
- `SegmentedControl.tsx` (+ `.module.css`, test)
- `Switch.tsx` (+ `.module.css`, test)
- `AccentSwatches.tsx` (+ `.module.css`, test)

The four panes reuse the **exact** hooks and handlers from today's section
components (`usePreferences`, `useToast`, `useSubmitInFlight`, the optimistic
apply + rollback in `AppearancePane`). Only markup/widgets change.

### Header change
The Settings `<Link>` tab is replaced by a **gear icon button** in the Header
utility area (an inline SVG following `diffIcons.tsx` conventions). It links to
`/settings/appearance` with `backgroundLocation` state. `settingsActive`
highlight logic moves to the gear's `aria-pressed`/active styling. Inbox stays a
tab. The `/setup?replace=1` active-state special-case is preserved (the
Replace-token flow is still a full page).

## 5. Behavior-preservation contract

Every control keeps identical wire behavior — this is a presentation change.

| Control | Preserved behavior |
|---------|--------------------|
| Theme / Accent / Density | optimistic `applyThemeToDocument`/`applyDensityToDocument` + `set(key)`; on POST failure, rollback + re-apply prior value + error toast (current `AppearanceSection` logic verbatim) |
| AI preview | `set('aiPreview')` then `refetchCapabilities()`; rollback/toast on failure |
| Inbox section toggles (×6) | `set('inbox.sections.<id>')`; the "applies on next refresh" help text retained, `aria-describedby` kept |
| Host | read-only display of `preferences.github.host` |
| config.json / logs paths | read-only field + copy-to-clipboard with success/error toast (current `ConnectionSection` logic verbatim) |
| Replace token | `Link` to `/setup?replace=1`; the in-flight-submit guard (`useSubmitInFlight` → `aria-disabled` + tooltip + `preventDefault`) preserved exactly. Clicking it leaves the modal for the full-page Setup flow (intentional). |

## 6. Accessibility

- `SettingsModal`: `role="dialog"`, `aria-modal="true"`, `aria-labelledby` the
  modal title; focus trap; focus restored to the gear on close; ESC + backdrop
  close (mirrors existing `Modal`/`ErrorModal` patterns).
- `SettingsNav`: a labelled `<nav>`; the active section link carries
  `aria-current="page"`.
- `SegmentedControl`/`AccentSwatches`: `radiogroup` semantics, roving-tabindex
  arrow-key navigation, `aria-checked`, `fieldset`/`legend` (or
  `aria-labelledby`) for the group label.
- `Switch`: keeps `role="switch"` + `aria-checked`; label association via
  `htmlFor`/`id`.
- Each pane keeps an `aria-labelledby` heading.

## 7. Responsive

- ≥720px (modal interior): sidebar (≈200px) + detail pane.
- <720px: the modal grows toward full-viewport; the sidebar collapses to a
  horizontal segmented nav above a full-width pane. No functionality lost.
- Desktop (Electron) is the primary case; this is the secondary.

## 8. Testing strategy

- **Control primitives** (vitest + RTL): each renders, reflects value, emits
  change, keyboard arrow-nav (segmented/swatches) toggles selection, `aria-*`
  correct.
- **Panes** (vitest): each renders its controls, writes the correct preference
  key, and rolls back + toasts on a mocked POST failure (port existing
  section-component test assertions).
- **Routing** (vitest): `/settings` → redirect to `/settings/appearance`; nav
  click swaps pane + sets `aria-current`; cold deep-link renders modal over
  Inbox; close navigates back to background.
- **Header** (vitest): gear renders when authed, opens the modal, carries
  `backgroundLocation`; not rendered first-run/rejected-token.
- **Playwright (B1 visual gate)**: screenshot the modal (Appearance + GitHub
  Connection panes, light + dark) — the human eyeball-assert.

## 9. Risk re-check note

Classified **B1** (visual). The GitHub Connection pane re-renders the existing
read-only host and the existing Replace-token link only — **no token-storage,
PAT-scope-validation, or submit-pipeline logic is touched**. The pre-PR re-check
(`issue-resolution-workflow.md` step 7) will re-verify the committed diff; if any
auth logic is actually modified, re-classify to **B2** and route accordingly.

## 10. Open questions

None outstanding — all design forks resolved with the owner during brainstorming.
