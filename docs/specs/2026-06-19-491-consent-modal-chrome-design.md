# #491 — Egress-consent modal chrome polish (design)

**Issue:** [#491](https://github.com/prpande/PRism/issues/491) — Polish the "Enable Live AI" egress-consent modal to match the app's design aesthetic.
**Date:** 2026-06-19
**Branch:** `feature/491-consent-modal-chrome` (base = `V2`)
**Classification:** Gated — UI-visual. Owner B1 sign-off required (already obtained on the visual mockup; spec sign-off pending).

## 1. Scope

**Visual / chrome only.** This change restyles `EgressConsentModal` so it reads as a deliberate, first-class PRism surface instead of an unstyled prompt. It does **not** alter consent behavior.

Per the issue's scope guard, all of the following stay exactly as-is:

- the disclosure-version POST (`postAiConsent(disclosure.disclosureVersion)`),
- the open-ref guard that refuses to commit Live after a mid-POST dismissal,
- the failure / retry handling (disclosure-load fail-closed; consent-POST retry),
- the truthful disclosure content (recipient + data categories, sourced from the backend `EgressDisclosure` endpoint).

No change to `aiConsent.ts`, to the backend, or to the consent state machine. The `disclosure` / `failed` / `submitError` / `submitting` states and the `openRef` guard in `EgressConsentModal.tsx` are preserved verbatim; only the JSX that *renders* each state and the classes applied to it change.

### Out of scope

- Consent flow logic, network calls, retry semantics.
- The AI-mode radio control in `AiPane.tsx` (the modal's caller) — untouched.
- Any other modal's appearance. The one shared-component touch (below) is additive and opt-in, so no existing modal changes.

## 2. Current state

`EgressConsentModal.tsx` wraps the shared `Modal` and renders:

- title `"Enable Live AI"` (plain text),
- a top-anchored card (no `align`),
- body: `<p>` lead + `<p>` "leaves your device to {recipient}" + `<ul>` of `dataCategories`,
- loading: two bare `Skeleton` bars,
- disclosure-load error / consent-POST error: bare `<div role="alert">` text,
- actions: `btn btn-secondary` Decline + `btn btn-primary` Enable Live.

It has no CSS module; everything inherits global `.modal-*` / `.btn-*` defaults. The result is functional but visually generic — the issue's complaint.

## 3. Locked design (from B1 mockup)

The mockup (`disclosure-final.html`, real tokens, both themes, all three states) is the source of truth. Summary:

### 3.1 Shell
- Keep the shared `Modal` component (preserves focus-trap, Esc, `defaultFocus="cancel"`, `role="dialog"`, `aria-labelledby`).
- Pass `align="center"` so the card is vertically centered (existing `.modal-backdrop--center` mechanism — no Modal change for this).

### 3.2 Title
- Lead the title with the universal AI `SparkIcon` (`--accent` colored, `aria-hidden`), followed by the text "Enable Live AI".
- The accessible name must remain exactly **"Enable Live AI"** (the icon is decorative). This is asserted by `e2e/ai-live-consent.spec.ts` via `getByRole('dialog', { name: 'Enable Live AI' })`.

### 3.3 Body — loaded
- Lead `<p>`: "Live AI generates a real, diff-grounded summary of this pull request." (unchanged copy).
- **Egress callout panel** (the design-direction-A device):
  - `border: 1px solid var(--border-1)`, `border-left: 3px solid var(--warning)`, `background: var(--surface-2)`, `border-radius: var(--radius-3)`, `padding: var(--s-4)`.
  - Head row: a **warning-triangle glyph** (`--warning-fg`, `aria-hidden`) + the text "Sent off your device to **{recipient}**". The glyph carries the amber; the head text is `--text-1` (neutral, `font-weight: 600` on the recipient — weight, not hue), so the panel reads as caution-accented rather than fully amber.
  - **Element constraint (test-load-bearing):** the recipient stays in its own dedicated element (e.g. `<strong className={styles.recipient}>{disclosure.recipient}</strong>`), not interpolated into a single run of text. The e2e selector `modal.getByText('Anthropic, via the Claude Code CLI')` is an exact full-text match against one element (spec line 352); folding the recipient into surrounding text in the same element silently breaks it. Same applies to each `dataCategories` `<li>` (the e2e matches `'Pull request diff'` at line 355).
  - Below: the `<ul>` of `dataCategories`, each with a small dot bullet, text `--text-2`. List content unchanged — still `disclosure.dataCategories.map(...)`, one category per `<li>`.

### 3.4 Body — loading
- Shimmer skeleton: a couple of text-line skeletons **plus** a callout-shaped skeleton block, so the loading state previews the loaded layout rather than two orphan bars.
- The existing `sr-only` `aria-live="polite"` "Loading data-sharing disclosure…" announcement is preserved (asserted by the unit test).

### 3.5 Body — error
- Both error messages (disclosure-load fail and consent-POST fail) get the **same visual treatment** — a styled inline callout: `--danger-soft` background, `--danger` border, a circle-alert glyph (`aria-hidden`), `--danger-fg` text — replacing the bare `<div>`.
- **They render in structurally different positions and that MUST be preserved** (same shape ≠ same place):
  - The **disclosure-load** error (`failed`) *replaces* the body — it is the `failed` branch of the state ternary, and it disables Enable Live.
  - The **consent-POST** error (`submitError`) is a **sibling rendered after the state ternary**, exactly where `{submitError && ...}` sits today. `submitError` can only become true *after* the disclosure has loaded (`accept()` early-returns when `!disclosure`), so it co-renders *with* the loaded body and leaves Enable Live enabled for retry. Folding the new error box into the `failed`/loaded branches would make the consent-POST error unreachable and break the `submit error: shows retry copy` unit test.
- The `role="alert"` / `aria-live="assertive"` semantics and the exact message strings are preserved verbatim (the unit test matches `/Couldn't load the data-sharing disclosure/i` and `/Couldn't enable Live AI/i`).

### 3.6 Actions
- **Decline** — outline→fill red, mirroring the comment composer's discard button (`.composer-frame .composer-discard`): at rest `border: 1px solid var(--border-2)`, `background: var(--surface-1)`, `color: var(--danger-fg)`; on hover `background: var(--danger-soft)`, `border-color: var(--danger)`. Keeps `data-modal-role="cancel"` (so `defaultFocus="cancel"` still lands on it) and the `Decline` accessible name.
- **Enable Live** — solid filled green (`.btn-success`, new — see §4.2). Keeps `data-modal-role="primary"`, the `Enable Live` accessible name, and the `disabled={!disclosure || failed || submitting}` gate.
  - **Submitting affordance:** while `submitting === true` the button is disabled (existing) **and** shows an inline spinner glyph (`aria-hidden`) plus the label "Enabling…", so the in-flight consent POST is visible rather than a silent grey-out. This is a label swap on an already-disabled button; it does not alter the consent state machine. The at-rest accessible name stays "Enable Live" (the e2e clicks the button *before* it enters `submitting`).
- Both buttons keep the global `.btn` base (height, padding, focus-visible ring, disabled opacity) and the `transition` already defined there, so the hover is animated.
- **Focus ring:** both buttons take the global `:focus-visible` ring (`outline: 2px solid var(--accent-ring)`). The accent (indigo) ring on the danger-hued Decline button is intentional and consistent — `.btn-danger` already uses the accent ring rather than a per-semantic-color ring; one ring color across all interactive surfaces is the established convention. No `--danger-ring` token is introduced.

#### Color-semantics note (deliberate deviation)
Conventional risk semantics would tint the *destructive-of-the-safe-default* path (Enable Live, which starts egress) red and the safe path (Decline) neutral. The owner chose the inverse traffic-light mapping — Decline = red, Enable = green — to read "Live = go / green-lit." The warning-amber egress callout (§3.3) carries the data-leaves-your-device caution independently of button hue, so attention to the risk is not lost. Recorded here per the "document plan deviations" rule.

## 4. Implementation shape

### 4.1 New CSS module — `EgressConsentModal.module.css`
Holds everything specific to this modal, all from tokens:
- `.callout`, `.calloutHead`, `.calloutIcon`, `.recipient`, `.dataList`, `.dataItem` — the egress panel.
- `.submitSpinner` — the inline in-flight spinner on Enable Live (reduced-motion-guarded; reuse the existing spinner pattern if one exists).
- `.errBox`, `.errIcon` — the inline error callout.
- `.skeletonCallout` — the callout-shaped loading block.
- `.declineBtn` — the outline→fill red Decline treatment (composed with global `.btn`), scoped here rather than added globally because it is a one-off for this modal. Mirrors the composer-discard token choices but does not depend on `.composer-frame`.
- Reduced-motion: the only animation is the skeleton shimmer (already reduced-motion-guarded in the shared `Skeleton`) and the `.btn` color transition (token `--t-fast`); no new keyframes needed.

### 4.2 Shared token addition — `.btn-success` in `tokens.css`
Add a global success button variant, a sibling to the existing `.btn-danger`. Global (not module-scoped) because "the success green we have for live" is a reusable affordance and `--success` is already a first-class token in both themes.

**Foreground is theme-aware — do not hardcode near-white.** The two themes' `--success` fills sit at very different lightness:
- light: `--success: oklch(0.55 0.10 150)` (dark green) → near-white text passes AA;
- dark: `--success: oklch(0.72 0.13 150)` (light green) → near-white text is below AA 4.5:1.

This is the same mid-lightness-fill problem the codebase already solved for the warning verdict segment (`.verdict-picker__segment--selected[data-verdict='request-changes']` uses `color: oklch(0.18 0 0)` dark ink on `--warning`). Mirror it:
```css
.btn-success { background: var(--success); color: oklch(0.99 0 0); border-color: var(--success); }
.btn-success:hover:not(:disabled) { filter: brightness(0.92); }
[data-theme="dark"] .btn-success { color: oklch(0.18 0 0); } /* dark ink on the light dark-theme green */
```
**Both foregrounds must be measured against their theme's `--success` fill (1px-canvas technique — `getComputedStyle` returns authored oklch) and confirmed ≥ 4.5:1 before merge.** If either fails, adjust that theme's foreground (not the shared `--success` token, which other surfaces depend on). This is a hard gate in §7, not advisory.

### 4.3 SparkIcon in the title — shared `Modal` touch
`Modal.title` is typed `string` and rendered as `<h2 id={titleId} className="modal-title">{title}</h2>` — the `<h2>` is the `aria-labelledby` target. An icon cannot be passed through the `string` prop. Chosen mechanism: **add an optional `titleIcon?: React.ReactNode` prop** to `Modal`. Additive and opt-in — every current caller passes no `titleIcon`, so no existing modal changes.

Two implementation details the Modal layer owns (so the contract is enforced, not caller-dependent):

1. **`aria-hidden` is applied by Modal, not the caller.** Modal wraps the node: `<span aria-hidden="true">{titleIcon}</span>`, placed before the title text inside the `<h2>`. This guarantees the icon never contributes to the dialog's accessible name regardless of what the caller passes — so `aria-labelledby` → `<h2>` still resolves to exactly the `title` string. (`SparkIcon` already ships `aria-hidden="true"`; the wrapper makes the guarantee unconditional for any future caller.) Document the contract in the prop's JSDoc.
2. **Vertical alignment.** Add `display: flex; align-items: center; gap: var(--s-2)` to `.modal-title` so the inline SVG centers against the text instead of sitting on the baseline. This is backward-compatible for text-only titles (a flex container with one text child renders identically). No per-modal `.titleRow` class is needed.

*Alternative considered:* widen `title` to `React.ReactNode` and pass `<><SparkIcon/>Enable Live AI</>`. Rejected — it makes the accessible-name contract implicit (a caller could pass icon-only JSX and silently break the dialog name) and forces every reader of `ModalProps` to reason about node-vs-string. The dedicated `titleIcon` prop keeps `title` a guaranteed string and documents intent.

`EgressConsentModal` passes `titleIcon={<SparkIcon />}` and `align="center"`; `title` stays the literal string `"Enable Live AI"`.

### 4.4 Files touched
- `frontend/src/components/Settings/EgressConsentModal.tsx` — JSX restructure (callout, error box, skeleton, button classes), pass `align`/`titleIcon`. No logic change.
- `frontend/src/components/Settings/EgressConsentModal.module.css` — new.
- `frontend/src/components/Modal/Modal.tsx` — add optional `titleIcon` prop, rendered inside an `aria-hidden` wrapper before the title (additive).
- `frontend/src/styles/tokens.css` — add `.btn-success` (with the dark-theme foreground override); add `display: flex; align-items: center; gap: var(--s-2)` to `.modal-title`.

## 5. Testing

### 5.1 Existing tests must stay green unchanged
- `EgressConsentModal.test.tsx` — 5 cases (loading→disclosure, fail-closed, accept→onAccept, dismiss-mid-POST guard, submit-error retry). All key off accessible names / visible text that this design preserves — including the recipient/dataCategory element constraint in §3.3 and the submit-error sibling placement in §3.5. **The existing 5 cases need no edits**; if any selector breaks, that is a regression signal, not a test to "fix." (New cases are *added* per §5.2 — that is not an edit to the existing ones.)
- `e2e/ai-live-consent.spec.ts` — happy path + decline. Both key off `dialog` name "Enable Live AI" and button names "Enable Live" / "Decline", all preserved.

### 5.2 New coverage
- Unit: assert the SparkIcon renders and the dialog's accessible name is still exactly "Enable Live AI". Assert via `getByRole('dialog', { name: 'Enable Live AI' })` (the accname algorithm, which respects `aria-hidden`) — **not** raw `h2.textContent` — so the test actually catches a future non-hidden `titleIcon`. Guards §3.2 + §4.3.
- Unit: assert the egress callout and the recipient/data-category content render in the loaded state (cheap structural check that the restyle didn't drop disclosure content).
- These are light additions; the consent *behavior* is already covered and is not re-tested.

### 5.3 Visual verification (gated)
- Playwright screenshots of all three states (loaded / loading / error) in **both** themes, posted to the PR for the B1 visual record, per the standing visual-verification workflow.
- If a parity/visual baseline spec covers this modal, regenerate the Linux baseline via the CI artifact (don't hand-author).

## 6. Risks / edge cases

- **Accessible-name regression** — the single highest-value invariant; covered by §5.2 and the existing e2e. The `titleIcon` prop is `aria-hidden` specifically to protect it.
- **Contrast on `--success` fill** — *resolved in §4.2* by a theme-aware foreground (near-white in light, dark ink in dark, mirroring the warning verdict segment). Both pairings are a hard measure-and-confirm gate in §7.
- **`.btn-success` blast radius** — new global class; grep confirms no existing `.btn-success` consumer, so the addition is purely additive.
- **Color-only signaling** — the warning callout pairs the amber hue with a triangle glyph and explicit text; the error box pairs danger hue with a glyph and text; the Decline/Enable buttons carry text labels. No state is conveyed by color alone.

## 7. Definition of done
- Modal matches the signed-off mockup in both themes (all three states). *(Mockup of record: `disclosure-final.html` in the brainstorm session dir — gitignored under `.superpowers/`; the committed visual record is the PR's B1 screenshots, not the HTML file.)*
- All four scope-guarded behaviors verified unchanged.
- **`.btn-success` foreground measured ≥ 4.5:1 against `--success` in BOTH themes** (1px-canvas technique). Blocking — a failing ratio stops the merge.
- The five existing `EgressConsentModal.test.tsx` cases pass with no edits to their logic; the new §5.2 assertions added as separate cases.
- e2e `ai-live-consent.spec.ts` (happy path + decline) green without edits.
- Visual screenshots (loaded / loading / error × light / dark) posted to the PR; owner B1 visual confirmation.
- Pre-push checklist (lint + prettier + `tsc -b` + vitest + build) run verbatim before push.
