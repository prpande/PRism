# Error presentation for unstyled error surfaces (#182)

**Issue:** [#182](https://github.com/prpande/PRism/issues/182) — Error messages render as unstyled white text instead of a design-system error treatment.
**Tier / Risk:** T3 (new modal abstraction + focus management + behavior change across 5 sites) · gated **B1 (UI-visual)**. No B2 risk surface (presentational + a small backward-compatible prop on the shared `Modal`).
**Worktree / branch:** `D:/src/PRism-182-error-box` · `fix/182-error-box` (iterating on open PR #192).

> **Design revision (2026-06-05, post-visual-review).** The first cut styled errors as inline/centered **boxes** (`<ErrorBox>` + `.error-screen`). Visual review rejected the *placement*: errors sitting in a corner / inline are easy to ignore. New direction (approved): page/fatal errors **pop up front-and-center as a modal, floating over a dimmed page, impossible to ignore**, with the message **and** any recovery action forming **one unit**. This document now specifies that modal approach; `<ErrorBox>` and `.error-screen` are removed. The message visual (danger tint, glyph, color) the reviewer liked is preserved inside the modal card.

## Problem

Several error states render as bare default-foreground text (white in dark theme), with no box, color, or prominence — they read as rendering bugs and are easy to miss. Two referenced CSS classes (`.pr-detail-error`, `.reload-error-banner`) were never even defined. The sites:

- `App.tsx:45` — `<div role="alert">Failed to load auth state: …</div>` — bare, full-page (replaces the LoadingScreen).
- `ErrorBoundary.tsx:27` — bare `<div role="alert">` (`<p>` + Reload button) — root crash fallback.
- `PrDetailView.tsx:313` — undefined `.pr-detail-error` — PR load failure.
- `PrTabHost.tsx:66` — bare `<div role="alert">` — invalid PR reference in the URL.
- `InboxPage.tsx:42` — `<main role="alert">` (`<p>` + Try again button) — inbox load failure.
- `PrDetailView.tsx:284` — undefined `.reload-error-banner` — dismissible reconcile notice (**banner**, not a page error — handled separately).

## Decision: an `<ErrorModal>` (alertdialog) for page/fatal errors

Introduce one `<ErrorModal>` that presents an error **front-and-center, above a dimmed backdrop**, with the message and recovery action(s) as a single card. It is a thin wrapper over the existing shared **`<Modal>`** primitive (`components/Modal/Modal.tsx`), which already provides the dimmed backdrop (`.modal-backdrop`), centered dialog, focus trap, Escape handling, initial focus, and focus restore. `ErrorModal` adds the danger treatment (leading alert glyph + danger accent) and a standard action row.

**Why reuse `<Modal>`:** the codebase already standardizes modals on it (7 consumers — Discard, HostChange, SubmitDialog, etc.). Reusing it gives correct, consistent focus management and dismissal for free, and keeps the error dialog visually consistent with every other dialog.

**One small, backward-compatible change to `Modal`:** add an optional `role?: 'dialog' | 'alertdialog'` prop, default `'dialog'`. `ErrorModal` passes `'alertdialog'` (the ARIA-correct role for "a dialog conveying an urgent message requiring response"), so assistive tech announces it assertively on open. All existing callers keep `role="dialog"` unchanged.

**Action + message as one unit:** the recovery action lives *inside* the dialog card. This is the correct pattern for an `alertdialog` (the dialog is the live region; its buttons are legitimate dialog controls) — it also resolves the earlier "button outside `role="alert"`" concern, which only applied to a bare `role="alert"`, not a dialog.

**The reconcile banner stays a banner.** `PrDetailView.tsx:284` is a transient, dismissible background-reload notice — not a fatal/page error. Making it a blocking center modal would over-interrupt the user mid-review. It migrates to the existing `.banner banner-danger` strip (defined class), unchanged from the prior cut.

**Rejected alternatives:** (1) inline/box-in-place — the rejected first cut (easy to ignore). (2) Non-blocking centered toast — front-and-center but not "impossible to ignore," and PRism's Toast is for transient success/info. (3) Universal modal for *every* error incl. the reconcile banner — over-interrupts for transient/tab-scoped notices.

### `Modal` change

`frontend/src/components/Modal/Modal.tsx`:
```tsx
export interface ModalProps {
  // …existing…
  role?: 'dialog' | 'alertdialog';   // default 'dialog'
}
```
Apply `role` to the dialog element (currently hard-coded `role="dialog"`). No other behavior change. Existing tests/consumers unaffected (default preserves current role).

### `ErrorModal` component

`frontend/src/components/ErrorModal/ErrorModal.tsx`
```tsx
interface ErrorModalProps {
  open: boolean;
  title: string;            // short headline, becomes the dialog's aria-labelledby h2
  message?: ReactNode;      // detail line (e.g. the server message)
  actions: ReactNode;       // 1–2 buttons — the recovery action(s), rendered as the card's action row
  onClose: () => void;      // invoked by Esc when dismissible (and is the close/back action)
  dismissible?: boolean;    // default false. false → Esc suppressed (fatal, no underlying app). true → Esc → onClose.
}
```
- Renders `<Modal open role="alertdialog" title={title} onClose={onClose} disableEscDismiss={!dismissible}>` with a danger-styled body: leading `aria-hidden` alert glyph + `message` + an action row holding `actions`.
- The glyph is the same inline SVG the prior `ErrorBox` used (extracted to a tiny shared `DangerGlyph` so it isn't duplicated). Danger accent via `ErrorModal.module.css` using `--danger-soft`/`--danger-fg` tokens (light + dark covered).
- Action buttons use the project button utilities (`btn btn-primary` for the primary recovery action, `btn btn-secondary` for the secondary, e.g. "Back to inbox"). Tag the primary with `data-modal-role="primary"` so `Modal` initial-focuses it.
- Purely presentational beyond `Modal`'s own hooks; safe inside `ErrorBoundary`'s fallback (no data deps, no throwing imports — `Modal` only uses `useId`/`useRef`/`useEffect`).

### Per-site migration

| Site | Dialog title | Message | Action(s) | Dismissible (Esc) |
|------|--------------|---------|-----------|-------------------|
| `App.tsx:45` | "Couldn't load auth state" | `{error.message}` | **Reload** (`window.location.reload()`) | No — fatal, nothing underneath |
| `ErrorBoundary.tsx:27` | "Something went wrong" | "The error has been logged." | **Reload** (`window.location.reload()`) | No — crashed render |
| `InboxPage.tsx:42` | "Couldn't load inbox" | (none / `{error.message}`) | **Try again** (`reload()`) | No — nothing underneath |
| `PrDetailView.tsx:313` | "Couldn't load this PR" | `{error.message}` | **Reload** (`reload()`, `data-modal-role="primary"`) + **Back to inbox** (`navigate('/')`) | Yes → onClose = Back to inbox |
| `PrTabHost.tsx:66` | "Invalid PR reference" | "The PR number must be a positive integer." | **Back to inbox** (`navigate('/')`) | Yes → onClose = Back to inbox |

Notes:
- `PrDetailView` already has `usePrDetail().reload`; `PrTabHost`/`PrDetailView` use `react-router` `useNavigate` for "Back to inbox" (`/`). Under keep-alive, navigating to `/` shows the inbox while open tabs persist.
- App/ErrorBoundary/Inbox are non-dismissible (their only escape is the action) — `dismissible={false}` so Esc can't strand the user on a blank screen.

### Group C — reconcile banner (unchanged from prior cut)

`PrDetailView.tsx:284` → `<div className="banner banner-danger" role="alert">` with the message (`flex:1`) + a styled Dismiss button, matching the sibling `BannerRefresh`/`BannerTransition` strips. No glyph (banners signal via color). Dead `.reload-error-banner` removed. Dismiss stays inside (intrinsic to a dismissible banner).

### Removed (replaced by the modal approach)

- `frontend/src/components/ErrorBox/` (component, css, test, index) — superseded by `ErrorModal`.
- `.error-screen` utility in `tokens.css` — modal centers via `.modal-backdrop`; no longer needed.
- The `.loading` extension (`flex-direction:column; gap`) in `InboxPage.module.css` — InboxPage's error state is now a modal, so `.loading` reverts to its original spinner-only rule.

## Accessibility

- `role="alertdialog"` + `aria-modal="true"` + `aria-labelledby` (the title h2) — assertive announcement on open; the action(s) are dialog controls within the labelled dialog (message + action as one accessible unit).
- Focus management inherited from `Modal`: initial focus on the primary action, Tab focus-trap, Escape (when `dismissible`), focus restored to the prior element on close.
- Non-dismissible dialogs (App/ErrorBoundary/Inbox) suppress Escape so the user can't dismiss into a blank app; the recovery action is the deliberate exit.
- The glyph is decorative (`aria-hidden`, `focusable="false"`).
- Contrast: danger token pair, confirmed in light + dark at the B1 gate.

## Testing

- **`ErrorModal.test.tsx`** (new): renders nothing when `open=false`; when open → an `alertdialog` with the title and message; renders the provided action(s); `dismissible=false` suppresses Escape (Esc does not call `onClose`); `dismissible=true` → Escape calls `onClose`; the primary action receives initial focus.
- **`Modal` test** (extend existing): `role` prop defaults to `'dialog'`; `role="alertdialog"` renders an alertdialog. Existing Modal tests stay green.
- **`ErrorBoundary.test.tsx`** (update the one added earlier): assert the fallback renders an `alertdialog` containing the message **and** the Reload button (now one unit — drop the "button outside the alert" assertion, which no longer applies to a dialog).
- **`InboxPage.test.tsx`** (update): error state renders an `alertdialog` with "Couldn't load inbox" + a "Try again" button inside it.
- **`PrDetailView.freshness.test.tsx`**: the load-error path changes from an inline `.pr-detail-error` node to the ErrorModal. Update the assertion to query the alertdialog (the prior `.pr-detail-error` class hook is retired — the test should assert the dialog + message text). Verify the reconcile-banner disambiguation still holds.
- **Parity baselines**: error paths are outside happy-path zones; re-capture only if a zone visibly moves.

## B1 visual-gate scope

Confirm in light + dark for each modal: the dimmed backdrop + centered card, danger glyph/accent, the action row (one unit), and that message-only errors (PR load, invalid ref) show a working "Back to inbox" exit. Plus a screen-reader spot-check that the dialog announces on open and focus lands on the primary action.

## Out of scope / deferrals

- D1: converge the working duplicators (`SetupForm`, `PasteUrlInput`, `DraftsTabError`) onto the design-system error treatment — follow-up after merge.
- D2: conditional parity re-capture.
- D3: `DraftsTabError` missing danger color.
- Body scroll-lock while a modal is open is not added (no existing PRism modal does; out of scope, consistency).

See `docs/specs/2026-06-05-error-box-deferrals.md`.
