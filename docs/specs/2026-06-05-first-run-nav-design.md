# First-run setup flow: hide nav + remove the standalone Setup tab

- **Issue:** [#130](https://github.com/prpande/PRism/issues/130)
- **Tier:** T2 (light) · **Risk:** B1 (UI-visual, gated)
- **Date:** 2026-06-05

## Problem

The out-of-the-box experience leaks navigation. `Header.tsx` renders three tabs
(Inbox / Settings / Setup) **unconditionally**; on first run it only swaps the
Setup label to `· Setup`. So a brand-new user staring at the Connect-to-GitHub
screen also sees a full nav bar whose tabs only bounce back to `/setup`. After
setup, the standalone **Setup** tab never goes away.

#130 asks for: (1) hide the nav during first-run, (2) redirect to Inbox after
setup, (3) remove the standalone Setup tab once setup is done, (4) keep Setup
reachable from within Settings for re-running.

## Empirical baseline (observed in the running app, not inferred)

Validated live against a fresh first-run instance (launched at a temp `--dataDir`,
real config untouched) and the real authed instance:

| #130 criterion | Observed today | Status |
|---|---|---|
| 1. First-run nav hidden | At `/setup` (no token), header renders Inbox · Settings · "· Setup" above the Connect screen | **missing** |
| 2. Redirect to Inbox after setup | Authed app lands on `/` = Inbox; post-connect `navigate('/')` at `SetupPage.tsx:72` | **already ships** |
| 3. Standalone Setup tab gone once done | Authed nav still shows a plain **Setup** tab | **missing** |
| 4. Setup reachable from Settings | Settings → Auth → "Replace token" → `/setup?replace=1` renders the Setup form (Cancel → `/settings`) | **already ships** |

So the work is narrow: **(a) hide the nav tab strip during first-run, and (b)
remove the standalone Setup tab.** Criteria 2 and 4 already ship and are carried
as no-regression assertions.

## Scope

**In scope** — `frontend/src/components/Header/Header.tsx`, the one signal it
receives from `frontend/src/App.tsx`, and the existing Header unit suite
`frontend/__tests__/header.test.tsx` (which must be migrated, not merely added to —
see Testing).

**Out of scope** (explicitly):
- Settings page redesign → **#134**.
- Multi-account / add-and-switch tokens → **#139** (the "Replace token" link is
  unchanged here; not relabeled).
- Env/`gh` token detection → **#140**.
- Any routing or post-connect redirect change (criterion 2 already works).

## Design

Two changes, one coherent unit.

### 1. Gate the nav tab strip on `isAuthed`

`App.tsx` already computes `isAuthed = authState.hasToken && !authInvalidated`
(`App.tsx:65`). Today it passes `hasToken` to `Header`. **Rename the Header prop
`hasToken` → `isAuthed`** (the gate is no longer "has a token" — a rejected-token
session has a token but is not authed) and pass `isAuthed` at the call site.

`Header` renders the `<nav>` tab strip **only when `isAuthed`**. When not authed,
the `<nav>` element is **omitted entirely** (not rendered empty — an empty
`navigation` landmark is an a11y smell). `<Logo>` and `<WindowControls>` render in
every state; hiding the desktop **close** button would trap the user.

**No-nav header layout.** With the nav absent, the header keeps its existing flex
layout: **Logo stays left-flush**, the spacer (kept **unconditional**, as today)
grows to fill the middle, and `WindowControls` stays right-aligned. The empty
center is intentional — Logo is **not** re-centered, and no placeholder fills the
gap. This is the natural outcome of the current flex rules — verified against
`Header.module.css` (`.header { display: flex }`, `.spacer { flex: 1 }`): omitting
only the `<nav>` leaves Logo left, spacer owning the middle, `WindowControls`
right. The implementation should not add layout just for the no-nav state.

**Transition.** Mount/unmount is a **hard cut** — no fade/slide animation, matching
the app's existing nav (which has no show/hide animation today). The nav appears as
part of the post-connect route change to `/`.

This gate hides the nav in the two states where the tabs would only bounce:
- **first-run** (`!hasToken`), and
- **rejected-token re-auth** (`hasToken` true but `authInvalidated` true → routes
  already redirect to `/setup`).

…and keeps the nav visible whenever it is usable, including the authed
replace-from-Settings flow (`/setup?replace=1`, where `isAuthed` is still true).

**First-run is intentionally a dead-end surface.** While the nav is hidden, the
user has **no route to Inbox or Settings** — the Setup ("Connect to GitHub") screen
is the only surface, by design. Implementers must not re-introduce the nav tabs (or
a nav-equivalent jump) to escape it — that is the leak this issue removes.

**Escape hatch — for token entry.** The way forward is always the Setup form on
screen. The exact handler depends on how the user arrived:
- **First-run** (`/setup`, no `?replace=1`) → `onConnect` → `/api/auth/connect`.
- **Rejected-token bounced from a guarded route** → App routes to bare `/setup` →
  `onConnect`.
- **Rejected-token while already in the Settings→Replace flow** (`/setup?replace=1`)
  → `onReplace` → `/api/auth/replace` (SetupPage keys `onSubmit` off `isReplaceMode`,
  `SetupPage.tsx:169`).

Both endpoints accept a fresh token over an existing-but-rejected one (verified:
`/api/auth/connect` has no existing-token guard, `AuthEndpoints.cs`), so **token
re-entry never traps the user** — the actionable form is on-screen in every
nav-hidden state.

**Known limitation (pre-existing, out of scope): wrong host on first-run.** The
"never traps" claim covers *token* entry only. The Setup screen renders the
configured host as **read-only** (`SetupForm.tsx` only builds the PAT-page link); a
first-run user who configured a *wrong* `github.host` has no in-app way to correct
it — `HostChangeModal` only *resolves* a detected mismatch, it cannot *set* a host.
Editing `config.json` is the only path today. This predates this slice (the Setup
screen never had a host editor); hiding the nav does not create it but does fore­close
fixing it via a nav back-door. Left as-is here; see Deferred.

### 2. Remove the standalone Setup tab

Delete the third `<Link to="/setup">`. The authed nav becomes **Inbox · Settings**.
Remove the now-dead `setupActive` predicate and the `needsFirstRun` / `· Setup`
first-run indicator (its only job — pointing first-run users at Setup — is moot
when the Setup screen *is* the first-run page and the nav is hidden anyway).

**Keep** `settingsActive`'s `(pathname === '/setup' && isReplaceMode)` clause so
the Settings tab stays highlighted during the replace flow reached from Settings.

### Behavior matrix

| State | `hasToken` | `authInvalidated` | `isAuthed` | Header rendered? | Nav strip | Tabs |
|---|---|---|---|---|---|---|
| First-run (no token) | false | — | false | yes | **hidden** | none |
| Authed, normal | true | false | true | yes | shown | Inbox, Settings |
| Replace from Settings (`/setup?replace=1`) | true | false | true | yes | shown | Inbox, Settings (Settings active) |
| Rejected-token re-auth | true | true | false | yes | **hidden** | none |
| Auth still loading (`authState === null`) | — | — | — | **no** (App renders `LoadingScreen`) | n/a | n/a |
| Host mismatch | — | — | — | **no** (App renders `HostChangeModal`) | n/a | n/a |

### Routing / re-run — unchanged

`/setup` still routes to `SetupPage`; auth-gated routes still redirect to `/setup`;
the post-connect `navigate('/')` and the Settings → Auth "Replace token" link are
untouched.

## Accessibility

- No empty `<nav>` landmark when hidden — the element is omitted.
- Authed nav retains `aria-current="page"` on the active tab (Inbox/Settings).
- `WindowControls` (including the close button) remains reachable in every state,
  including first-run.
- **Focus on the auth transition is unchanged.** The nav appears as part of the
  full route change to `/` (`navigate('/')`), which remounts the page — focus
  handling across that route change is the app's existing behavior and is **not**
  modified here. This slice adds no focus-management logic; if a stranded-focus
  problem exists it predates this change and is out of scope.

## Testing

**Migrate the existing Header suite — do not just add to it.**
`frontend/__tests__/header.test.tsx` currently asserts behavior this slice deletes
and passes the prop this slice renames; it will go **red** unless rewritten. The
following existing cases must be **removed or rewritten**:
- `renderAt(...)` passes `<Header hasToken={…} />` → update the helper to pass
  `isAuthed`.
- `"renders logo + Inbox/Settings/Setup tabs"` → drop the Setup-tab assertion;
  assert **Inbox + Settings only**.
- `"marks Setup active (NOT Settings) on '/setup' with no replace param"` → delete
  (no Setup tab to mark active).
- `"prefixes the Setup label with the first-run '·' indicator when !hasToken"` and
  `"omits the '·' indicator once a token is configured"` → delete (indicator
  removed).
- Keep `"marks Inbox active on '/'"`, `"marks Settings active on '/settings'"`,
  the nested-settings case, the `/setup?replace=1` → Settings-active case, and the
  `#119` search-box cases — but all run only in the `isAuthed` state now.

**New Header unit cases (vitest):**
- `isAuthed={false}` → **no `<nav>` landmark and no tab links** rendered; Logo
  still present.
- `isAuthed={true}` → Inbox + Settings links present; **no** Setup link.
- `isAuthed={true}` + `?replace=1` path → Settings link carries
  `aria-current="page"`.

  *Note:* the **rejected-token** branch cannot be tested at the Header unit level —
  Header receives a single `isAuthed` boolean, so first-run (`!hasToken`) and
  rejected-token (`authInvalidated`) both collapse to `isAuthed={false}` and render
  identically. Testing a separate "rejected-token" Header case would just duplicate
  the `isAuthed={false}` case. The `authInvalidated → isAuthed=false → nav hidden`
  chain lives in `App.tsx`, so cover it there:

**App-level case (vitest):** when a `prism-auth-rejected` event fires
(`authInvalidated=true`) on a session that has a token, `App` passes
`isAuthed={false}` to `Header` and the nav strip is not rendered — and a subsequent
`prism-auth-recovered` restores it. This is the only place the rejected-token branch
is observable.

**e2e (Playwright):**
- First-run screen (no token) shows the Connect screen with **zero** nav tabs.
- After auth, nav shows Inbox + Settings and **no** Setup tab.
- Settings → "Replace token" → Setup form → Cancel round-trips back to `/settings`
  (no-regression for criterion 4).

**No-regression for criterion 2 (redirect to Inbox).** This is honest about the
gap the adversarial pass found: **no existing spec asserts the post-connect
`navigate('/')` transition** (`setup-page.test.tsx` does not cover it). The
protection here is structural, not test-based — criterion 2 lives entirely in
`SetupPage.tsx`, which **this slice does not modify**, so it cannot regress *from
these changes*. This slice does not add a dedicated redirect test (that would be
scope creep into the setup flow); if we want a standing guard, it belongs to a
separate setup-flow test task, noted in deferrals.

## Acceptance criteria

- [ ] During first-run, the nav tab strip is not rendered (Logo + WindowControls remain).
- [ ] The standalone Setup tab is removed; authed nav = Inbox + Settings.
- [ ] Re-running setup stays reachable via Settings → Auth "Replace token".
- [ ] After setup completion the app lands on Inbox (no-regress).
- [ ] **B1 visual assert** — concrete per-state pass criteria for the human eyeball:
  - **First-run:** **no** nav tabs; Logo left-flush; `WindowControls` right; empty
    center (Logo not re-centered); the "Connect to GitHub" card renders below.
  - **Authed (Inbox/Settings):** exactly **two** tabs — Inbox, Settings — **no**
    Setup tab; active tab highlighted; header height/balance unchanged vs. today
    minus the third tab.
  - **Replace from Settings (`/setup?replace=1`):** nav shown with **Settings**
    highlighted (not a Setup tab — there is none); Setup form renders with
    Cancel → `/settings`.
  - **Loading + host-mismatch (no-regress):** `authState === null` renders only the
    `LoadingScreen` (no Header, no nav); host-mismatch renders only the
    `HostChangeModal` (no Header, no nav). Confirm neither now shows a partial nav.
  - Captured as before/after Playwright screenshots embedded on the PR.

## Notes / decisions

- **`isAuthed` over `!hasToken`** was a deliberate choice (approved): gate on
  usability, not just first-run, so the rejected-token re-auth screen also hides
  the bouncing nav.
- The `· Setup` first-run affordance is **removed**, not relocated — first-run
  users land directly on the Setup screen, so no "go to setup" pointer is needed.
- "Replace token" copy is intentionally **not** changed (multi-account / relabel
  lives in #139).
- **Criterion 4 — operative decision (so implementation is not blocked).** We read
  "reachable from Settings for re-running" as satisfied by the **existing** Settings
  → Auth "Replace token" link, which opens the shared Setup form (`/setup?replace=1`)
  in replace mode (`onReplace` → `/api/auth/replace`). This is **token re-entry** —
  narrower than a full first-run re-run (it does not re-walk repo selection the way
  connect does). Per the approved narrow scope, **this slice builds nothing new for
  criterion 4** and treats it as no-regress; we defer (a) any **relabel** for
  discoverability (a user hunting for "Setup" finds only "Replace token") to #134 /
  #139, and (b) any **fuller re-run** (host + repo re-selection) as out of scope.
  **Confirm with @prpande at the review gate:** the default above is what we build;
  if you intended a *full* setup re-run, say so and it expands this slice.

## Deferred

- **Standing redirect guard for criterion 2.** No spec currently asserts the
  post-connect `navigate('/')` → Inbox transition. This slice does not add one
  (the redirect lives in untouched `SetupPage.tsx`); a dedicated setup-flow test
  is a separate task if we want regression protection there.
- **"Replace token" relabel / discoverability** → #134 (Settings redesign) / #139.
- **Full setup re-run** (host + repo re-selection from Settings) → out of scope
  pending the criterion-4 clarification above.
- **In-app host correction on first-run** (pre-existing gap) → tracked as **#194**.
  The Setup screen has no host editor; a wrong `github.host` on first-run is only
  fixable by editing `config.json`. Not introduced by this slice, but this slice
  forecloses fixing it via the nav. Relates to #134 / #140.
