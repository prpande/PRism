# Nav-bar feedback entry point (#430)

**Tier:** T2 (Light) — ~3–4 files, one icon-design choice, single coherent unit.
**Risk:** B1 gated (UI-visual; `needs-design` label). The design judgment is settled
with the owner in-conversation (see Decisions); the B1 gate fires as the post-green
visual assert, not on this spec.

## Problem

The only path an authed user has to the feedback modal is **Help (`?`) → expand the
"Send feedback" accordion → click "Send feedback"** — three interactions across two
surfaces. The `/welcome` footer link (the only other entry point) is never shown to
authed users. Early testers — the people we most want filing feedback — can't find it.

## Decisions (owner-confirmed, the B1 design judgment)

1. **Icon semantics — bug glyph.** A dedicated bug icon, not the chat bubble the Help
   accordion uses. (Owner choice; biases toward "report a problem," which is the
   primary intent for early-tester feedback.)
2. **Dedupe — keep the Help section.** The `Help → Send feedback` accordion stays as a
   discovery catch-all; the new header icon is the _fast_ path, not the _only_ second
   path.
3. **Placement & order — `Settings · Help · Feedback`.** Feedback is rightmost of the
   three (just before the window controls). This reorders the two existing icons: today
   it is `Help · Settings`; it becomes `Settings · Help · Feedback`. (Owner choice
   "A".)

## Approach

The feedback modal is already route-driven (`/feedback`, `FeedbackModalRoutes`). The
change is a new header `<Link to="/feedback" state={{ backgroundLocation: location }}>`
mirroring the existing Help/Settings links — **no new modal plumbing.**

### Files

- **`frontend/src/components/Header/FeedbackIcon.tsx`** (new) — a 16×16 `currentColor`
  bug glyph, same `SVG_PROPS` contract as `HelpIcon` (`aria-hidden`, `focusable=false`,
  `viewBox="0 0 16 16"`). Stroke-based so it tracks `.gear { color: var(--text-2) }`
  and the accent-glow hover. **Glyph spec** (so the result is reproducible, not an
  implementer's guess — the B1 gate verifies the look, it does not substitute for
  specifying it):
  - **Elements:** an upright oval body (the bug's back), a vertical center seam dividing
    the wings, two short antennae splaying up-and-out from the top, and three short legs
    per side. This is the canonical "bug report" silhouette (cf. Material `bug_report`).
  - **Stroke:** `strokeWidth={1.2}` on every element — the _same_ weight as `HelpIcon`,
    so visual weight matches its two neighbors. `fill="none"` (purely stroke, like
    `HelpIcon`'s outline + path). `strokeLinecap="round"` on the antennae and legs.
  - **Legibility floor:** no interior stroke below `1.0`. Antennae/legs are the thin
    elements most at risk of sub-pixel loss at 16×16 under `--text-2` luminance in **dark**
    theme. **Fallback:** if the full six-leg glyph reads cluttered or any leg vanishes in
    dark at 100% zoom, simplify to **two legs per side** (or oval body + antennae only) —
    recognizability over anatomical completeness. This is verified at the B1 gate in both
    themes before the baseline is accepted.
- **`frontend/src/components/Header/Header.tsx`** —
  - Reorder the existing Help/Settings blocks to **Settings, then Help**.
  - Append a third `isAuthed && (...)` block: a `<Link to="/feedback">` using the same
    `.gear` / `.gearOn` classes, `aria-label="Send feedback"`, active on the `/feedback`
    route.
  - Add `feedbackActive = pathname === '/feedback'` alongside the existing
    `helpActive` / `settingsActive` computations, wired to `aria-current` + `.gearOn`.
- **`frontend/src/components/Header/Header.test.tsx`** — add cases mirroring the Help
  cases: renders `<Link>` to `/feedback` when authed, `aria-current=page` on `/feedback`,
  hidden when unauthed. (Order is asserted by DOM-order if cheap; otherwise covered by
  the visual baseline.) **Query with `getByRole('link', { name: /send feedback/i })`** —
  NOT a bare `/feedback/i` text query: on `/feedback` the modal's `role=dialog` and submit
  `role=button` also carry a "send feedback" accessible name, so a role-scoped link query
  is required to stay unambiguous.
- **`FeedbackIcon.test.tsx`** (new, optional) — mirror `HelpIcon.test.tsx` (renders an
  `aria-hidden` svg). Only if `HelpIcon.test.tsx` justifies the pattern.

### a11y label

`aria-label="Send feedback"` (verb-led, matches the established affordance wording, and
an icon-only control benefits from an action verb). Help/Settings stay single-word; the
verb here is deliberate because a bare "Feedback" noun is less clear for an icon-only
trigger. The Help accordion link keeps its own "Send feedback" text — the e2e test that
clicks it is **scoped to the help dialog**, so the new header link does not collide.

**No `title` tooltip** — carry forward the existing Help/Settings convention (neither
carries a native `title`). The `aria-label` is the accessibility surface; a sighted
keyboard user tabbing through hears "Send feedback" announced. A bug glyph is admittedly
less universal than a gear or `?`, but adding a `title` to _only_ this icon would break
the three-icon consistency the placement decision is built on. Deliberate, recorded
decision — not an omission.

**No `:active` press styling** — the existing `.gear` rule defines only `:hover` and
`:focus-visible` (no `:active`); the new icon inherits that unchanged. "Active states
identical to Help/Settings" in the acceptance criteria means the route-active `.gearOn`
fill + `aria-current` (which this icon gets), not a pressed-button flash. No CSS change.

### No state/route changes

`/feedback` already exists and renders for authed and unauthed users. The header link is
gated on `isAuthed` (same as Help/Settings) — first-run/re-auth users reach `/feedback`
via `/welcome`, unchanged.

## Acceptance criteria

- [ ] Feedback entry point visible in the nav bar for authed users; opens the existing
      feedback modal in one click (`<Link to="/feedback">`).
- [ ] Accessible label (`aria-label="Send feedback"`); active (`/feedback` → `.gearOn` +
      `aria-current=page`) and hover states identical to Help/Settings (reuses `.gear`).
- [ ] Renders correctly in light and dark themes; e2e/visual baselines updated.
- [ ] Decisions recorded (icon semantics = bug; Help section = kept; order =
      `Settings · Help · Feedback`).

## Visual baselines to regenerate

Full-page authed captures that include the nav bar:

- `settings-modal-visual.spec.ts` captures **four** full-page (`expect(page)`) shots, all
  of which include the header: `settings-appearance-light.png`,
  `settings-appearance-dark.png`, **`settings-ghc-light.png`, `settings-ghc-dark.png`**,
  and `settings-narrow.png` — each in **both** `__screenshots__/linux` and
  `__screenshots__/win32` (≈10 files). All need regen.
- `no-layout-shift-on-banner.spec.ts` → `pr-detail-with-banner-masked.png` is a full-page
  capture on a `/pr/...` page where the authed header renders. Its tolerance is loose
  (`maxDiffPixelRatio:0.01`) and the header is a small fraction of the frame, so the
  reorder _may_ stay under tolerance — **verify during the regen pass; regen only if it
  reds.** (CI-only baseline.)
- `parity-baselines.spec.ts` `main`/component-scoped captures (`inbox.png`,
  `pr-detail-*`) do **not** include the `<header>` — unaffected.

Regen linux from the CI artifact, win32 locally (the established dance).

## Out of scope

- Removing the Help accordion section (explicitly kept).
- A PR-detail-context feedback trigger / `routePattern` plumbing (the
  `FeedbackModalRoutes` note about a future PR-detail trigger is untouched).
- Any change to the feedback modal itself.
