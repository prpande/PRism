# First-run welcome / landing screen

- **Issue:** [#212](https://github.com/prpande/PRism/issues/212)
- **Tier:** T3 (full) · **Risk:** B1 (UI-visual, gated)
- **Date:** 2026-06-06

## Problem

A brand-new user opening PRism for the first time is taken straight to a
credentials-entry form. The first-run route is `/setup` (`App.tsx` redirects all
unauthed traffic there) → `SetupPage` → `SetupForm`, which leads with "Connect to
GitHub" and immediately asks the user to generate and paste a Personal Access
Token.

The setup page is already a structured full page (heading, "local-first / your
token never leaves this machine" line, a numbered "Generate a token" step with a
permissions table, a first-run disclosure, a masked PAT input). But the experience
is **cold**: the very first thing a new user sees is a request for credentials,
with no welcome, no "what is PRism / why would I want this," and no orientation
before the app asks for a token.

#212 asks for a warmer, more welcoming first-open experience that orients the user
_before_ asking for a token — without becoming a marketing site.

## Scope

**In scope**

- A new `/welcome` route + `WelcomePage` component (`frontend/src/pages/`).
- Routing changes in `frontend/src/App.tsx` to land true-first-run users on
  `/welcome` and keep everyone else on their current path.
- A first-run-only "← Back" affordance on `/setup` that returns to `/welcome`.
- New unit tests (component + routing) and an e2e first-run flow + B1 visual.

**Out of scope** (explicitly)

- **PAT-type accuracy** (fine-grained vs classic, org/enterprise guidance) →
  **#213**. `/setup`'s token _content_ is unchanged here; #213 owns that rework and
  builds on whatever structure this slice leaves.
- **The final human copy** for the welcome screen → **#222**. This slice ships
  _placeholder_ tagline/benefit copy; #222 owns the human rewrite so the words get a
  focused pass instead of being rubber-stamped inside the structural PR.
- **Wiring the Help / Feedback links** → **#210 / #211**. This slice renders the
  footer slot with **stubs**; those issues replace the stubs with working entry
  points (coordination comments posted on both).
- **Header wordmark on first-run** → **#215** (the header surface; distinct from the
  welcome page body, which carries its own wordmark). Not blocked by, nor blocking,
  this slice.
- Any backend change, new network call, or auth/token logic change.

## Design

### 1. Routing — land first-run on `/welcome`, no new state

`App.tsx` already computes `isAuthed = authState.hasToken && !authInvalidated`
and `authState.hasToken`. The welcome screen keys off these **existing** signals —
**no new persisted or in-memory state.**

The distinguishing fact: `authState.hasToken` is `false` **only** for a user who
has never stored a token. Both the token-rejected re-auth session and the
Settings→Replace flow have a token on disk (`hasToken === true`) — they are _not_
first runs and must not be re-onboarded.

Concrete changes in `App.tsx`:

- Add `<Route path="/welcome" element={…} />` rendering `WelcomePage`.
- The unauthed redirects (`/`, `/settings`, `/pr/*`, and the `*` catch-all) send
  unauthed users to **`/welcome` when `!authState.hasToken`**, else to **`/setup`**.
- `WelcomePage` itself, if reached while `isAuthed`, redirects to `/`.
- `/setup` stays **directly reachable while unauthed** (its route is unguarded as
  today), so a first-run user who clicked "Get started" and is mid-typing is not
  bounced back to `/welcome`.
- **All four redirect sites change together** — `/setup`-vs-`/welcome` must be
  decided consistently at every guard: `/` (`App.tsx:102`), `/settings`
  (`App.tsx:100`), `/pr/*` (`App.tsx:110`), and the `*` catch-all (`App.tsx:112`).
  Missing one leaks a first-run user back to `/setup` from that path. A first-run
  (`!hasToken`) `/pr/owner/repo/N` deep link therefore lands on `/welcome`
  (consistent with the catch-all); the requested PR ref is intentionally **dropped**
  — a never-connected user cannot open any PR, so there is nothing to preserve.

#### Routing behavior matrix

| User state                                | `hasToken` | `isAuthed` | Default unauthed redirect lands on        |
| ----------------------------------------- | ---------- | ---------- | ----------------------------------------- |
| True first run (never connected)          | `false`    | `false`    | **`/welcome`**                            |
| Token-rejected re-auth                    | `true`     | `false`    | `/setup`                                  |
| Settings → Replace (`/setup?replace=1`)   | `true`     | `true`     | (stays on `/setup`, authed)               |
| Authed, normal                            | `true`     | `true`     | `/` (Inbox)                               |
| `/welcome` hit by an authed user          | `true`     | `true`     | redirect → `/`                            |
| First-run `/pr/*` deep link               | `false`    | `false`    | **`/welcome`** (requested PR ref dropped) |
| Auth still loading (`authState === null`) | —          | —          | `LoadingScreen` (upstream, unchanged)     |

#### Deliberate simplification — no "seen-welcome" flag

A first-run user who reaches `/setup`, quits **before** connecting, and reopens
will see `/welcome` again (still `!hasToken`). We are **not** adding a persisted
"seen-welcome" flag to suppress the re-show: it is extra state for a once-ever,
low-cost annoyance in a PoC, and the welcome screen is cheap to dismiss ("Get
started"). Recorded as an accepted tradeoff, not an oversight. If product wants
one-time-only behavior later, it is an additive change (a stored boolean gating
the `/welcome` redirect) and does not invalidate this design.

### 2. `WelcomePage` component

A single centered card that **inherits the existing setup shell** for visual
coherence with `/setup`: it reuses the `.screen` / `.bg` (accent radial backdrop) /
`.card` structure from `SetupPage.module.css`, including the `--header-h`
no-page-scroll fix (the screen is `min-height: calc(100dvh - var(--header-h))`, so
`header + screen` never overflows the viewport — see #205/#197). The card content,
top to bottom:

1. **Brand icon** — the existing `/prism-logo.png` asset (the same image the
   `Header` `Logo` renders), at hero size (~56–64px). Reused, not re-drawn.
   Rendered **decorative** (`alt=""`): the adjacent wordmark heading already names
   the product, so a non-empty `alt` here would make a screen reader announce
   "PRism" twice. (This differs from the header `Logo`, whose `alt="PRism"` is
   correct _there_ because no adjacent wordmark text accompanies it.)
2. **Wordmark** — the **literal brand name "PRism"** as the page's `<h1>` below the
   icon. This is the fixed product name, **not** placeholder copy — it is _not_ in
   #222's rewrite scope.
3. **Tagline** — a one-line value statement. _Placeholder copy, owned by #222:_
   "Review pull requests without leaving your machine."
4. **Three benefit rows** — one line each. _Placeholder copy, owned by #222:_
   - 🔒 Local-first — your PAT never leaves this device.
   - ⚡ A focused PR-review workspace, not the GitHub web tab.
   - 🤖 AI hotspots surface the hunks worth a close look.

   The leading emoji are **decorative** (`aria-hidden="true"`); the benefit text
   carries the meaning. (#222 may swap emoji for icon components; either way the
   glyph is not content.)

5. **Primary CTA** — "Get started", reusing the **existing primary button**
   (`btn btn-primary btn-lg`, the same variant as `/setup`'s "Continue") so hover /
   focus / active states come from the already-tested design-system component, not
   new CSS. Navigates to `/setup`.
6. **Footer slot** — **Help** and **Send feedback** rendered as **stubs**:
   **plain, non-interactive muted text** (a `<span>`/`<p>`, **not** an `<a>` or
   `<button>`, no `href`, no `aria-disabled`). They look like quiet labels, not
   clickable links, so a sighted user doesn't click a dead link and a screen reader
   doesn't announce a working link. #210/#211 replace these stubs with real entry
   points. The slot is the designated pre-auth home for Help / Feedback, which the
   nav can't reach during first-run (#130 hides the nav). _(Owner decision: render
   the slot now rather than defer it to #210/#211 — accepted with the cost noted in
   Notes/decisions.)_

**Wordmark is fixed; tagline + benefit rows (items 3–4) are placeholder copy owned
by #222.** The component fixes structure and the icon/wordmark/CTA treatment; final
wording and the visual polish (spacing, type scale, exact icon size, benefit-row
layout) are not pinned here.

**Short-viewport behavior.** On a window too short to fit the card
(icon + wordmark + tagline + 3 rows + CTA + footer), the inherited
`.screen { overflow: auto }` scrolls the card **internally** — exactly as `/setup`
behaves today. The "no page scroll" B1 criterion means no _page_ scroll (the
`--header-h` / #205 fix); it does not promise the card always fits without internal
scroll on tiny viewports.

**Theme.** Light/dark is **fully inherited** from the reused `.screen`/`.bg`/`.card`
shell and design tokens — no per-element theme overrides. One thing to verify at
build: `/prism-logo.png` must read correctly on the dark `--surface-1` card (it
already renders on the dark app header, so this is expected to be fine).

**Visual fidelity is handed to `frontend-design` at build time**, working against
the real tokens (`--surface-*` ladder, `--accent`, `tokens.css` type scale). The
spec sets intent and structure, not pixel values. This is the natural place for the
B1 visual gate to land.

**Two-heading progression is intentional.** A first-run user sees `/welcome`'s
`<h1>` "PRism" (brand / orientation) then, after "Get started", `/setup`'s "Connect
to GitHub" (the task). These are two `<h1>`s on two separate routes — a deliberate
orient-then-act handoff, not a redundancy. `/setup`'s heading is **unchanged**.

### 3. `/setup` — preserved, plus a first-run-only "← Back"

Because the warmth now lives on `/welcome`, `/setup` keeps its content essentially
unchanged (numbered token steps, `FirstRunDisclosure`, masked input) — satisfying
the "preserve existing trust copy + token steps" acceptance criterion. **One small
addition (owner request):** a decorative GitHub mark sits inline, left of the
"Connect to GitHub" heading. The mark is the existing octocat SVG, **lifted from
`OpenInGitHubButton` into a shared `components/icons/GitHubMark` component** on its
second consumer; it is `aria-hidden` (the heading text already names GitHub, so the
accessible name stays "Connect to GitHub").

One addition: a subtle **"← Back"** affordance on `/setup` that returns to
`/welcome`, shown **only on a true first run**. **Gate on `!authState.hasToken`
alone** — `hasToken === true` already precludes _both_ the re-auth and the
Settings→Replace paths (Replace is only reachable from an authed session, which has
a token), so no second "not in replace mode" condition is needed:

- True first run (`!hasToken`) → show "← Back" → `/welcome`.
- Re-auth (`hasToken`) → **no** "← Back" (those users never saw `/welcome`).
- Settings→Replace (`hasToken`, `?replace=1`) → **no** "← Back"; excluded by the
  same `!hasToken` gate, and it already has its own `Cancel` → `/settings` link.

**Why an in-app Back and not the browser back button** (the obvious cheaper
alternative): PRism ships as an **Electron** desktop app (`desktop/`), whose
`BrowserWindow` renders **no browser chrome** — there is no visible back button for
the user to fall back on. The in-app affordance is the _only_ way back to `/welcome`
in the shipped product, so it is not redundant with browser navigation. It recovers
a first-run user who clicked "Get started" by mistake or wants to re-read the
framing, at near-zero cost, without showing a dangling back-link to users who have
no `/welcome` to return to.

**Visual treatment & placement.** Reuse the existing `/setup` `Cancel`-link
treatment (`.cancel` in `SetupForm.module.css` — a left-aligned, `--text-2` muted
text link) for visual parity; it sits at the top of the card, above the "Connect to
GitHub" heading. The wiring of the gate lives in `SetupPage` (which already reads
`authState` and the `replace` search param); the boolean is passed to `SetupForm`
the same way `isReplaceMode` is, keeping `SetupForm` router-agnostic and
unit-testable without a Router wrapper.

## Accessibility

- `WelcomePage` uses a single `<h1>` for the wordmark; benefit rows are a list;
  the CTA is a real button/link that navigates to `/setup`. The footer stubs are
  **plain non-interactive text** (`<span>`/`<p>`, no `href`, no `aria-disabled`)
  until #210/#211 make them real links — a stub must not render or announce as a
  working link.
- The brand `<img>` is **decorative** (`alt=""`); the adjacent `<h1>` wordmark
  carries the product name, so a non-empty `alt` would double-announce "PRism".
- The benefit-row leading emoji are decorative (`aria-hidden="true"`); only the
  benefit text is announced.
- The `/setup` "← Back" is a real link (`<Link to="/welcome">`) with discernible
  text; it is **absent** (not `aria-disabled`) when not first-run, so there is no
  phantom control for re-auth users.
- No empty landmarks introduced; the welcome card lives inside the existing
  `[data-app-scroll]` region below the header, like `/setup`.
- Focus on the `/welcome` → `/setup` navigation is the app's existing route-change
  behavior; this slice adds no focus-management logic.

## Testing

**Component (vitest) — `WelcomePage`:**

- Renders the brand icon, the wordmark `<h1>` "PRism", the tagline, three benefit
  rows, the "Get started" CTA, and the two footer stubs.
- "Get started" navigates to `/setup`.
- Footer stubs are present but **not** links (assert they are `<span>`/`<p>`, not
  `<a>`/`<button>`, with no `href` and not in the tab order).

**Routing (vitest) — `App` redirect logic:**

- Unauthed + `!hasToken` → `/welcome`.
- `hasToken` + `authInvalidated` (re-auth) → `/setup`, **never** `/welcome`.
- `?replace=1` (authed) → `/setup`.
- Authed navigating to `/welcome` → redirected to `/`.
- **Migrate the existing `app.test.tsx` `routes to /setup when no token` case.**
  It currently loads `/` with `hasToken: false` and asserts "Connect to GitHub";
  under the new routing that input lands on `/welcome`, so the assertion must flip
  to the `/welcome` wordmark / "Get started" CTA. The "`/setup` directly reachable
  while unauthed" guarantee moves to a **new** case that navigates to `/setup`
  explicitly (not via the `/` redirect). Without this migration the suite goes red.
  (The `setup-page.test.tsx` component tests render `/setup` via a local
  `MemoryRouter`, not the App redirect, so they are unaffected.)

**Component (vitest) — `/setup` back affordance:**

- `!hasToken` (first run) → "← Back" link to `/welcome` present.
- `hasToken` (re-auth) → no "← Back".
- replace mode → no "← Back" (the existing `Cancel` → `/settings` is unaffected).

**e2e (Playwright) + B1 visual:**

- Fresh first run (temp `--dataDir`, no token) → app lands on `/welcome`; the card
  shows icon + wordmark + tagline + benefits + CTA + footer stubs.
- "Get started" → `/setup`; "← Back" → `/welcome` round-trips.
- The re-auth path does **not** show `/welcome` (no welcome hero on a
  rejected-token session).
- Screenshots of `/welcome` in **both light and dark** themes are the B1 visual
  proof embedded on the PR (the B1 gate captures one frame per theme so a
  theme-broken card — e.g. the logo on the dark card — can't slip through).

## Acceptance criteria

- [ ] A true first-run user (`!hasToken`) lands on `/welcome` with orienting framing
      (brand icon, wordmark, value tagline, three benefit lines) before any credentials
      request.
- [ ] The token-rejected re-auth path and the Settings→Replace path
      (`hasToken === true`) route straight to `/setup` and never render the welcome hero.
- [ ] "Get started" advances to `/setup`; the first-run "← Back" returns to
      `/welcome`; re-auth/replace users get no "← Back".
- [ ] `/setup`'s existing local-first trust copy and numbered token steps are
      preserved unchanged.
- [ ] A footer slot on `/welcome` renders Help / Send-feedback **stubs** as the
      designated home for #210/#211.
- [ ] **B1 visual assert** (human eyeball, captured as Playwright screenshots on the
      PR):
  - **First run (light + dark):** `/welcome` card centered on the accent backdrop;
    brand icon at hero size above the "PRism" wordmark; tagline + three benefit
    rows; "Get started" CTA; Help · Send-feedback footer (plain muted text, not
    links) under a divider; no _page_ scroll; logo legible on the dark card.
  - **`/setup` (first run):** unchanged token card + a subtle "← Back" (top of card,
    `.cancel`-style muted link).
  - **Re-auth `/setup`:** identical to today (no welcome, no "← Back").

## Notes / decisions

- **Architecture: separate `/welcome` route** (not enrich `/setup` in place),
  chosen by the owner over the lower-cost enrich-in-place default. The **load-bearing
  justification is the "learn vs connect" separation** — a clean orientation surface
  distinct from the credentials task. Being the pre-auth home for Help/Feedback is a
  _forward-looking_ benefit, **not yet cashable** in this slice (those links ship as
  stubs, #210/#211 wire them), so it does not carry the decision on its own. The
  costs (an extra route, one click-through, re-auth suppression) are absorbed by the
  routing matrix above.
- **`!hasToken` is the first-run seam** — re-auth and replace both have a token, so
  one boolean cleanly distinguishes "never connected" from "connected-but-rejected /
  swapping," with no new state. **Verified against code** (`TokenStore.HasTokenAsync`
  probes the stored keychain blob; a rejected token never clears it — only the
  in-memory `authInvalidated` flips; there is no production logout path), so re-auth
  and replace never fall into the `/welcome` branch.
- **First-run "← Back" is kept, not cut** — challenged as scope creep (the browser
  back button would suffice), but PRism's Electron `BrowserWindow` exposes no browser
  chrome, so the in-app affordance is the only back path in the shipped app. Gated on
  `!hasToken` alone (which already excludes re-auth and replace).
- **Benefit-rows + icon + wordmark layout (treatment B)** — deliberately chosen over
  a minimal tagline-only door (treatment A) during the design pass. Three one-line
  benefits orient "why would I want this" in one viewport; the goal's "not a
  marketing site" guard is honored by keeping it to one screen, no tour, decorative
  glyphs. Recorded as an owner decision after weighing the lighter option.
- **Footer stub slot is rendered now** (vs deferred to #210/#211) — owner decision.
  Cost accepted: a quiet dead slot + a "these are not links" test until those issues
  land. Mitigated by rendering them as plain muted text (not link-styled), so they
  read as "coming soon" labels, not broken links.
- **No "seen-welcome" flag** — accepted PoC tradeoff (re-show on quit-before-connect),
  additive to fix later if wanted.
- **Copy is placeholder** — human rewrite is **#222** (see the interim-impression
  risk in Deferred).
- **PAT-type guidance is #213**, not this slice.

## Deferred

- **Human copy rewrite** for tagline / benefits / CTA / footer labels → **#222**.
- **Help / Feedback link wiring** into the footer slot → **#210 / #211**.
- **One-time-only welcome** (suppress re-show after first dismissal) → not built;
  additive stored-boolean change if product wants it.
- **PAT fine-grained vs classic accuracy** on `/setup` → **#213**.

### Risks acknowledged (not blocking)

- **Interim first-impression while #222 is open.** Until #222 lands the human copy,
  the resting state is a warm-looking screen with admittedly-draft ("AI-slop") copy —
  arguably a _different_ poor first impression than today's cold-but-honest form.
  **Resolved (owner, 2026-06-06):** external testing will be gated — **no external
  tester sees the app until both #213 (PAT accuracy) and #222 (real copy) have
  landed.** So the placeholder-copy resting state is only ever seen internally.
  Placeholder copy shipped here should still be **plain and honest** (not
  faux-marketing) as defense-in-depth. The structure-first sequencing (#212 before
  #213/#222) is a deliberate owner call, not issue-number order.
- **B1 baseline churn from #222.** The B1 screenshots capture placeholder copy; if
  #222 changes copy length/line-count materially, the visual baselines need
  regenerating. Expected and cheap — noted so it isn't a surprise.
