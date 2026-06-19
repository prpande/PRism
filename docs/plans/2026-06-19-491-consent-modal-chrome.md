# #491 Egress-Consent Modal Chrome — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the "Enable Live AI" egress-consent modal (`EgressConsentModal`) to match PRism's design language — centered card, AI spark in the title, warning-accented egress callout, outline→fill red Decline, solid green Enable Live — without altering any consent behavior.

**Architecture:** Keep the shared `Modal` shell (focus-trap/Esc/`defaultFocus`/`aria-labelledby` preserved). Add one additive opt-in `titleIcon` prop to `Modal`. Add one global `.btn-success` button variant to `tokens.css`. Restyle `EgressConsentModal`'s body via a new CSS module, restructuring JSX only — the consent state machine (`accept()`, `openRef`, the four states) is copied verbatim.

**Tech Stack:** React + Vite + TypeScript, CSS Modules + design tokens (`tokens.css`), vitest + Testing Library, Playwright (visual).

## Global Constraints

- **Scope guard (verbatim from spec §1):** do NOT change the disclosure-version POST, the open-ref guard against committing Live after a mid-POST dismissal, the failure/retry handling, or the truthful disclosure content. JSX/CSS only.
- **Accessible name invariant:** the dialog's accessible name must remain exactly `"Enable Live AI"`; button names exactly `"Decline"` and `"Enable Live"`. Asserted by `e2e/ai-live-consent.spec.ts`.
- **Existing tests unchanged:** the 5 existing `EgressConsentModal.test.tsx` cases and the 2 e2e cases pass with no edits to their logic.
- **WCAG AA gate:** `.btn-success` foreground measured ≥ 4.5:1 against `--success` in BOTH themes before merge (blocking).
- **No color-only signaling:** every status pairs hue with a glyph + text.
- **Pre-push checklist** (development-process.md) run verbatim: lint + prettier + `tsc -b` + vitest + build.
- All test/build commands run via the local `node_modules/.bin` binaries, never `npx`; run prettier/eslint via the real binary (rtk proxy masks output).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `frontend/src/components/Modal/Modal.tsx` | Shared dialog shell | Add optional `titleIcon` prop, rendered in an `aria-hidden` wrapper |
| `frontend/src/components/Modal/Modal.test.tsx` | Modal unit tests | Add `titleIcon` rendering + accessible-name case |
| `frontend/src/styles/tokens.css` | Global tokens + component classes | Add `.btn-success` (+ dark-theme fg); add flex to `.modal-title` |
| `frontend/src/components/Settings/EgressConsentModal.tsx` | The consent modal | JSX restructure; pass `titleIcon`/`align`; submitting affordance. No logic change |
| `frontend/src/components/Settings/EgressConsentModal.module.css` | Modal-specific styles | New file |
| `frontend/src/components/Settings/EgressConsentModal.test.tsx` | Modal unit tests | Add 2 new cases (existing 5 untouched) |

---

## Task 1: `Modal.titleIcon` prop + `.modal-title` flex

**Files:**
- Modify: `frontend/src/components/Modal/Modal.tsx`
- Modify: `frontend/src/styles/tokens.css:819-824` (`.modal-title`)
- Test: `frontend/src/components/Modal/Modal.test.tsx`

**Interfaces:**
- Produces: `Modal` accepts `titleIcon?: React.ReactNode`. Modal wraps it in `<span aria-hidden="true">…</span>` before the title text inside the existing `<h2 className="modal-title">`. Text-only callers (no `titleIcon`) render identically to today.

- [ ] **Step 1: Write the failing test**

Add to `Modal.test.tsx` (uses the file's existing `render`/`screen` imports from `@testing-library/react`):

```tsx
it('renders a decorative titleIcon without changing the dialog accessible name', () => {
  render(
    <Modal open title="Enable Live AI" titleIcon={<span>DECOR</span>} onClose={() => {}}>
      <p>body</p>
    </Modal>,
  );
  // The icon node is rendered…
  expect(screen.getByText('DECOR')).toBeInTheDocument();
  // …but it is aria-hidden, so the dialog's accessible name is still exactly the title.
  expect(screen.getByRole('dialog', { name: 'Enable Live AI' })).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Modal/Modal.test.tsx -t "decorative titleIcon"`
Expected: FAIL — `titleIcon` prop not yet supported (icon text not rendered, or it pollutes the name).

- [ ] **Step 3: Add the prop to `ModalProps` and render it**

In `Modal.tsx`, add to the `ModalProps` interface (after `title`):

```tsx
  /**
   * Optional decorative leading glyph for the title (e.g. an AI spark). Modal
   * wraps it in an aria-hidden span so it NEVER contributes to the dialog's
   * accessible name (aria-labelledby resolves to this <h2>). Callers do not
   * need to set aria-hidden themselves.
   */
  titleIcon?: React.ReactNode;
```

Add `titleIcon` to the destructured params:

```tsx
export function Modal({
  open,
  title,
  titleIcon,
  onClose,
  defaultFocus = 'primary',
  disableEscDismiss = false,
  role = 'dialog',
  align = 'top',
  children,
}: ModalProps) {
```

Replace the `<h2>` render:

```tsx
        <h2 id={titleId} className="modal-title">
          {titleIcon != null && <span aria-hidden="true">{titleIcon}</span>}
          {title}
        </h2>
```

- [ ] **Step 4: Add flex to `.modal-title`**

In `tokens.css`, replace the `.modal-title` rule (currently lines 819-824):

```css
.modal-title {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin: 0 0 var(--s-3);
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-1);
}
```

(Backward-compatible: a flex container with a single text child renders identically to the previous block layout.)

- [ ] **Step 5: Run the test, verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Modal/Modal.test.tsx`
Expected: PASS (new case + all existing Modal cases).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/Modal/Modal.tsx frontend/src/components/Modal/Modal.test.tsx frontend/src/styles/tokens.css
git commit -m "feat(#491): add Modal.titleIcon prop + flex modal-title for leading glyph"
```

---

## Task 2: `.btn-success` token variant

**Files:**
- Modify: `frontend/src/styles/tokens.css` (after the `.btn-danger` block, ~line 553)

**Interfaces:**
- Produces: global `.btn-success` class — solid green fill, theme-aware foreground (near-white in light, dark ink in dark), `filter: brightness(0.92)` hover. Composes with the global `.btn` base.

- [ ] **Step 1: Add the class**

In `tokens.css`, immediately after the `.btn-danger:hover` rule (line 553), insert:

```css
.btn-success { background: var(--success); color: oklch(0.99 0 0); border-color: var(--success); }
.btn-success:hover:not(:disabled) { filter: brightness(0.92); }
/* Dark-theme --success is a light green (oklch 0.72); near-white text fails AA
   on it, so flip to dark ink — mirroring the warning verdict segment. */
[data-theme="dark"] .btn-success { color: oklch(0.18 0 0); }
```

- [ ] **Step 2: Verify it compiles (no unit test — CSS)**

Run: `cd frontend && node_modules/.bin/tsc -b`
Expected: PASS (no TS impact; sanity check the build graph). Contrast is verified live in Task 4 (the blocking AA gate).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(#491): add .btn-success button variant (theme-aware fg)"
```

---

## Task 3: Restyle `EgressConsentModal` (CSS module + JSX restructure)

**Files:**
- Create: `frontend/src/components/Settings/EgressConsentModal.module.css`
- Modify: `frontend/src/components/Settings/EgressConsentModal.tsx`
- Test: `frontend/src/components/Settings/EgressConsentModal.test.tsx`

**Interfaces:**
- Consumes: `Modal` (`titleIcon`, `align` from Task 1), `.btn-success` (Task 2), `SparkIcon` (`../Ai/SparkIcon`), `Spinner` (`../Spinner`), `Skeleton` (`../Skeleton/Skeleton`).
- Produces: the restyled modal. Public props (`open`, `onAccept`, `onDecline`) and all consent logic unchanged.

- [ ] **Step 1: Write the new module CSS**

Create `EgressConsentModal.module.css`:

```css
.lead {
  margin: 0 0 var(--s-2);
  line-height: 1.55;
}

.callout {
  margin: var(--s-3) 0;
  padding: var(--s-4);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-left: 3px solid var(--warning);
  border-radius: var(--radius-3);
}
.calloutHead {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  color: var(--text-1);
  line-height: 1.5;
}
.calloutIcon {
  flex: 0 0 auto;
  margin-top: 1px;
  color: var(--warning-fg);
}
.recipient {
  font-weight: 600;
}

.dataList {
  list-style: none;
  margin: var(--s-3) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-1);
}
.dataItem {
  position: relative;
  padding-left: var(--s-4);
  color: var(--text-2);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.dataItem::before {
  content: '';
  position: absolute;
  left: 4px;
  top: 0.62em;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--text-3);
}

.errBox {
  display: flex;
  align-items: flex-start;
  gap: var(--s-2);
  /* Symmetric vertical margin: `.modal-actions` has no top margin, so a top-only
     margin would butt the error box directly against the buttons. */
  margin: var(--s-3) 0;
  padding: var(--s-3);
  background: var(--danger-soft);
  border: 1px solid var(--danger);
  border-radius: var(--radius-2);
  color: var(--danger-fg);
  font-size: var(--text-sm);
  line-height: 1.5;
}
.errIcon {
  flex: 0 0 auto;
  margin-top: 1px;
}

.skeletonCallout {
  margin: var(--s-3) 0;
  padding: var(--s-4);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-left: 3px solid var(--border-2);
  border-radius: var(--radius-3);
}

/* Decline: composer-discard semantics — neutral outline at rest, soft-red fill
   on hover. Mirrors `.composer-frame .composer-discard` without the frame dep. */
.declineBtn {
  border: 1px solid var(--border-2);
  background: var(--surface-1);
  color: var(--danger-fg);
}
.declineBtn:hover:not(:disabled) {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger-fg);
}

/* Reserve width so the at-rest "Enable Live" → submitting "spinner + Enabling…"
   swap doesn't reflow the button (and shift Decline). 7.5rem comfortably covers
   both states; confirm no clipping in Task 4. */
.enableBtn {
  min-width: 7.5rem;
}
```

- [ ] **Step 2: Write the failing tests (2 new cases)**

Append to `EgressConsentModal.test.tsx` inside the existing `describe` block (reuses the file's `disclosure` fixture and imports):

```tsx
  it('renders the AI spark in the title without altering the dialog name', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    // The spark icon is aria-hidden, so the dialog name is still exactly the title.
    expect(screen.getByRole('dialog', { name: 'Enable Live AI' })).toBeInTheDocument();
  });

  it('renders the egress callout with recipient and each data category', async () => {
    vi.spyOn(api, 'getEgressDisclosure').mockResolvedValue(disclosure);
    render(<EgressConsentModal open onAccept={vi.fn()} onDecline={vi.fn()} />);
    // Recipient stays in its own element (exact-match selectors depend on this).
    expect(await screen.findByText('Anthropic, via the Claude Code CLI')).toBeInTheDocument();
    for (const c of disclosure.dataCategories) {
      expect(screen.getByText(c)).toBeInTheDocument();
    }
  });
```

- [ ] **Step 3: Run the new tests, verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Settings/EgressConsentModal.test.tsx -t "spark|egress callout"`
Expected: FAIL — spark not in title yet / callout markup not present.

- [ ] **Step 4: Rewrite `EgressConsentModal.tsx`**

Replace the file with (logic copied verbatim — only imports, the `Modal` props, and the JSX body change):

```tsx
import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal/Modal';
import { Skeleton } from '../Skeleton/Skeleton';
import { Spinner } from '../Spinner';
import { SparkIcon } from '../Ai/SparkIcon';
import { getEgressDisclosure, postAiConsent, type EgressDisclosure } from '../../api/aiConsent';
import styles from './EgressConsentModal.module.css';

interface Props {
  open: boolean;
  onAccept: () => void;
  onDecline: () => void;
}

// Decorative inline glyphs (aria-hidden) — no central icon set in this repo.
function WarningTriangleIcon({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <path d="M8 1.75 14.5 13.5H1.5L8 1.75Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 6.25V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}
function CircleAlertIcon({ className }: { className?: string }) {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" className={className}>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 4.75V8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="10.75" r="0.85" fill="currentColor" />
    </svg>
  );
}

export function EgressConsentModal({ open, onAccept, onDecline }: Props) {
  const [disclosure, setDisclosure] = useState<EgressDisclosure | null>(null);
  const [failed, setFailed] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Tracks whether the modal is still open. A consent POST can outlive a dismissal
  // (Escape / Decline while it is in flight); without this guard the late resolution
  // would call onAccept() and commit Live despite the user's dismissal.
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setDisclosure(null);
    setFailed(false);
    setSubmitError(false);
    setSubmitting(false);
    getEgressDisclosure()
      .then((d) => {
        if (!cancelled) setDisclosure(d);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const accept = async () => {
    if (!disclosure) return;
    setSubmitting(true);
    setSubmitError(false);
    try {
      await postAiConsent(disclosure.disclosureVersion);
      if (!openRef.current) return; // dismissed mid-POST — don't commit Live
      onAccept();
    } catch {
      if (openRef.current) setSubmitError(true); // consent POST failure (incl. 409) — retry allowed (not an LLM call)
    } finally {
      if (openRef.current) setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title="Enable Live AI"
      titleIcon={<SparkIcon />}
      align="center"
      onClose={onDecline}
      defaultFocus="cancel"
      role="dialog"
    >
      {failed ? (
        <div className={styles.errBox} role="alert" aria-live="assertive">
          <CircleAlertIcon className={styles.errIcon} />
          <span>Couldn&apos;t load the data-sharing disclosure. Close and try again.</span>
        </div>
      ) : !disclosure ? (
        <div aria-busy="true">
          <span className="sr-only" aria-live="polite">
            Loading data-sharing disclosure…
          </span>
          <Skeleton height={14} />
          <Skeleton height={14} width="70%" />
          <div className={styles.skeletonCallout}>
            <Skeleton height={14} width="55%" />
            <Skeleton height={12} width="80%" />
            <Skeleton height={12} width="45%" />
          </div>
        </div>
      ) : (
        <div>
          <p className={styles.lead}>
            Live AI generates a real, diff-grounded summary of this pull request.
          </p>
          <div className={styles.callout}>
            <div className={styles.calloutHead}>
              <WarningTriangleIcon className={styles.calloutIcon} />
              <span>
                Sent off your device to{' '}
                <strong className={styles.recipient}>{disclosure.recipient}</strong>:
              </span>
            </div>
            <ul className={styles.dataList}>
              {disclosure.dataCategories.map((c) => (
                <li key={c} className={styles.dataItem}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      {submitError && (
        <div className={styles.errBox} role="alert" aria-live="assertive">
          <CircleAlertIcon className={styles.errIcon} />
          <span>Couldn&apos;t enable Live AI. Please try again.</span>
        </div>
      )}
      <div className="modal-actions row gap-2">
        <button
          type="button"
          className={`btn ${styles.declineBtn}`}
          data-modal-role="cancel"
          onClick={onDecline}
        >
          Decline
        </button>
        <button
          type="button"
          className={`btn btn-success ${styles.enableBtn}`}
          data-modal-role="primary"
          onClick={() => void accept()}
          disabled={!disclosure || failed || submitting}
        >
          {submitting ? (
            <>
              <Spinner size="sm" decorative />
              Enabling…
            </>
          ) : (
            'Enable Live'
          )}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 5: Run the full `EgressConsentModal` suite, verify all pass**

Run: `cd frontend && node_modules/.bin/vitest run src/components/Settings/EgressConsentModal.test.tsx`
Expected: PASS — 7 cases (5 original + 2 new). If any original case fails, the JSX restructure broke an invariant (e.g. submit-error nesting, recipient element) — fix the component, not the test.

- [ ] **Step 6: Format + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/Settings/EgressConsentModal.tsx src/components/Settings/EgressConsentModal.module.css src/components/Settings/EgressConsentModal.test.tsx
cd .. && git add frontend/src/components/Settings/EgressConsentModal.tsx frontend/src/components/Settings/EgressConsentModal.module.css frontend/src/components/Settings/EgressConsentModal.test.tsx
git commit -m "feat(#491): restyle egress-consent modal chrome (callout, buttons, spark, states)"
```

---

## Task 4: Verify — contrast gate, full suite, visual screenshots, PR

**Files:** none (verification + delivery)

- [ ] **Step 1: Run `/simplify` on the diff**

Run the `superpowers:simplify` pass over the three changed source files; apply any simplifications that hold up, re-run the suite, commit separately if it edits the tree.

- [ ] **Step 2: Pre-push checklist (verbatim)**

```bash
cd frontend
node_modules/.bin/prettier --check "src/**/*.{ts,tsx,css}"
node_modules/.bin/eslint src
node_modules/.bin/tsc -b
node_modules/.bin/vitest run
npm run build
```
Expected: all green. (Use the real binaries, not the rtk proxy, to avoid masked lint/format output.)

- [ ] **Step 3: Measure the WCAG AA contrast gate (BLOCKING)**

Launch the app (`run.ps1 -Reset None --no-browser`), open the consent modal, and in DevTools console measure the rendered `.btn-success` foreground vs background via the 1px-canvas technique (`getComputedStyle().color` returns authored oklch, so paint each into a 1px canvas and read back rgb). Confirm ≥ 4.5:1 in **both** light and dark themes. If a theme fails, adjust that theme's `.btn-success` foreground in `tokens.css` (not the shared `--success` token), re-run Step 2, re-measure. Do the same sanity check for the `.declineBtn` rest-state `--danger-fg` on `--surface-1`.

- [ ] **Step 4: Capture visual screenshots (both themes × 3 states)**

Drive the modal with Playwright and screenshot loaded / loading / error in light and dark (6 PNGs). Loading state: throttle or pause the disclosure fetch. Error state: route `/api/ai/egress-disclosure` to fail. Host the PNGs on a throwaway `review-assets/pr-<n>` branch and embed the raw URLs in the PR (per the visual-verification workflow).

- [ ] **Step 5: Check for an affected visual/parity baseline spec**

```
grep -rn "EgressConsentModal\|Enable Live AI\|egress" frontend/e2e
```
If a visual/parity baseline snapshots this modal, regenerate the Linux baseline from the CI artifact (do not hand-author); otherwise note "no baseline covers this modal" in the PR.

- [ ] **Step 6: Sync main, raise the PR via pr-autopilot**

Sync latest `V2` into the branch (fetch → is-ancestor → merge-if-behind → re-verify), then use the `pr-autopilot` skill to open the PR against **`V2`**. PR body: link #491 (bare `#491`, no closing keyword — gated), the `## Proof` section (tests + contrast measurement + the 6 screenshots), and the ce-doc-review dispositions. Hold for owner B1 visual sign-off before merge.

---

## Self-Review

**Spec coverage:**
- §3.1 centered shell → Task 3 (`align="center"`). ✓
- §3.2 spark title + accessible-name invariant → Task 1 (prop) + Task 3 (pass `titleIcon`, test). ✓
- §3.3 egress callout + recipient/dataCategory element constraint → Task 3 (`.callout`, `<strong>`, per-`<li>`) + tests. ✓
- §3.4 skeleton incl. callout-shaped block → Task 3 (`.skeletonCallout`). ✓
- §3.5 error box, submit-error stays sibling after the ternary → Task 3 (markup placement) + existing submit-error test. ✓
- §3.6 Decline outline→fill, Enable solid green, submitting affordance, focus ring → Task 2 + Task 3. ✓
- §4.2 `.btn-success` theme-aware fg → Task 2; AA gate → Task 4 Step 3. ✓
- §4.3 titleIcon aria-hidden wrapper + `.modal-title` flex → Task 1. ✓
- §5 tests → Tasks 1 & 3; §5.3 visual → Task 4. ✓
- §7 DoD (contrast gate, pre-push, screenshots, no-edit existing tests) → Task 4. ✓

**Placeholder scan:** none — every code/CSS step shows full content.

**Type consistency:** `titleIcon?: React.ReactNode` defined in Task 1, consumed in Task 3 as `titleIcon={<SparkIcon />}`. `.btn-success` defined Task 2, used Task 3. `Spinner` `size`/`decorative` props match the real component signature. `Skeleton` `height`/`width` props match existing usage.
