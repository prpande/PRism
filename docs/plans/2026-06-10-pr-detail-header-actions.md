# PR-detail header action-area redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the crowded PR-detail header action row into one stateful `ReviewActionButton` (verdict-colored fill, `*`-pending marker, caret menu), move Ask AI to an App-level right-margin pull-tab, and make Open-in-GitHub icon-only — with **zero change** to submit/verdict/recovery behavior.

**Architecture:** A pure derivation module (`reviewActionState.ts`) computes the button face + menu model from session/prState/flags; a thin React component renders it and wires to PrHeader's **existing** handlers (`patchVerdict`, `setDialogOpen`, `onResume`, `handlePillDiscard`/`pillDiscardModalOpen`, `onDiscardAllDrafts`). The pull-tab is an App-level singleton beside `<AskAiDrawer />`, gated by `useAiGate` + the `parsePrRefFromPathname` route predicate, riding the drawer's edge when open.

**Tech Stack:** React 18 + TypeScript + Vite, CSS Modules, vitest + React Testing Library, Playwright (e2e/visual). Design tokens in `frontend/src/styles/tokens.css`.

**Spec:** `docs/specs/2026-06-10-pr-detail-header-actions-design.md`. Read §4 (state derivation), §5 (pull-tab), §7 (preservation invariants) before starting.

**Behavior-preservation guardrails (do not violate):**
- Resume and discard-pending are **never** gated by `submitDisabledReason` (matches today's always-shown `SubmitInProgressBadge`/pill). Only the **non-pending** fresh-submit main action is gated.
- The menu's "Discard pending review" item is **suppressed while `dialogOpen`** (preserves the `!dialogOpen` mutual-exclusion).
- Pending main-click fires `onResume` (not `onOpenSubmit`); non-pending fires `setDialogOpen(true)`.
- While `inSubmitFlow`, **both** the main button and the chevron menu are disabled.
- **"Discard all drafts" MUST route through `DiscardAllConfirmationModal`** — today `DiscardAllDraftsButton` owns that modal, so removing the button removes the confirmation. The modal is **lifted into `PrHeader`** (Task 6); the menu item opens it, never calls `discardAllDrafts()` directly. A direct call = silent destructive bulk-discard.
- `onResume` always submits the **last-persisted** `session.draftVerdict` (PrHeader.tsx:245), not a verdict just picked in the open pending menu (that path is an async `patch`+refetch). Co-locating "change verdict" and "Resume" in one menu does not change that.
- No edits to the submit pipeline, `SubmitDialog`, `useSubmit`, `sendPatch`, or the modals' internals.

---

## File structure

**Create**
- `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts` — pure derivation (face + menu model). No React/DOM.
- `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.tsx` — button + chevron + menu.
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.module.css`
- `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`
- `frontend/src/components/AskAiDrawer/AskAiPullTab.tsx`
- `frontend/src/components/AskAiDrawer/AskAiPullTab.module.css`
- `frontend/src/components/AskAiDrawer/AskAiPullTab.test.tsx`

**Modify**
- `frontend/src/components/PrDetail/PrHeader.tsx` — replace the 7-control `.prActions` block; drop now-unused imports.
- `frontend/src/components/PrDetail/OpenInGitHubButton.tsx` — icon-only.
- `frontend/src/components/AskAiDrawer/AskAiDrawer.module.css` — expose the drawer width as a CSS var the tab reads.
- `frontend/src/App.tsx` — mount `<AskAiPullTab />` beside `<AskAiDrawer />`.

---

## Task 1: Derivation — fill + label

**Files:**
- Create: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// reviewActionState.test.ts
import { describe, expect, it } from 'vitest';
import { deriveFace } from './reviewActionState';
import type { ReviewSessionDto } from '../../../api/types';

const baseSession: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

const inputs = (over: Partial<ReviewSessionDto> = {}, rest = {}) => ({
  session: { ...baseSession, ...over },
  prState: 'open' as const,
  headShaDrift: false,
  validatorResults: [],
  inSubmitFlow: false,
  dialogOpen: false,
  ...rest,
});

describe('deriveFace — fill + label', () => {
  it('default (no verdict, open) → accent / Submit review', () => {
    const f = deriveFace(inputs());
    expect(f.fill).toBe('accent');
    expect(f.label).toBe('Submit review');
  });
  it('approve drafted → approve fill / Approve', () => {
    const f = deriveFace(inputs({ draftVerdict: 'approve' }));
    expect(f.fill).toBe('approve');
    expect(f.label).toBe('Approve');
  });
  it('request-changes drafted → request-changes fill / Request changes', () => {
    const f = deriveFace(inputs({ draftVerdict: 'request-changes' }));
    expect(f.fill).toBe('request-changes');
    expect(f.label).toBe('Request changes');
  });
  it('closed/merged → secondary / Drafts', () => {
    const f = deriveFace({ ...inputs(), prState: 'merged' });
    expect(f.fill).toBe('secondary');
    expect(f.label).toBe('Drafts');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`
Expected: FAIL — `deriveFace` not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// reviewActionState.ts
import type { DraftVerdict, ReviewSessionDto, ValidatorResult } from '../../../api/types';
import type { PrState } from '../PrHeader';

export type ReviewActionFill = 'accent' | 'approve' | 'request-changes' | 'comment' | 'secondary';

export interface ReviewActionInputs {
  session: ReviewSessionDto;
  prState: PrState;
  headShaDrift: boolean;
  validatorResults: ValidatorResult[];
  inSubmitFlow: boolean;
  dialogOpen: boolean;
}

export interface ReviewActionFace {
  fill: ReviewActionFill;
  label: string;
  pending: boolean;
  needsReconfirm: boolean;
  mainAction: 'submit' | 'resume' | 'none';
  mainDisabled: boolean;
  mainDisabledReason: string | null;
  frozen: boolean;
  pendingTooltip: string | null;
}

const VERDICT_LABEL: Record<DraftVerdict, string> = {
  approve: 'Approve',
  'request-changes': 'Request changes',
  comment: 'Comment',
};

export function deriveFace(i: ReviewActionInputs): ReviewActionFace {
  const { session, prState } = i;
  const isClosedOrMerged = prState !== 'open';
  const verdict = session.draftVerdict;
  const pending = session.pendingReviewId !== null;

  const fill: ReviewActionFill = isClosedOrMerged
    ? 'secondary'
    : verdict ?? 'accent'; // 'approve' | 'request-changes' | 'comment' map 1:1 to fill ids

  const label = isClosedOrMerged
    ? 'Drafts'
    : verdict
      ? VERDICT_LABEL[verdict]
      : pending
        ? 'Resume review'
        : 'Submit review';

  // Filled in by Task 2 — stubbed so the module type-checks.
  return {
    fill,
    label,
    pending,
    needsReconfirm: false,
    mainAction: 'submit',
    mainDisabled: false,
    mainDisabledReason: null,
    frozen: false,
    pendingTooltip: null,
  };
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `npx vitest run src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts
git commit -m "feat(#291): reviewActionState fill+label derivation"
```

---

## Task 2: Derivation — pending, needs-reconfirm, main action & disabled

**Files:**
- Modify: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
// append to reviewActionState.test.ts
import { deriveFace as _df } from './reviewActionState';

describe('deriveFace — pending / reconfirm / action / disabled', () => {
  it('pending + verdict → pending true, label keeps verdict word, action=resume', () => {
    const f = deriveFace(inputs({ draftVerdict: 'comment', pendingReviewId: 'PR_1' }));
    expect(f.pending).toBe(true);
    expect(f.label).toBe('Comment');
    expect(f.mainAction).toBe('resume');
    expect(f.pendingTooltip).toMatch(/pending review on github/i);
  });
  it('pending + no verdict → label Resume review, action=resume', () => {
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1' }));
    expect(f.label).toBe('Resume review');
    expect(f.mainAction).toBe('resume');
  });
  it('resume is NEVER disabled by submitDisabledReason (preserve today)', () => {
    // empty session + pending would trip reason (a) for a fresh submit, but resume must stay enabled
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1' }));
    expect(f.mainDisabled).toBe(false);
    expect(f.mainAction).toBe('resume');
  });
  it('non-pending empty session → submit disabled, reason (a) directs to the ▾ menu', () => {
    const f = deriveFace(inputs());
    expect(f.mainAction).toBe('submit');
    expect(f.mainDisabled).toBe(true);
    // exact directional copy (spec §4.1) — NOT the generic submitDisabledReason string
    expect(f.mainDisabledReason).toBe('Pick a verdict using the ▾ menu, or add a comment.');
  });
  it('pending + needs-reconfirm → resume stays ENABLED (resume is never gated), face signal shown', () => {
    const f = deriveFace(inputs({ pendingReviewId: 'PR_1', draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }));
    expect(f.mainAction).toBe('resume');
    expect(f.mainDisabled).toBe(false); // corrects the spec §4.1 example: resume is never gated
    expect(f.needsReconfirm).toBe(true);
  });
  it('needs-reconfirm flagged from draftVerdictStatus', () => {
    const f = deriveFace(inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }));
    expect(f.needsReconfirm).toBe(true);
    expect(f.mainDisabled).toBe(true); // reason (c) for the non-pending submit path
  });
  it('inSubmitFlow → frozen true, mainDisabled true', () => {
    const f = deriveFace({ ...inputs({ draftVerdict: 'approve' }), inSubmitFlow: true });
    expect(f.frozen).toBe(true);
    expect(f.mainDisabled).toBe(true);
  });
  it('closed/merged → mainAction none, mainDisabled true', () => {
    const f = deriveFace({ ...inputs(), prState: 'closed' });
    expect(f.mainAction).toBe('none');
    expect(f.mainDisabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify new tests fail** (`npx vitest run …reviewActionState.test.ts`). Expected: the new assertions fail (stubbed fields).

- [ ] **Step 3: Replace the stubbed return in `reviewActionState.ts`**

```ts
// reviewActionState.ts — add import and replace the return block in deriveFace
import { submitDisabledReason } from '../SubmitButton';
// ...inside deriveFace, after computing fill/label:
  const needsReconfirm = session.draftVerdictStatus === 'needs-reconfirm';
  const mainAction: ReviewActionFace['mainAction'] = isClosedOrMerged
    ? 'none'
    : pending
      ? 'resume'
      : 'submit';

  // Resume + discard are never gated (today's SubmitInProgressBadge/pill aren't).
  // Only the fresh-submit path consults submitDisabledReason.
  const rawReason =
    mainAction === 'submit'
      ? submitDisabledReason(session, i.headShaDrift, i.validatorResults)
      : null;
  // Spec §4.1: with the inline verdict picker gone, reason (a) must direct the
  // user to the caret menu. submitDisabledReason returns this exact string for (a).
  const REASON_A = 'Pick a verdict or add a comment, reply, or summary before submitting.';
  const submitReason =
    rawReason === REASON_A ? 'Pick a verdict using the ▾ menu, or add a comment.' : rawReason;
  const frozen = i.inSubmitFlow;
  const mainDisabled = isClosedOrMerged || frozen || submitReason !== null;

  return {
    fill,
    label,
    pending,
    needsReconfirm,
    mainAction,
    mainDisabled,
    mainDisabledReason: submitReason,
    frozen,
    pendingTooltip: pending ? 'Pending review on GitHub — not yet submitted' : null,
  };
```

- [ ] **Step 4: Run, verify pass** (`npx vitest run …reviewActionState.test.ts`). Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts
git commit -m "feat(#291): reviewActionState pending/reconfirm/action/disabled"
```

---

## Task 3: Derivation — the caret-menu model

**Files:**
- Modify: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
// append to reviewActionState.test.ts
import { deriveMenu } from './reviewActionState';

const ids = (sections: ReturnType<typeof deriveMenu>) => sections.flatMap((s) => s.items.map((it) => it.id));

describe('deriveMenu', () => {
  it('normal verdict menu: 3 verdicts + submit, checked reflects draftVerdict', () => {
    const m = deriveMenu(inputs({ draftVerdict: 'approve' }));
    expect(ids(m)).toEqual(['verdict:approve', 'verdict:request-changes', 'verdict:comment', 'submit']);
    const approve = m.flatMap((s) => s.items).find((it) => it.id === 'verdict:approve');
    expect(approve?.checked).toBe(true);
  });
  it('pending menu: resume + verdicts + discard-pending', () => {
    const m = deriveMenu(inputs({ draftVerdict: 'approve', pendingReviewId: 'PR_1' }));
    expect(ids(m)).toContain('resume');
    expect(ids(m)).toContain('discard-pending');
  });
  it('pending + dialogOpen → discard-pending suppressed (invariant)', () => {
    const m = deriveMenu({ ...inputs({ draftVerdict: 'approve', pendingReviewId: 'PR_1' }), dialogOpen: true });
    expect(ids(m)).not.toContain('discard-pending');
  });
  it('closed/merged → discard-all only', () => {
    const m = deriveMenu({ ...inputs({ draftComments: [{} as never] }), prState: 'merged' });
    expect(ids(m)).toEqual(['discard-all']);
  });
  it('closed/merged with no drafts → empty menu', () => {
    const m = deriveMenu({ ...inputs(), prState: 'closed' });
    expect(ids(m)).toEqual([]);
  });
  it('needs-reconfirm → reconfirm note in the verdict section', () => {
    const m = deriveMenu(inputs({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }));
    expect(ids(m)).toContain('reconfirm-note');
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Add menu types + `deriveMenu`**

```ts
// reviewActionState.ts — append
export interface ReviewActionMenuItem {
  id: string;
  label: string;
  kind: 'verdict' | 'action' | 'danger' | 'note'; // 'note' = non-interactive label row
  verdict?: DraftVerdict;
  checked?: boolean;
}
export interface ReviewActionMenuSection {
  header?: string;
  items: ReviewActionMenuItem[];
}

const VERDICT_ITEMS = (current: DraftVerdict | null): ReviewActionMenuItem[] =>
  (Object.keys(VERDICT_LABEL) as DraftVerdict[]).map((v) => ({
    id: `verdict:${v}`,
    label: VERDICT_LABEL[v],
    kind: 'verdict',
    verdict: v,
    checked: current === v,
  }));

const RECONFIRM_NOTE: ReviewActionMenuItem = {
  id: 'reconfirm-note',
  label: 'Verdict needs re-confirmation',
  kind: 'note',
};

export function deriveMenu(i: ReviewActionInputs): ReviewActionMenuSection[] {
  const { session, prState, dialogOpen } = i;
  const isClosedOrMerged = prState !== 'open';
  const pending = session.pendingReviewId !== null;
  const needsReconfirm = session.draftVerdictStatus === 'needs-reconfirm';
  const hasDrafts = session.draftComments.length > 0 || session.draftReplies.length > 0;
  // Spec §4.5: needs-reconfirm is surfaced in TWO places — the button face (Task 4)
  // and a menu note. Re-selecting the verdict re-confirms it (existing patchVerdict).
  const note: ReviewActionMenuItem[] = needsReconfirm ? [RECONFIRM_NOTE] : [];

  if (isClosedOrMerged) {
    return hasDrafts
      ? [{ items: [{ id: 'discard-all', label: 'Discard all drafts', kind: 'danger' }] }]
      : [];
  }

  if (pending) {
    const items: ReviewActionMenuItem[] = [
      { id: 'resume', label: 'Resume & submit…', kind: 'action' },
      ...note,
      ...VERDICT_ITEMS(session.draftVerdict),
    ];
    // Mutual-exclusion invariant: only one discard-pending path live at a time.
    const danger: ReviewActionMenuSection[] = dialogOpen
      ? []
      : [{ items: [{ id: 'discard-pending', label: 'Discard pending review', kind: 'danger' }] }];
    return [{ header: 'Pending review on GitHub', items }, ...danger];
  }

  return [
    { header: 'Verdict', items: [...note, ...VERDICT_ITEMS(session.draftVerdict)] },
    { items: [{ id: 'submit', label: 'Submit review…', kind: 'action' }] },
  ];
}
```

- [ ] **Step 4: Run, verify pass.**

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.ts frontend/src/components/PrDetail/ReviewActionButton/reviewActionState.test.ts
git commit -m "feat(#291): reviewActionState caret-menu model"
```

---

## Task 4: `ReviewActionButton` — button face

**Files:**
- Create: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.tsx`
- Create: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.module.css`
- Test: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// ReviewActionButton.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActionButton } from './ReviewActionButton';
import type { ReviewSessionDto } from '../../../api/types';

const session = (over: Partial<ReviewSessionDto> = {}): ReviewSessionDto => ({
  draftVerdict: null, draftVerdictStatus: 'draft', draftComments: [], draftReplies: [],
  iterationOverrides: [], pendingReviewId: null, pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} }, ...over,
});

const handlers = () => ({
  onPatchVerdict: vi.fn(), onOpenSubmit: vi.fn(), onResume: vi.fn(),
  onDiscardPending: vi.fn(), onDiscardAllDrafts: vi.fn(),
});

const props = (over = {}, h = handlers()) => ({
  session: session(), prState: 'open' as const, headShaDrift: false,
  validatorResults: [], inSubmitFlow: false, dialogOpen: false, ...h, ...over,
});

describe('ReviewActionButton — face', () => {
  it('default renders "Submit review", main disabled with reason (a) tooltip', () => {
    render(<ReviewActionButton {...props()} />);
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Submit review');
    expect(main).toBeDisabled();
    expect(main).toHaveAttribute('title', expect.stringMatching(/pick a verdict/i));
  });
  it('approve drafted → label Approve, enabled, click opens submit', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve' }) }, h)} />);
    await userEvent.click(screen.getByTestId('review-action-main'));
    expect(h.onOpenSubmit).toHaveBeenCalledOnce();
  });
  it('pending → trailing asterisk + pending tooltip, click resumes', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'comment', pendingReviewId: 'PR_1' }) }, h)} />);
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Comment*');
    expect(main).toHaveAttribute('title', expect.stringMatching(/pending review on github/i));
    await userEvent.click(main);
    expect(h.onResume).toHaveBeenCalledOnce();
  });
  it('needs-reconfirm → warning glyph present', () => {
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }) })} />);
    expect(screen.getByTestId('review-action-reconfirm')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement component (face + chevron stub) and CSS**

```tsx
// ReviewActionButton.tsx
import { useRef, useState } from 'react';
import type { DraftVerdict } from '../../../api/types';
import { deriveFace, deriveMenu, type ReviewActionInputs } from './reviewActionState';
import { ReviewActionMenu } from './ReviewActionMenu'; // added in Task 5
import styles from './ReviewActionButton.module.css';

export interface ReviewActionButtonProps extends ReviewActionInputs {
  onPatchVerdict: (v: DraftVerdict | null) => void;
  onOpenSubmit: () => void;
  onResume: () => void;
  onDiscardPending: () => void;
  onDiscardAllDrafts: () => void;
}

function Chevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

export function ReviewActionButton(props: ReviewActionButtonProps) {
  const face = deriveFace(props);
  const [menuOpen, setMenuOpen] = useState(false);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const closeMenu = () => { setMenuOpen(false); chevronRef.current?.focus(); };

  const onMainClick = () => {
    if (face.mainAction === 'submit') props.onOpenSubmit();
    else if (face.mainAction === 'resume') props.onResume();
    else setMenuOpen((v) => !v); // closed/merged: main opens the menu
  };

  return (
    <div className={styles.root} data-testid="review-action">
      <button
        type="button"
        data-testid="review-action-main"
        className={`${styles.main} ${styles[`fill-${face.fill}`]}`}
        disabled={face.mainDisabled && face.mainAction !== 'none'}
        // closed/merged: mainAction==='none' → button is clickable (opens the menu),
        // so it must NOT advertise aria-disabled. Match the `disabled` predicate.
        aria-disabled={face.mainDisabled && face.mainAction !== 'none'}
        title={face.mainDisabledReason ?? face.pendingTooltip ?? undefined}
        onClick={face.mainDisabled && face.mainAction !== 'none' ? undefined : onMainClick}
      >
        {face.needsReconfirm && (
          <span className={styles.reconfirm} data-testid="review-action-reconfirm" aria-hidden="true">⚠</span>
        )}
        <span className={styles.label}>
          {face.label}
          {face.pending && <span className={styles.asterisk} aria-hidden="true">*</span>}
        </span>
      </button>
      <button
        ref={chevronRef}
        type="button"
        data-testid="review-action-chevron"
        className={`${styles.chevron} ${styles[`fill-${face.fill}`]}`}
        aria-label="Review actions"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        disabled={face.frozen}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <Chevron />
      </button>
      {menuOpen && !face.frozen && (
        <ReviewActionMenu
          sections={deriveMenu(props)}
          onClose={closeMenu}
          onSelect={(id, verdict) => {
            if (id.startsWith('verdict:')) {
              if (!verdict) return; // mis-route guard — fail loud rather than silently clearing
              // re-select clears (toggle), preserving {draftVerdict:null}
              props.onPatchVerdict(props.session.draftVerdict === verdict ? null : verdict);
            } else if (id === 'submit') props.onOpenSubmit();
            else if (id === 'resume') props.onResume();
            else if (id === 'discard-pending') props.onDiscardPending();
            else if (id === 'discard-all') props.onDiscardAllDrafts();
            else if (id === 'reconfirm-note') return; // non-interactive label
            setMenuOpen(false);
          }}
        />
      )}
    </div>
  );
}
```

```css
/* ReviewActionButton.module.css */
.root { position: relative; display: inline-flex; }

.main, .chevron {
  height: 30px; font-family: var(--font-sans); font-size: var(--text-sm); font-weight: 500;
  border: 1px solid transparent; display: inline-flex; align-items: center; gap: 6px;
  white-space: nowrap; user-select: none; cursor: pointer; line-height: 1;
}
.main {
  /* min-width must hold the widest label incl. the asterisk ("Request changes*").
     STARTING VALUE ONLY — verify in Task 11's no-reflow check (both density modes).
     If verdict-switch reflows, measure the rendered "Request changes*" width in
     Geist 13px (comfortable + compact) and set this so the content never grows. */
  min-width: 16ch;
  justify-content: center; padding: 0 var(--s-3);
  border-radius: var(--radius-2) 0 0 var(--radius-2);
}
.chevron { padding: 0 8px; border-radius: 0 var(--radius-2) var(--radius-2) 0; border-left-color: rgba(0,0,0,0.18); }
.main:disabled, .chevron:disabled { opacity: 0.5; cursor: not-allowed; }

.fill-accent { background: var(--accent); color: var(--accent-text); }
.fill-approve { background: var(--success); color: var(--accent-text); }
.fill-request-changes { background: var(--warning); color: oklch(0.18 0 0); }
.fill-comment { background: var(--info); color: var(--accent-text); }
.fill-secondary { background: var(--surface-1); color: var(--text-1); border-color: var(--border-2); }

.label { display: inline-flex; align-items: baseline; gap: 1px; }
/* `.asterisk` and `.reconfirm` intentionally set NO color — they inherit the
   button's on-fill text color (--accent-text, or the hardcoded dark ink on the
   warning fill). That is the same fg/bg pairing the verdict LABEL uses, which is
   already AA (issue #123). Verify in Task 12 against every fill, both themes. */
.asterisk { font-weight: 600; }
.reconfirm { font-size: 12px; }
```

- [ ] **Step 4: Run, verify pass** (`npx vitest run …ReviewActionButton.test.tsx`). NOTE: Task 5 adds `ReviewActionMenu`; until then, stub it so Task 4 compiles — create `ReviewActionMenu.tsx` returning `null`:

```tsx
// ReviewActionMenu.tsx (stub, fleshed out in Task 5)
import type { ReviewActionMenuSection } from './reviewActionState';
import type { DraftVerdict } from '../../../api/types';
export function ReviewActionMenu(_: {
  sections: ReviewActionMenuSection[];
  onClose: () => void;
  onSelect: (id: string, verdict?: DraftVerdict) => void;
}) { return null; }
```

Expected: PASS (face tests don't open the menu).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/ReviewActionButton/
git commit -m "feat(#291): ReviewActionButton face + chevron"
```

---

## Task 5: `ReviewActionMenu` — accessible flat menu

**Files:**
- Create: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionMenu.tsx` (replaces Task 4's `null` stub)
- Test: `frontend/src/components/PrDetail/ReviewActionButton/ReviewActionButton.test.tsx`

(Focus-return on Escape is already wired in Task 4: the parent passes `onClose={closeMenu}`, which refocuses `chevronRef`. This task only fleshes out the menu body — do **not** re-add `chevronRef`.)

- [ ] **Step 1: Add failing tests**

```tsx
// append to ReviewActionButton.test.tsx
describe('ReviewActionButton — menu', () => {
  it('chevron opens a role=menu; picking a verdict patches it', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({}, h)} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Approve' }));
    expect(h.onPatchVerdict).toHaveBeenCalledWith('approve');
  });
  it('re-selecting the checked verdict clears it (null)', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve' }) }, h)} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Approve/ }));
    expect(h.onPatchVerdict).toHaveBeenCalledWith(null);
  });
  it('Escape closes the menu and returns focus to the chevron', async () => {
    render(<ReviewActionButton {...props()} />);
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chevron).toHaveFocus();
  });
  it('ArrowDown moves focus to the next item and wraps last→first', async () => {
    render(<ReviewActionButton {...props()} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus(); // first item focused on open
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    // wrap: ArrowUp from the first item goes to the last
    items[0].focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[items.length - 1]).toHaveFocus();
  });
  it('Tab closes the menu (does not trap focus)', async () => {
    render(<ReviewActionButton {...props()} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    await userEvent.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('frozen (inSubmitFlow) disables the chevron — no menu', async () => {
    render(<ReviewActionButton {...props({ inSubmitFlow: true, session: session({ draftVerdict: 'approve' }) })} />);
    expect(screen.getByTestId('review-action-chevron')).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run, verify fail** (stub renders null → no menu).

- [ ] **Step 3: Implement `ReviewActionMenu`**

```tsx
// ReviewActionMenu.tsx
import { useEffect, useRef } from 'react';
import type { DraftVerdict } from '../../../api/types';
import type { ReviewActionMenuSection } from './reviewActionState';
import styles from './ReviewActionButton.module.css';

interface Props {
  sections: ReviewActionMenuSection[];
  onClose: () => void;
  onSelect: (id: string, verdict?: DraftVerdict) => void;
}

export function ReviewActionMenu({ sections, onClose, onSelect }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const items = sections.flatMap((s) => s.items);

  useEffect(() => {
    // focus first item on open
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      // Tab closes the menu without trapping focus (ARIA APG menu pattern) —
      // do NOT preventDefault, so focus flows naturally past the control.
      else if (e.key === 'Tab') onClose();
    };
    const onDocClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocClick);
    };
  }, [onClose]);

  // Empty menu (closed/merged with no drafts) → close via effect, NOT during
  // render (calling a parent state-setter in render is a React anti-pattern).
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const moveFocus = (from: HTMLElement, dir: 1 | -1) => {
    const all = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    const idx = all.indexOf(from as HTMLButtonElement);
    const next = all[(idx + dir + all.length) % all.length];
    next?.focus();
  };

  if (items.length === 0) return null; // close handled by the effect above

  return (
    <div ref={ref} role="menu" className={styles.menu} data-testid="review-action-menu">
      {sections.map((section, si) => (
        <div key={si} className={styles.section}>
          {section.header && <div className={styles.menuHeader}>{section.header}</div>}
          {section.items.map((it) =>
            it.kind === 'note' ? (
              // Non-interactive label row (e.g. needs-reconfirm note) — not a menuitem.
              <div key={it.id} className={styles.note} data-testid="review-action-note">
                {it.label}
              </div>
            ) : (
              <button
                key={it.id}
                type="button"
                role="menuitem"
                className={`${styles.menuItem} ${it.kind === 'danger' ? styles.danger : ''}`}
                onClick={() => onSelect(it.id, it.verdict)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(e.currentTarget, 1); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(e.currentTarget, -1); }
                }}
              >
                {it.kind === 'verdict' && <span className={`${styles.swatch} ${styles[`sw-${it.verdict}`]}`} />}
                <span>{it.label}</span>
                {it.checked && <span className={styles.check} aria-hidden="true">✓</span>}
              </button>
            ),
          )}
        </div>
      ))}
    </div>
  );
}
```

Append the menu CSS (focus-return is already wired in Task 4 — nothing to change in `ReviewActionButton.tsx`):

```css
/* append to ReviewActionButton.module.css */
.note { padding: 6px 9px; font-size: var(--text-xs); color: var(--warning-fg); }
.menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 30;
  min-width: 240px; background: var(--surface-1); border: 1px solid var(--border-2);
  border-radius: var(--radius-3); padding: 6px; box-shadow: var(--shadow-3);
}
.menuHeader { font-size: var(--text-2xs); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-3); padding: 4px 9px 6px; }
.menuItem {
  display: flex; align-items: center; gap: 9px; width: 100%; padding: 7px 9px;
  border: none; background: transparent; color: var(--text-1); font: inherit;
  font-size: var(--text-sm); border-radius: var(--radius-2); cursor: pointer; text-align: left;
}
.menuItem:hover, .menuItem:focus-visible { background: var(--surface-3); outline: none; }
.danger { color: var(--danger-fg); }
.check { margin-left: auto; color: var(--success-fg); }
.swatch { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.sw-approve { background: var(--success); } .sw-request-changes { background: var(--warning); } .sw-comment { background: var(--info); }
.section + .section { border-top: 1px solid var(--border-1); margin-top: 5px; padding-top: 5px; }
```

- [ ] **Step 4: Run, verify pass** (`npx vitest run …ReviewActionButton.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/ReviewActionButton/
git commit -m "feat(#291): accessible flat ReviewActionMenu"
```

---

## Task 6: Wire `ReviewActionButton` into `PrHeader`

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (the `.prActions` block at ~464-513; imports at 20-27)
- Test: `frontend/src/components/PrDetail/PrHeader.test.tsx`

- [ ] **Step 1: Add a failing integration test** to `PrHeader.test.tsx` (follow the file's existing render helper / providers):

```tsx
it('renders the unified ReviewActionButton instead of the old picker+submit cluster', () => {
  renderPrHeader({ session: makeSession({ draftVerdict: 'approve' }), prState: 'open' });
  expect(screen.getByTestId('review-action')).toBeInTheDocument();
  expect(screen.queryByText('Submit review')).not.toBeNull(); // label space; adjust to helper
  // old controls gone:
  expect(screen.queryByRole('group', { name: 'Review verdict' })).not.toBeInTheDocument();
});
```
(Use the test file's existing `renderPrHeader`/`makeSession` helpers — match their names. If absent, mirror the setup already used by other PrHeader tests.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Replace the `.prActions` block.** In `PrHeader.tsx`, replace lines ~464-513 (`{!loading && (<div className={styles.prActions}> … </div>)}`) with:

```tsx
{!loading && (
  <div className={styles.prActions}>
    <OpenInGitHubButton href={htmlUrl} />
    <ReviewActionButton
      session={session ?? EMPTY_SESSION}
      prState={prState}
      headShaDrift={headShaDrift}
      validatorResults={validatorResults}
      inSubmitFlow={inSubmitFlow}
      dialogOpen={dialogOpen}
      onPatchVerdict={patchVerdict}
      onOpenSubmit={() => setDialogOpen(true)}
      onResume={onResume}
      onDiscardPending={() => { setPillDiscardError(null); setPillDiscardModalOpen(true); }}
      onDiscardAllDrafts={() => setDiscardAllModalOpen(true)}
    />
  </div>
)}
```

**Lift the discard-all confirmation modal into `PrHeader`** (it used to live inside `DiscardAllDraftsButton`, which this task removes — without this, "Discard all drafts" would fire with no confirmation). Add the open state near the other PrHeader state (~line 190):

```tsx
const [discardAllModalOpen, setDiscardAllModalOpen] = useState(false);
```

Mount the modal alongside the pill's modal at the bottom of the JSX (after the `DiscardPendingReviewConfirmationModal` at ~line 578). It computes its counts from `session` exactly as `DiscardAllDraftsButton` did:

```tsx
{session && (
  <DiscardAllConfirmationModal
    open={discardAllModalOpen}
    prState={prState}
    threadCount={
      session.draftComments.filter((d) => !(d.filePath === null && d.lineNumber === null)).length
    }
    replyCount={session.draftReplies.length}
    hasSummary={
      (session.draftComments.find((d) => d.filePath === null && d.lineNumber === null)?.bodyMarkdown ?? '').trim().length > 0
    }
    hasPendingReview={!!session.pendingReviewId}
    onConfirm={() => { setDiscardAllModalOpen(false); onDiscardAllDrafts(); }}
    onCancel={() => setDiscardAllModalOpen(false)}
  />
)}
```

Add `import { DiscardAllConfirmationModal } from './DiscardAllConfirmationModal';` to PrHeader. `onDiscardAllDrafts` (PrHeader.tsx:356, the API call) is unchanged — the modal's `onConfirm` calls it.

Update imports: remove `VerdictPicker`, `SubmitButton`, `SubmitInProgressBadge`, `DiscardAllDraftsButton`, `AskAiButton` from the import block; add `import { ReviewActionButton } from './ReviewActionButton/ReviewActionButton';`. Keep `OpenInGitHubButton`, `DiscardPendingReviewConfirmationModal`, `ImportedDraftsBanner`, `SubmitDialog`. Keep `toggleAskAi` removal for Task 9 (the `useAskAiDrawer` hook + `toggleAskAi` are no longer used here once `AskAiButton` is gone — delete the `const { toggle: toggleAskAi } = useAskAiDrawer();` line and the import). The `DiscardPendingReviewConfirmationModal` for the pill stays mounted lower in the JSX (gated on `pillDiscardModalOpen`) — unchanged.

- [ ] **Step 3b: Narrow-width layout contract (spec §3).** In `PrHeader.module.css`, ensure the title/meta block can truncate and the action cluster holds its size. Confirm/add: the `.pr-meta` (or the `.prHeaderTop` title column) has `min-width: 0` (so the title truncates instead of pushing the cluster off-screen), and `.prActions` is `flex: none` (already is — verify). Add the "Open-in-GitHub drops first" floor:

```css
/* PrHeader.module.css — below the floor where title+cluster can't coexist,
   shed the secondary icon first (the action stays reachable via Open-in-GitHub
   on the row when space returns; the primary review control never shrinks). */
@media (max-width: 720px) {
  .prActions :global(.open-in-github-button) { display: none; }
}
```
(720px is a starting floor — confirm against the running app in Task 12; the split-button's `min-width` is the hard constraint that must always fit.)

- [ ] **Step 4: Run the PrHeader suite + typecheck**

Run: `npx vitest run src/components/PrDetail/PrHeader.test.tsx`
Run: `npx tsc -b`
Expected: PASS; no unused-import / type errors. Fix any test that asserted on the removed controls (update to the new `review-action` testids).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/PrHeader.tsx frontend/src/components/PrDetail/PrHeader.test.tsx
git commit -m "feat(#291): wire ReviewActionButton into PrHeader, drop old cluster"
```

---

## Task 7: `OpenInGitHubButton` → icon-only

**Files:**
- Modify: `frontend/src/components/PrDetail/OpenInGitHubButton.tsx`
- Test: `frontend/src/components/PrDetail/OpenInGitHubButton.test.tsx` (create if absent)

- [ ] **Step 1: Failing test**

```tsx
// OpenInGitHubButton.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OpenInGitHubButton } from './OpenInGitHubButton';

describe('OpenInGitHubButton', () => {
  it('renders icon-only with an accessible name and no visible text', () => {
    render(<OpenInGitHubButton href="https://github.com/o/r/pull/1" />);
    const link = screen.getByRole('link', { name: 'Open in GitHub' });
    expect(link).toHaveAttribute('aria-label', 'Open in GitHub');
    expect(link).not.toHaveTextContent('Open in GitHub');
  });
  it('renders nothing without href', () => {
    const { container } = render(<OpenInGitHubButton href={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement** — replace the returned `<a>` body:

```tsx
  return (
    <a
      className="btn-icon open-in-github-button"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label="Open in GitHub"
      title="Open in GitHub"
      data-testid="open-in-github-button"
      onClick={handleClick}
    >
      <GitHubMark />
    </a>
  );
```
(Drop the `btn btn-secondary` classes and the "Open in GitHub" text node. `.btn-icon` is the 30×30 token class.)

- [ ] **Step 4: Run, verify pass.** Update any e2e/test selector that matched on the button's text (grep `Open in GitHub` across `src` and `e2e`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OpenInGitHubButton.tsx frontend/src/components/PrDetail/OpenInGitHubButton.test.tsx
git commit -m "feat(#291): Open-in-GitHub icon-only"
```

---

## Task 8: `AskAiPullTab` component

**Files:**
- Create: `frontend/src/components/AskAiDrawer/AskAiPullTab.tsx`
- Create: `frontend/src/components/AskAiDrawer/AskAiPullTab.module.css`
- Test: `frontend/src/components/AskAiDrawer/AskAiPullTab.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
// AskAiPullTab.test.tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AskAiPullTab } from './AskAiPullTab';

const mocks = vi.hoisted(() => ({ gate: vi.fn(), drawer: vi.fn() }));
vi.mock('../../hooks/useAiGate', () => ({ useAiGate: () => mocks.gate() }));
vi.mock('../../contexts/AskAiDrawerContext', () => ({ useAskAiDrawer: () => mocks.drawer() }));

const renderAt = (path: string) =>
  render(<MemoryRouter initialEntries={[path]}><AskAiPullTab /></MemoryRouter>);

describe('AskAiPullTab', () => {
  it('hidden when AI gate is off', () => {
    mocks.gate.mockReturnValue(false);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/pr/o/r/1');
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });
  it('hidden off a PR-detail route even when gated', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/inbox');
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });
  it('shown on PR-detail when gated; toggles the drawer', async () => {
    const toggle = vi.fn();
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle });
    renderAt('/pr/o/r/1');
    const tab = screen.getByRole('button', { name: 'Ask AI' });
    expect(tab).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(tab);
    expect(toggle).toHaveBeenCalledOnce();
  });
  it('open state → aria-expanded true and label Close', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: true, toggle: vi.fn() });
    renderAt('/pr/o/r/1');
    const tab = screen.getByRole('button', { name: 'Close' });
    expect(tab).toHaveAttribute('aria-expanded', 'true');
  });
  it('renders a recognizable icon at rest (present for touch users with no hover label)', () => {
    mocks.gate.mockReturnValue(true);
    mocks.drawer.mockReturnValue({ isOpen: false, toggle: vi.fn() });
    renderAt('/pr/o/r/1');
    expect(screen.getByTestId('ask-ai-pull-tab').querySelector('.ai-icon')).toBeInTheDocument();
  });
});
```
(Confirm the PR-detail path shape with `parsePrRefFromPathname` — use a path it accepts; adjust `/pr/o/r/1` to the real route if different.)

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**

```tsx
// AskAiPullTab.tsx
import { useEffectiveLocation } from '../../hooks/useEffectiveLocation';
import { useAiGate } from '../../hooks/useAiGate';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';
import styles from './AskAiPullTab.module.css';

export function AskAiPullTab() {
  const aiEnabled = useAiGate('composerAssist');
  const { isOpen, toggle } = useAskAiDrawer();
  const { pathname } = useEffectiveLocation();
  const onPrDetail = parsePrRefFromPathname(pathname) !== null;

  if (!aiEnabled || !onPrDetail) return null;

  const label = isOpen ? 'Close' : 'Ask AI';
  return (
    <button
      type="button"
      className={`${styles.tab} ${isOpen ? styles.open : ''}`}
      aria-label={label}
      aria-expanded={isOpen}
      title={label}
      data-testid="ask-ai-pull-tab"
      onClick={toggle}
    >
      <span className={styles.label}>{label}</span>
      <span className="ai-icon" aria-hidden="true">✨</span>
    </button>
  );
}
```

```css
/* AskAiPullTab.module.css */
.tab {
  position: fixed;
  /* anti-collision: parked below the Files-tab toolbar band and outside the diff
     interaction zone. STARTING VALUE — measure `.filesTabToolbar` bottom edge
     (one-row AND forced-wrap) in the Task 9 smoke and confirm via the Task 11
     anti-collision e2e before trusting it. Do not assume 160px is correct. */
  top: 160px;
  right: 0;
  z-index: 49; /* under the drawer (50) so the open drawer covers transit */
  display: flex; align-items: center; gap: 0;
  background: var(--surface-1); border: 1px solid var(--border-2); border-right: none;
  border-radius: var(--radius-3) 0 0 var(--radius-3);
  padding: 9px 8px; color: var(--accent); cursor: pointer;
  box-shadow: var(--shadow-2);
  transition: right 220ms var(--ease-out), background var(--t-fast) var(--ease-out);
}
.open { right: var(--ask-ai-drawer-width, 400px); background: var(--surface-3); }
.label { max-width: 0; overflow: hidden; white-space: nowrap; opacity: 0;
  font-size: var(--text-sm); font-weight: 500; color: var(--text-1);
  transition: max-width 180ms var(--ease-out), opacity 180ms var(--ease-out), margin 180ms var(--ease-out); }
.tab:hover .label, .tab:focus-visible .label, .open .label { max-width: 80px; opacity: 1; margin-right: 7px; }
.ai-icon { font-size: 18px; line-height: 1; }
```

- [ ] **Step 4: Run, verify pass** (`npx vitest run …AskAiPullTab.test.tsx`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer/AskAiPullTab.tsx frontend/src/components/AskAiDrawer/AskAiPullTab.module.css frontend/src/components/AskAiDrawer/AskAiPullTab.test.tsx
git commit -m "feat(#291): AskAiPullTab component"
```

---

## Task 9: Expose drawer width + mount the tab at App level

**Files:**
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.module.css` (the `.drawer` rule, ~line 2-8)
- Modify: `frontend/src/App.tsx` (~line 180)
- Test: `frontend/src/App.tsx` is covered by existing integration tests; add a focused render check if a suitable harness exists, else rely on AskAiPullTab unit tests + e2e.

- [ ] **Step 1: Expose the width as a token the tab reads.** In `AskAiDrawer.module.css`, add a shared custom property and reference it so the tab's `--ask-ai-drawer-width` matches:

```css
/* in :root or the drawer's nearest stable scope — add to tokens.css base block */
/* tokens.css (base :root) */
  --ask-ai-drawer-width: 400px;
```
and change `.drawer { width: var(--ask-ai-drawer-width); }` (was hardcoded `400px`). Keep the `max-width: 100vw` line.

- [ ] **Step 2: Mount the tab.** In `App.tsx`, add `<AskAiPullTab />` immediately after `<AskAiDrawer />`:

```tsx
      <AskAiDrawer />
      <AskAiPullTab />
      <DrawerEffects />
```
Add the import: `import { AskAiPullTab } from './components/AskAiDrawer/AskAiPullTab';`

- [ ] **Step 3: Typecheck + full frontend unit run**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected: green. Fix any test that referenced the removed `AskAiButton` in the header (it now lives nowhere in `PrHeader`; the trigger is the tab).

- [ ] **Step 4: Measure the anti-collision anchor.** Launch via `serve-detached.ps1`, open a PR detail (Files tab) with AI enabled. In the console, read `document.querySelector('.files-tab-toolbar').getBoundingClientRect().bottom` at the default width AND at a narrow width that forces the toolbar to wrap to two rows. Set the tab's `top` to `max(bottom) + ~12px clearance`. Replace the `top: 160px` starting value with the measured number. Then confirm: tab visible below the toolbar (both layouts); click opens the drawer and the tab slides to the drawer's edge reading "Close"; navigating to the inbox hides the tab; the tab doesn't sit over diff content / the #214 sticky scrollbar / an open inline composer.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer/ frontend/src/styles/tokens.css frontend/src/App.tsx
git commit -m "feat(#291): mount AskAiPullTab at App level; drawer-width token; measured anchor"
```

---

## Task 10: Remove the now-dead `AskAiButton` usage & dead code sweep

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx` (verify no `AskAiButton`/`toggleAskAi` refs remain)
- `AskAiButton.tsx` stays in the tree only if still imported elsewhere — grep first.

- [ ] **Step 1:** `grep -rn "AskAiButton" frontend/src` — if the only references are its own file + test, delete `AskAiButton.tsx` and `AskAiButton.test.tsx`; otherwise leave them. Confirm `SubmitInProgressBadge`, `DiscardAllDraftsButton`, header `VerdictPicker` import are gone from `PrHeader.tsx` but the components still exist for the dialog (`VerdictPicker`) or are genuinely unused (badge/discard-button — delete their files + tests **only** if grep shows no other importer).
- [ ] **Step 2:** `cd frontend && npx tsc -b && npx vitest run` — green.
- [ ] **Step 3:** `npx eslint . && npx prettier --check .` (use `rtk proxy npx prettier --check .` to avoid the masked exit code). Fix any unused-var/format issues.
- [ ] **Step 4:** Commit

```bash
git add -A frontend/src
git commit -m "chore(#291): remove dead header-action components"
```

---

## Task 11: e2e + visual coverage and baseline regen

**Files:**
- Modify/Create: the PR-detail Playwright spec(s) under `frontend/e2e/` (match existing naming, e.g. `pr-detail-*.spec.ts`)

- [ ] **Step 1: Add e2e assertions** for: the unified button label/fill per verdict (set verdict via the menu); the asterisk appears only on a pending fixture; the pull-tab resting/hover/open (rides to the drawer edge); anti-collision — assert the tab's bounding box does not intersect the Files-tab toolbar (one-row and a forced wrapped/narrow width), the diff content column, the #214 sticky scrollbar, or an open inline composer. Use `boundingBox()` intersection checks.

```ts
// sketch
const tab = page.getByTestId('ask-ai-pull-tab');
const gear = page.getByTestId('diff-settings-trigger'); // confirm real testid
const a = await tab.boundingBox(); const b = await gear.boundingBox();
expect(rectsIntersect(a!, b!)).toBe(false);
```

- [ ] **Step 2: Add a no-reflow check** — capture the button's `boundingBox().width`, switch verdict via the menu, assert width unchanged; repeat under `[data-density="compact"]`.

- [ ] **Step 3: Run e2e locally** (per `.ai/docs/parallel-agent-testing.md` private port/dataDir). Triage real failures.

- [ ] **Step 4: Regenerate visual baselines.** Header reflow ripples into PR-detail full-page baselines. Regenerate Linux baselines from the CI artifact (per `reference_regen_linux_parity_baseline_via_ci_artifact`) and win32 locally; verify the diffs are intended (the new cluster + tab), commit the baselines.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e
git commit -m "test(#291): e2e + visual coverage for the header redesign"
```

---

## Task 12: Full pre-push verification

- [ ] **Step 1:** `cd frontend && npx tsc -b && npx vitest run` — all green.
- [ ] **Step 2:** `npx eslint . && rtk proxy npx prettier --check .` — clean (rtk masks prettier's exit code; use the proxy form).
- [ ] **Step 3:** Backend unchanged, but run `dotnet test` once to confirm no incidental break (foreground, ≥5-min timeout).
- [ ] **Step 4:** Manual B1 capture — screenshot the header cluster (default / each verdict / pending / closed-merged / **needs-reconfirm with the ⚠ face signal**) and the pull-tab (rest / hover / open) in **light and dark**, for the PR's `## Proof` and the owner B1 gate. In the same pass, **eyeball the `*` and `⚠` contrast** against each fill (approve/request-changes/comment/accent) in both themes — confirm AA (they inherit the label's on-fill color, so a pass on the label is a pass here, but verify the warning fill explicitly).
- [ ] **Step 5:** Commit any final baseline/lint fixes.

```bash
git add -A
git commit -m "chore(#291): pre-push verification fixes"
```

---

## Self-review checklist (completed)

- **Spec coverage:** §3 cluster → Tasks 1-6; §4.1 axes → Tasks 1-3 (incl. compound pending×reconfirm test); §4.2 asterisk+tooltip → Tasks 2,4; §4.3 min-width/density → Task 4 CSS + Task 11 no-reflow check; §4.4 flat menu + dialogOpen suppression + clear-via-reselect → Tasks 3,5; §4.5 frozen + reconfirm parity → Tasks 2,4,5; §5 pull-tab (App mount, route+gate, open-state ride, anti-collision) → Tasks 8,9,11; §6 icon-only → Task 7; §7 preservation invariants → guardrails + Tasks 2,3,6 + Task 12 backend run; §9 a11y → Task 5; §10 testing → Tasks 1-11; §11 ACs → covered.
- **Preservation:** resume/discard never gated (Task 2); discard-pending `!dialogOpen` suppression (Task 3); pending→onResume mapping (Tasks 2,6). Corrects the spec §4.1 "pending+needs-reconfirm disabled" example — resume stays enabled to match today's ungated `SubmitInProgressBadge`.
- **Type consistency:** `deriveFace`/`deriveMenu`/`ReviewActionInputs`/`ReviewActionFace`/`ReviewActionMenuSection` names consistent across Tasks 1-5; component props (`onPatchVerdict`/`onOpenSubmit`/`onResume`/`onDiscardPending`/`onDiscardAllDrafts`) consistent Tasks 4-6.
- **Open items for B1:** pull-tab resting anchor (Task 8 `top` is a starting value — measured in Task 9 Step 4); reconfirm glyph treatment (Task 4 `⚠` — owner picks at B1); `.main` min-width (Task 4 `16ch` starting value — Task 11 no-reflow check is the backstop).

## ce-doc-review round 1 dispositions (5 personas)

Applied to the plan above:
- **Discard-all loses confirmation** (adversarial/design, conf 100 — destructive) → lifted `DiscardAllConfirmationModal` into `PrHeader`; menu opens it (Task 6).
- **Reason-(a) tooltip not directional** (design, conf 100) → override the string + exact-copy test (Task 2).
- **needs-reconfirm menu note missing** (design, conf 100) → `note` menu item + test (Task 3).
- **Narrow-width layout contract absent** (design, conf 100) → Task 6 Step 3b (title `min-width:0`, `.prActions flex:none`, drop-Open-in-GitHub `@media`).
- **`chevronRef` copy-paste trap** (adversarial, conf 100) → folded into Task 4; Task 5 prose removed.
- **`onClose()` during render** (design, conf 75) → `useEffect` (Task 5).
- **`aria-disabled` wrong on closed/merged** (adversarial/design, conf 75) → matched to the `disabled` predicate (Task 4).
- **min-width 14.5ch unmeasured** (adversarial, conf 75) → bumped to 16ch starting value + measure-in-Task-11 note (Task 4).
- **`top:160px` "verified" comment stale** (design, conf 75) → comment fixed + measurement step (Tasks 8, 9).
- **Compound pending×reconfirm test claimed but absent** (adversarial, conf 75) → added (Task 2).
- **Arrow-nav untested + Tab unhandled** (design, conf 75) → tests + Tab handler (Task 5).
- **`?? null` masks mis-route** (adversarial, conf 75) → `if (!verdict) return` guard (Task 4).
- **resume submits session verdict, not menu-picked** (adversarial, conf 75) → documented in guardrails.
- **AA contrast unverified** (design, conf 100) → `*`/`⚠` inherit the label's on-fill color (already AA); explicit B1 check (Tasks 4, 12).
- **Touch icon presence untested** (design, conf 75) → icon-presence test (Task 8).
- **Task 5 "Modify" label** (coherence, conf 100) → "Create (replaces stub)".

Verified-correct by feasibility (no change): all import paths (`../../../api/types`, `../SubmitButton`, `./parsePrRefFromPathname`), `PrState` type-only import (no runtime cycle — keep `import type`), every design token, `.btn-icon`, `GitHubMark`, `useAiGate`/`useAskAiDrawer`/`useEffectiveLocation` shapes, the `/pr/o/r/N` route parse, vitest/RTL conventions. Guardrails verified to hold: frozen↔old-idle-gate equivalence, discard-pending modal preservation, loading-gate wrapping.

Not changed (FYI only): `composerAssist` gate is wire-coupled to `aiPreview` today (matches the button it replaces); the Tasks 1-3 derivation split is intentional TDD granularity. Scope-guardian: plan is right-sized, no descope re-raised (the design scope was settled with the owner).
