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

**In scope** — `frontend/src/components/Header/Header.tsx` and the one signal it
receives from `frontend/src/App.tsx`.

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
(`App.tsx:65`). Today it passes only `hasToken` to `Header`. Pass `isAuthed`
instead.

`Header` renders the `<nav>` tab strip **only when `isAuthed`**. When not authed,
the `<nav>` element is **omitted entirely** (not rendered empty — an empty
`navigation` landmark is an a11y smell). `<Logo>` and `<WindowControls>` render in
every state; hiding the desktop **close** button would trap the user. The layout
spacer continues to right-align `WindowControls`.

This gate hides the nav in the two states where the tabs would only bounce:
- **first-run** (`!hasToken`), and
- **rejected-token re-auth** (`hasToken` true but `authInvalidated` true → routes
  already redirect to `/setup`).

…and keeps the nav visible whenever it is usable, including the authed
replace-from-Settings flow (`/setup?replace=1`, where `isAuthed` is still true).

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

## Testing

**Header unit tests (vitest):**
- `!isAuthed` → no nav landmark and no tab links rendered.
- `isAuthed` → Inbox + Settings links present; **no** Setup link.
- `isAuthed` + `?replace=1` path → Settings link carries `aria-current="page"`.

**e2e (Playwright):**
- First-run screen (no token) shows the Connect screen with **zero** nav tabs.
- After auth, nav shows Inbox + Settings and **no** Setup tab.
- Settings → "Replace token" → Setup form → Cancel round-trips back to `/settings`
  (no-regression for criterion 4).

**No-regression (existing coverage relied upon):** post-connect redirect to Inbox
is covered by the existing setup specs; this change does not touch that path.

## Acceptance criteria

- [ ] During first-run, the nav tab strip is not rendered (Logo + WindowControls remain).
- [ ] The standalone Setup tab is removed; authed nav = Inbox + Settings.
- [ ] Re-running setup stays reachable via Settings → Auth "Replace token".
- [ ] After setup completion the app lands on Inbox (no-regress).
- [ ] B1 visual assert: first-run, authed, and replace states each look correct.

## Notes / decisions

- **`isAuthed` over `!hasToken`** was a deliberate choice (approved): gate on
  usability, not just first-run, so the rejected-token re-auth screen also hides
  the bouncing nav.
- The `· Setup` first-run affordance is **removed**, not relocated — first-run
  users land directly on the Setup screen, so no "go to setup" pointer is needed.
- "Replace token" copy is intentionally **not** changed (multi-account / relabel
  lives in #139).
