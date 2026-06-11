# Shared Composer Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the ~90%-identical logic and JSX of `InlineCommentComposer` and `ReplyComposer` into a shared `useDraftComposer` hook + `ComposerActionsBar`/`ComposerModals` presentational pair + a pure `matchComposerKey` utility, with **zero behavior change**.

**Architecture:** A pure key-matcher utility (`matchComposerKey`) deduplicates the keyboard-shortcut expression shared by all three composers. A `useDraftComposer` hook owns all draft-composer state/handlers and returns three grouped slices (`{editor, actions, modals}`). Two presentational components render the byte-identical actions-bar and modals JSX. The two diff composers shrink to thin anchor-specific glue; `PrRootReplyComposer` adopts only the matcher. The discard handler drops `InlineComposer`'s dead try/catch (unreachable under `sendPatch`'s documented no-throw contract).

**Tech Stack:** React 19 + TypeScript (Vite, project-references tsconfig), Vitest + Testing Library, ESLint + Prettier.

**Spec:** `docs/specs/2026-06-11-shared-composer-core-design.md`

---

## Pre-flight (run once before Task 1)

- [ ] **Confirm the worktree frontend has a populated `node_modules`** (the worktree's `node_modules` is a junction to main; if `vitest` is missing the test commands silently no-op and a worker may hallucinate passes).

Run (from the worktree root `D:/src/PRism-326-composer-core`):
```
Test-Path frontend/node_modules/vitest
```
Expected: `True`. If `False`, run `npm ci` in the **main** checkout's `frontend/` (the junction target), then re-check. Do **not** proceed until this is `True`.

- [ ] **Baseline green:** confirm the existing composer suites pass on the branch tip before any change.

Run (from `frontend/`):
```
npx vitest run __tests__/InlineCommentComposer.test.tsx __tests__/InlineCommentComposer.postNow.test.tsx __tests__/ReplyComposer.test.tsx __tests__/ReplyComposer.postNow.test.tsx __tests__/PrRootReplyComposer.test.tsx
```
Expected: all PASS. This is the behavioral guard the refactor must preserve.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `frontend/src/components/PrDetail/Composer/matchComposerKey.ts` | Pure key-combo → shortcut matcher | Create |
| `frontend/src/components/PrDetail/Composer/matchComposerKey.test.ts` | Matcher unit tests | Create |
| `frontend/src/components/PrDetail/Composer/useDraftComposer.ts` | Shared draft-composer state + handlers; returns `{editor, actions, modals}` | Create |
| `frontend/src/components/PrDetail/Composer/useDraftComposer.test.tsx` | Hook unit tests (renderHook) | Create |
| `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` | Presentational actions bar | Create |
| `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx` | Actions-bar render + button-order test | Create |
| `frontend/src/components/PrDetail/Composer/ComposerModals.tsx` | Presentational discard + recovery modals | Create |
| `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx` | Thin glue; gains optional `ownerKey` prop | Rewrite |
| `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx` | Thin glue; gains optional `ownerKey` prop | Rewrite |
| `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx` | Adopt `matchComposerKey` in `handleKeyDown` | Modify |

Existing test files stay **unchanged** except `InlineCommentComposer.test.tsx` (Task 6 adds one button-order assertion). They are the primary behavioral guard.

---

## Task 1: `matchComposerKey` utility

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/matchComposerKey.ts`
- Test: `frontend/src/components/PrDetail/Composer/matchComposerKey.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// matchComposerKey.test.ts
import { describe, it, expect } from 'vitest';
import { matchComposerKey } from './matchComposerKey';

type K = Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>;
const ev = (e: K) => e as unknown as React.KeyboardEvent;

describe('matchComposerKey', () => {
  it('Cmd+Shift+P → toggle-preview', () => {
    expect(matchComposerKey(ev({ metaKey: true, shiftKey: true, key: 'P' }))).toBe('toggle-preview');
    expect(matchComposerKey(ev({ ctrlKey: true, shiftKey: true, key: 'p' }))).toBe('toggle-preview');
  });
  it('Cmd/Ctrl+Enter → submit', () => {
    expect(matchComposerKey(ev({ metaKey: true, key: 'Enter' }))).toBe('submit');
    expect(matchComposerKey(ev({ ctrlKey: true, key: 'Enter' }))).toBe('submit');
  });
  it('Escape → escape', () => {
    expect(matchComposerKey(ev({ key: 'Escape' }))).toBe('escape');
  });
  it('non-matching keys → null', () => {
    expect(matchComposerKey(ev({ key: 'a' }))).toBeNull();
    expect(matchComposerKey(ev({ key: 'Enter' }))).toBeNull(); // no modifier
    expect(matchComposerKey(ev({ metaKey: true, key: 'P' }))).toBeNull(); // no shift
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PrDetail/Composer/matchComposerKey.test.ts`
Expected: FAIL — "Failed to resolve import './matchComposerKey'".

- [ ] **Step 3: Write minimal implementation**

```ts
// matchComposerKey.ts
import type { KeyboardEvent } from 'react';

export type ComposerShortcut = 'toggle-preview' | 'submit' | 'escape';

/**
 * Pure key-combo matcher shared by the three composers. Element-type agnostic
 * (diff composers bind onKeyDown to the textarea, PrRootReplyComposer to its
 * outer div). Returns which shortcut fired, or null. Behavior dispatch stays
 * local to each composer.
 */
export function matchComposerKey(e: KeyboardEvent): ComposerShortcut | null {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    return 'toggle-preview';
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    return 'submit';
  }
  if (e.key === 'Escape') {
    return 'escape';
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/PrDetail/Composer/matchComposerKey.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```
git add frontend/src/components/PrDetail/Composer/matchComposerKey.ts frontend/src/components/PrDetail/Composer/matchComposerKey.test.ts
git commit -m "feat(#326): add matchComposerKey pure key-matcher utility"
```

---

## Task 2: `PrRootReplyComposer` adopts `matchComposerKey`

This is a refactor-under-green: the existing `PrRootReplyComposer.test.tsx` is the guard. No behavior change.

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx:138-154`

- [ ] **Step 1: Confirm the guard is green**

Run: `npx vitest run __tests__/PrRootReplyComposer.test.tsx`
Expected: PASS.

- [ ] **Step 2: Replace the hand-rolled key matching**

Add the import at the top of `PrRootReplyComposer.tsx`:
```ts
import { matchComposerKey } from './matchComposerKey';
```

Replace the body of `handleKeyDown` (current lines 138-154) with:
```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const shortcut = matchComposerKey(e);
    if (shortcut === null) return;
    e.preventDefault();
    if (shortcut === 'toggle-preview') {
      setPreviewMode((p) => !p);
    } else if (shortcut === 'submit') {
      if (!postDisabled) void handlePost();
    } else {
      handleDiscardClick();
    }
  };
```
(The `postDisabled` gate and `handleDiscardClick` discard semantics are unchanged — only the matching expression moved into `matchComposerKey`. The outer-`div` `onKeyDown` binding at line 162 is untouched.)

- [ ] **Step 3: Run the guard + typecheck**

Run: `npx vitest run __tests__/PrRootReplyComposer.test.tsx`
Expected: PASS (unchanged).
Run: `npm run build` (from `frontend/`)
Expected: `tsc -b` clean, vite build succeeds.

- [ ] **Step 4: Commit**

```
git add frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx
git commit -m "refactor(#326): PrRootReplyComposer uses matchComposerKey"
```

---

## Task 3: `ComposerActionsBar` presentational component

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx`
- Test: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`

- [ ] **Step 1: Write the failing test (includes the button-order guard)**

```tsx
// ComposerActionsBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComposerActionsBar } from './ComposerActionsBar';

const baseProps = {
  previewMode: false,
  onTogglePreview: vi.fn(),
  badge: 'saved' as const,
  saveDisabled: false,
  saveTooltip: undefined,
  addLabel: 'Add to review',
  closedBanner: false,
  prState: 'open' as const,
  postNowDisabled: false,
  postNowTooltip: undefined,
  posting: false,
  postError: null as string | null,
  readOnly: false,
  onDiscardClick: vi.fn(),
  onSaveClick: vi.fn(),
  onPostNow: vi.fn(),
};

describe('ComposerActionsBar', () => {
  it('renders buttons in canonical order for an open PR', () => {
    const { container } = render(<ComposerActionsBar {...baseProps} />);
    const bar = container.querySelector('.composer-actions') as HTMLElement;
    const buttons = within(bar).getAllByRole('button').map((b) => b.textContent);
    // AI assistant renders null (gate off in tests); badge is a span, not a button.
    expect(buttons).toEqual(['Preview', 'Discard', 'Add to review', 'Comment']);
  });
  it('hides the save button when closedBanner and shows the merged note', () => {
    render(<ComposerActionsBar {...baseProps} closedBanner prState="merged" />);
    expect(screen.queryByRole('button', { name: 'Add to review' })).toBeNull();
    expect(screen.getByText(/comments post immediately/)).toBeInTheDocument();
  });
  it('renders postError as an alert', () => {
    render(<ComposerActionsBar {...baseProps} postError="boom" />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`
Expected: FAIL — cannot resolve `./ComposerActionsBar`.

- [ ] **Step 3: Write the component (lift the JSX verbatim from `InlineCommentComposer.tsx:318-380`)**

```tsx
// ComposerActionsBar.tsx
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import type { ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';

export interface ComposerActionsBarProps {
  previewMode: boolean;
  onTogglePreview: () => void;
  badge: ComposerSaveBadge;
  saveDisabled: boolean;
  saveTooltip: string | undefined;
  addLabel: string;
  closedBanner: boolean;
  prState: 'open' | 'closed' | 'merged';
  postNowDisabled: boolean;
  postNowTooltip: string | undefined;
  posting: boolean;
  postError: string | null;
  readOnly: boolean;
  onDiscardClick: () => void;
  onSaveClick: () => void;
  onPostNow: () => void;
}

export function ComposerActionsBar({
  previewMode,
  onTogglePreview,
  badge,
  saveDisabled,
  saveTooltip,
  addLabel,
  closedBanner,
  prState,
  postNowDisabled,
  postNowTooltip,
  posting,
  postError,
  readOnly,
  onDiscardClick,
  onSaveClick,
  onPostNow,
}: ComposerActionsBarProps) {
  return (
    <div className="composer-actions">
      <button
        type="button"
        className="composer-preview-toggle"
        aria-pressed={previewMode}
        onClick={onTogglePreview}
      >
        {previewMode ? 'Edit' : 'Preview'}
      </button>

      <span className={`composer-badge composer-badge--${badge}`} role="status" data-testid="composer-badge">
        {badge}
      </span>

      <AiComposerAssistant />

      <button
        type="button"
        className="composer-discard"
        onClick={onDiscardClick}
        disabled={readOnly}
        aria-disabled={readOnly || undefined}
      >
        Discard
      </button>

      {!closedBanner && (
        <button
          type="button"
          className="composer-save btn btn-primary btn-sm"
          aria-disabled={saveDisabled}
          title={saveTooltip}
          onClick={onSaveClick}
          disabled={readOnly}
        >
          {addLabel}
        </button>
      )}
      <button
        type="button"
        className="composer-post-now"
        aria-disabled={postNowDisabled}
        title={postNowTooltip}
        onClick={onPostNow}
        disabled={readOnly || posting}
      >
        {posting ? 'Posting…' : 'Comment'}
      </button>
      {closedBanner && (
        <span className="composer-merged-note">
          {prState === 'closed' ? 'PR is closed' : 'PR is merged'} — comments post immediately
        </span>
      )}
      {postError && (
        <div className="composer-error" role="alert">
          {postError}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```
git add frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx
git commit -m "feat(#326): extract ComposerActionsBar presentational component"
```

---

## Task 4: `ComposerModals` presentational component

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/ComposerModals.tsx`
- Test: `frontend/src/components/PrDetail/Composer/ComposerModals.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// ComposerModals.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ComposerModals } from './ComposerModals';

const base = {
  discardModalOpen: false,
  onDiscardCancel: vi.fn(),
  onDiscardConfirm: vi.fn(),
  recoveryModalOpen: false,
  onRecoveryCancel: vi.fn(),
  onRecoveryRecreate: vi.fn(),
  onRecoveryDiscard: vi.fn(),
  discardBody: 'This will remove the saved draft on this line.',
  recoveryTitle: 'Draft deleted elsewhere',
  recoveryBody: 'This draft was deleted from another window or by reload. Re-create it with the current text, or discard?',
};

describe('ComposerModals', () => {
  it('renders the discard modal body when open', () => {
    render(<ComposerModals {...base} discardModalOpen />);
    expect(screen.getByText('This will remove the saved draft on this line.')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toHaveTextContent('Discard saved draft?');
  });
  it('renders the recovery modal title + body when open', () => {
    render(<ComposerModals {...base} recoveryModalOpen />);
    expect(screen.getByRole('dialog')).toHaveTextContent('Draft deleted elsewhere');
    expect(screen.getByText(base.recoveryBody)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/PrDetail/Composer/ComposerModals.test.tsx`
Expected: FAIL — cannot resolve `./ComposerModals`.

- [ ] **Step 3: Write the component (lift `<Modal>` JSX from `InlineCommentComposer.tsx:382-414`, copy parameterized)**

```tsx
// ComposerModals.tsx
import { Modal } from '../../Modal/Modal';

export interface ComposerModalsProps {
  discardModalOpen: boolean;
  onDiscardCancel: () => void;
  onDiscardConfirm: () => void;
  recoveryModalOpen: boolean;
  onRecoveryCancel: () => void;
  onRecoveryRecreate: () => void;
  onRecoveryDiscard: () => void;
  discardBody: string;
  recoveryTitle: string;
  recoveryBody: string;
}

export function ComposerModals({
  discardModalOpen,
  onDiscardCancel,
  onDiscardConfirm,
  recoveryModalOpen,
  onRecoveryCancel,
  onRecoveryRecreate,
  onRecoveryDiscard,
  discardBody,
  recoveryTitle,
  recoveryBody,
}: ComposerModalsProps) {
  return (
    <>
      <Modal open={discardModalOpen} title="Discard saved draft?" defaultFocus="cancel" onClose={onDiscardCancel}>
        <p>{discardBody}</p>
        <button type="button" data-modal-role="cancel" onClick={onDiscardCancel}>
          Cancel
        </button>
        <button type="button" data-modal-role="primary" onClick={onDiscardConfirm}>
          Discard
        </button>
      </Modal>

      <Modal
        open={recoveryModalOpen}
        title={recoveryTitle}
        defaultFocus="primary"
        disableEscDismiss
        onClose={onRecoveryCancel}
      >
        <p>{recoveryBody}</p>
        <button type="button" data-modal-role="cancel" onClick={onRecoveryDiscard}>
          Discard
        </button>
        <button type="button" data-modal-role="primary" onClick={onRecoveryRecreate}>
          Re-create
        </button>
      </Modal>
    </>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/PrDetail/Composer/ComposerModals.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```
git add frontend/src/components/PrDetail/Composer/ComposerModals.tsx frontend/src/components/PrDetail/Composer/ComposerModals.test.tsx
git commit -m "feat(#326): extract ComposerModals presentational component"
```

---

## Task 5: `useDraftComposer` hook

Lift the **current `InlineCommentComposer` body** (the canonical copy) into a hook, parameterized for both diff composers. The three deltas vs the verbatim lift: `deletePatchKind` replaces the literal, `ownerKey` replaces `'files-tab'`, the discard handler drops the dead try/catch, and `handleKeyDown` is built via `matchComposerKey`.

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/useDraftComposer.ts`
- Test: `frontend/src/components/PrDetail/Composer/useDraftComposer.test.tsx`

- [ ] **Step 1: Write the failing tests (renderHook)**

```tsx
// useDraftComposer.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDraftComposer } from './useDraftComposer';
import * as draftApi from '../../../api/draft';
import type { ComposerAnchor } from '../../../hooks/useComposerAutoSave';

const inlineAnchor: ComposerAnchor = {
  kind: 'inline-comment',
  filePath: 'a.ts',
  lineNumber: 1,
  side: 'right',
  anchoredSha: 'sha',
  anchoredLineContent: 'x',
};

function params(overrides: Partial<Parameters<typeof useDraftComposer>[0]> = {}) {
  return {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prState: 'open' as const,
    draftId: 'd1',
    onDraftIdChange: vi.fn(),
    registerOpenComposer: vi.fn(() => () => {}),
    ownerKey: 'files-tab' as const,
    onClose: vi.fn(),
    anchor: inlineAnchor,
    deletePatchKind: 'deleteDraftComment' as const,
    ...overrides,
  };
}

describe('useDraftComposer', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('exposes grouped editor/actions/modals slices', () => {
    const { result } = renderHook(() => useDraftComposer(params()));
    expect(result.current.editor).toBeDefined();
    expect(result.current.actions).toBeDefined();
    expect(result.current.modals).toBeDefined();
    expect(typeof result.current.editor.handleKeyDown).toBe('function');
  });

  it('discard confirm sends the parameterized delete kind and closes on ok', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const p = params({ deletePatchKind: 'deleteDraftReply', anchor: { kind: 'reply', parentThreadId: 't1' } });
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => { await result.current.modals.onDiscardConfirm(); });
    expect(spy).toHaveBeenCalledWith(p.prRef, { kind: 'deleteDraftReply', payload: { id: 'd1' } });
    expect(p.onClose).toHaveBeenCalled();
  });

  it('discard confirm stays in the modal on a non-ok (network) result', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: false, status: 0, kind: 'network', body: 'x' });
    const p = params();
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => { await result.current.modals.onDiscardConfirm(); });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onDraftIdChange).not.toHaveBeenCalledWith(null);
  });

  it('save is disabled below the create threshold for a new draft', () => {
    const { result } = renderHook(() => useDraftComposer(params({ draftId: null, initialBody: 'a' })));
    expect(result.current.actions.saveDisabled).toBe(true);
  });

  it('registers the open composer with the provided ownerKey', () => {
    const register = vi.fn(() => () => {});
    renderHook(() => useDraftComposer(params({ registerOpenComposer: register, ownerKey: 'drafts-tab' })));
    expect(register).toHaveBeenCalledWith('d1', 'drafts-tab');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/PrDetail/Composer/useDraftComposer.test.tsx`
Expected: FAIL — cannot resolve `./useDraftComposer`.

- [ ] **Step 3: Implement the hook**

Create `useDraftComposer.ts`. Move the following from `InlineCommentComposer.tsx` **verbatim except where noted**:

- State block (`InlineCommentComposer.tsx:79-89`): `body`, `previewMode`, `discardModalOpen`, `recoveryModalOpen`, `recoveryModalOpenRef`, `textareaRef`. Add `postError`, `posting` (lines 210-211).
- `composerAnchor` is now the `anchor` **param** (delete the inline literal at lines 91-98).
- `handleAssignedId`, `handleDraftDeletedByServer`, `handleLocalDelete` (lines 100-116) verbatim.
- `useComposerAutoSave` call (lines 118-129) verbatim, passing `onSaved` through (optional param).
- The `flushRef` publish effect (lines 134-140) verbatim — its `if (!flushRef) return` guard makes it a no-op when `flushRef` is undefined.
- `registerOpenComposer` effect (lines 145-148): change the literal `'files-tab'` to the `ownerKey` param.
- Focus-on-mount effect (lines 152-154) verbatim — **declare it last** among the effects.
- Derived values (lines 156-169, 215-218, 289, 292): `trimmedLength`, `bodyEmpty`, `belowCreateThreshold`, `saveDisabled`, `saveTooltip`, `postNowDisabled`, `postNowTooltip`, `closedBanner`, `addLabel`.
- `handleDiscardClick` (lines 171-177) verbatim.
- `handleDiscardConfirm` — lift lines 179-203 **but drop the try/catch** (it is dead under `sendPatch`'s no-throw contract) and parameterize the kind:

```ts
  const handleDiscardConfirm = async () => {
    if (draftId !== null) {
      const result = await sendPatch(prRef, { kind: deletePatchKind, payload: { id: draftId } });
      if (!result.ok) return; // network/4xx → stay in modal (sendPatch never throws)
      onDraftIdChange(null);
    }
    setDiscardModalOpen(false);
    onClose();
  };
```

- `handleSaveClick` (lines 205-208), `handlePostNow` (lines 220-245), `handleRecoveryRecreate` (lines 247-253), `handleRecoveryDiscard` (lines 255-259) verbatim.
- Build `handleKeyDown` from `matchComposerKey` (replacing lines 261-287), preserving the recovery-guard:

```tsx
  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const shortcut = matchComposerKey(e);
    if (shortcut === null) return;
    e.preventDefault();
    if (shortcut === 'toggle-preview') {
      setPreviewMode((p) => !p);
    } else if (shortcut === 'submit') {
      void (async () => {
        await flush();
        if (recoveryModalOpenRef.current) return; // 404-recovery opened mid-flush → keep modal
        onClose();
      })();
    } else {
      handleDiscardClick();
    }
  };
```

Signature + return (assemble the three slices):

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { useComposerAutoSave, COMPOSER_CREATE_THRESHOLD } from '../../../hooks/useComposerAutoSave';
import type { ComposerAnchor, ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { sendPatch } from '../../../api/draft';
import { postComment } from '../../../api/comment';
import { matchComposerKey } from './matchComposerKey';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';
import type { PrReference } from '../../../api/types';

export interface UseDraftComposerParams {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  anchor: ComposerAnchor;
  deletePatchKind: 'deleteDraftComment' | 'deleteDraftReply';
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
  onSaved?: () => void;
  flushRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
}

export interface UseDraftComposerResult {
  editor: {
    body: string;
    setBody: (v: string) => void;
    previewMode: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
    readOnly: boolean;
  };
  actions: {
    previewMode: boolean;
    onTogglePreview: () => void;
    badge: ComposerSaveBadge;
    saveDisabled: boolean;
    saveTooltip: string | undefined;
    addLabel: string;
    closedBanner: boolean;
    prState: 'open' | 'closed' | 'merged';
    postNowDisabled: boolean;
    postNowTooltip: string | undefined;
    posting: boolean;
    postError: string | null;
    readOnly: boolean;
    onDiscardClick: () => void;
    onSaveClick: () => void;
    onPostNow: () => void;
  };
  modals: {
    discardModalOpen: boolean;
    onDiscardCancel: () => void;
    onDiscardConfirm: () => void;
    recoveryModalOpen: boolean;
    onRecoveryCancel: () => void;
    onRecoveryRecreate: () => void;
    onRecoveryDiscard: () => void;
  };
}
```

Destructure params with defaults matching `InlineCommentComposer` (`initialBody = ''`, `readOnly = false`, `anyOtherDraftsStaged = false`). Assemble the return as:

```ts
  return {
    editor: { body, setBody, previewMode, textareaRef, handleKeyDown, readOnly },
    actions: {
      previewMode,
      onTogglePreview: () => setPreviewMode((p) => !p),
      badge, saveDisabled, saveTooltip, addLabel, closedBanner, prState,
      postNowDisabled, postNowTooltip, posting, postError, readOnly,
      onDiscardClick: handleDiscardClick,
      onSaveClick: handleSaveClick,
      onPostNow: handlePostNow,
    },
    modals: {
      discardModalOpen,
      onDiscardCancel: () => setDiscardModalOpen(false),
      onDiscardConfirm: handleDiscardConfirm,
      recoveryModalOpen,
      onRecoveryCancel: () => setRecoveryModalOpen(false),
      onRecoveryRecreate: handleRecoveryRecreate,
      onRecoveryDiscard: handleRecoveryDiscard,
    },
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/PrDetail/Composer/useDraftComposer.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `npm run build` (from `frontend/`)
Expected: `tsc -b` clean.

- [ ] **Step 6: Commit**

```
git add frontend/src/components/PrDetail/Composer/useDraftComposer.ts frontend/src/components/PrDetail/Composer/useDraftComposer.test.tsx
git commit -m "feat(#326): extract useDraftComposer hook (grouped editor/actions/modals)"
```

---

## Task 6: Rewrite `InlineCommentComposer` as glue + `ownerKey` prop

Refactor-under-green: the existing `InlineCommentComposer.test.tsx` + `.postNow.test.tsx` are the guards. Add one button-order assertion.

**Files:**
- Rewrite: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx`
- Test: `frontend/src/components/PrDetail/Composer/__tests__-adjacent` → modify `frontend/__tests__/InlineCommentComposer.test.tsx` (add one test)

- [ ] **Step 1: Confirm guards green**

Run: `npx vitest run __tests__/InlineCommentComposer.test.tsx __tests__/InlineCommentComposer.postNow.test.tsx`
Expected: PASS.

- [ ] **Step 2: Rewrite the component to glue**

Replace the whole file body (keep the `InlineAnchor` interface + `composerAriaLabel` helper) with:

```tsx
import { useDraftComposer } from './useDraftComposer';
import { ComposerActionsBar } from './ComposerActionsBar';
import { ComposerModals } from './ComposerModals';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import styles from './InlineCommentComposer.module.css';
import type { DraftSide, PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

export interface InlineAnchor {
  filePath: string;
  lineNumber: number;
  side: DraftSide;
  anchoredSha: string;
  anchoredLineContent: string;
}

export interface InlineCommentComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  anchor: InlineAnchor;
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey?: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  onSaved?: () => void;
  flushRef?: React.MutableRefObject<(() => Promise<string | null>) | null>;
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
}

function composerAriaLabel(anchor: InlineAnchor): string {
  return `Draft comment on ${anchor.filePath} line ${anchor.lineNumber}`;
}

export function InlineCommentComposer({
  prRef, prState, anchor, initialBody = '', draftId, onDraftIdChange,
  registerOpenComposer, ownerKey = 'files-tab', onClose, readOnly = false, onSaved, flushRef,
  anyOtherDraftsStaged = false, beginPosting, endPosting, onPosted,
}: InlineCommentComposerProps) {
  const { editor, actions, modals } = useDraftComposer({
    prRef, prState, initialBody, draftId, onDraftIdChange, registerOpenComposer, ownerKey,
    onClose, readOnly, onSaved, flushRef, anyOtherDraftsStaged, beginPosting, endPosting, onPosted,
    anchor: {
      kind: 'inline-comment',
      filePath: anchor.filePath,
      lineNumber: anchor.lineNumber,
      side: anchor.side,
      anchoredSha: anchor.anchoredSha,
      anchoredLineContent: anchor.anchoredLineContent,
    },
    deletePatchKind: 'deleteDraftComment',
  });

  return (
    <div
      role="form"
      aria-label={composerAriaLabel(anchor)}
      data-composer="true"
      data-testid="inline-comment-composer"
      className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}
    >
      {editor.previewMode ? (
        <ComposerMarkdownPreview body={editor.body} />
      ) : (
        <textarea
          ref={editor.textareaRef}
          className="composer-textarea"
          value={editor.body}
          onChange={(e) => editor.setBody(e.target.value)}
          onKeyDown={editor.handleKeyDown}
          aria-label="Comment body"
          rows={4}
          readOnly={editor.readOnly}
          aria-readonly={editor.readOnly || undefined}
        />
      )}
      <ComposerActionsBar {...actions} />
      <ComposerModals
        {...modals}
        discardBody="This will remove the saved draft on this line."
        recoveryTitle="Draft deleted elsewhere"
        recoveryBody="This draft was deleted from another window or by reload. Re-create it with the current text, or discard?"
      />
    </div>
  );
}
```

- [ ] **Step 3: Run guards to verify still green**

Run: `npx vitest run __tests__/InlineCommentComposer.test.tsx __tests__/InlineCommentComposer.postNow.test.tsx`
Expected: PASS (unchanged).

- [ ] **Step 4: Add the button-order assertion to `__tests__/InlineCommentComposer.test.tsx`**

Append this test inside the top-level `describe`:
```tsx
  it('renders composer-actions buttons in canonical order (open PR)', () => {
    renderInline(); // use the file's existing render helper with an open-PR draft
    const bar = document.querySelector('.composer-actions') as HTMLElement;
    const labels = within(bar).getAllByRole('button').map((b) => b.textContent);
    expect(labels).toEqual(['Preview', 'Discard', 'Add to review', 'Comment']);
  });
```
(Use the existing render helper in that file; import `within` from `@testing-library/react` if not already imported. If the helper renders a closed PR by default, pass an open `prState`.)

- [ ] **Step 5: Run it**

Run: `npx vitest run __tests__/InlineCommentComposer.test.tsx`
Expected: PASS including the new test.

- [ ] **Step 6: Commit**

```
git add frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx frontend/__tests__/InlineCommentComposer.test.tsx
git commit -m "refactor(#326): InlineCommentComposer becomes glue over useDraftComposer; ownerKey prop"
```

---

## Task 7: Rewrite `ReplyComposer` as glue + `ownerKey` prop

Refactor-under-green: existing `ReplyComposer.test.tsx` + `.postNow.test.tsx` are the guards.

**Files:**
- Rewrite: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx`

- [ ] **Step 1: Confirm guards green**

Run: `npx vitest run __tests__/ReplyComposer.test.tsx __tests__/ReplyComposer.postNow.test.tsx`
Expected: PASS.

- [ ] **Step 2: Rewrite the component to glue**

Replace the whole file body (keep the `replyAriaLabel` helper) with:

```tsx
import { useDraftComposer } from './useDraftComposer';
import { ComposerActionsBar } from './ComposerActionsBar';
import { ComposerModals } from './ComposerModals';
import { ComposerMarkdownPreview } from './ComposerMarkdownPreview';
import styles from './ReplyComposer.module.css';
import type { PrReference } from '../../../api/types';
import type { ComposerOwnerKey } from '../../../hooks/useDraftSession';

export interface ReplyComposerProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  parentThreadId: string;
  initialBody?: string;
  draftId: string | null;
  onDraftIdChange: (id: string | null) => void;
  registerOpenComposer: (draftId: string, ownerKey: ComposerOwnerKey) => () => void;
  ownerKey?: ComposerOwnerKey;
  onClose: () => void;
  readOnly?: boolean;
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (postedCommentId: number, body: string) => void;
}

function replyAriaLabel(parentThreadId: string): string {
  return `Reply to thread ${parentThreadId}`;
}

export function ReplyComposer({
  prRef, prState, parentThreadId, initialBody = '', draftId, onDraftIdChange,
  registerOpenComposer, ownerKey = 'files-tab', onClose, readOnly = false,
  anyOtherDraftsStaged = false, beginPosting, endPosting, onPosted,
}: ReplyComposerProps) {
  const { editor, actions, modals } = useDraftComposer({
    prRef, prState, initialBody, draftId, onDraftIdChange, registerOpenComposer, ownerKey,
    onClose, readOnly, anyOtherDraftsStaged, beginPosting, endPosting, onPosted,
    anchor: { kind: 'reply', parentThreadId },
    deletePatchKind: 'deleteDraftReply',
  });

  return (
    <div
      role="form"
      aria-label={replyAriaLabel(parentThreadId)}
      data-composer="true"
      data-testid="reply-composer"
      className={`reply-composer composer-frame ${styles.replyComposer}`}
    >
      {editor.previewMode ? (
        <ComposerMarkdownPreview body={editor.body} />
      ) : (
        <textarea
          ref={editor.textareaRef}
          className="composer-textarea"
          value={editor.body}
          onChange={(e) => editor.setBody(e.target.value)}
          onKeyDown={editor.handleKeyDown}
          aria-label="Reply body"
          rows={3}
          readOnly={editor.readOnly}
          aria-readonly={editor.readOnly || undefined}
        />
      )}
      <ComposerActionsBar {...actions} />
      <ComposerModals
        {...modals}
        discardBody="This will remove the saved reply draft on this thread."
        recoveryTitle="Draft reply deleted elsewhere"
        recoveryBody="This reply draft was deleted from another window or by reload. Re-create it with the current text, or discard?"
      />
    </div>
  );
}
```

- [ ] **Step 3: Run guards to verify still green**

Run: `npx vitest run __tests__/ReplyComposer.test.tsx __tests__/ReplyComposer.postNow.test.tsx`
Expected: PASS (unchanged).

- [ ] **Step 4: Commit**

```
git add frontend/src/components/PrDetail/Composer/ReplyComposer.tsx
git commit -m "refactor(#326): ReplyComposer becomes glue over useDraftComposer; ownerKey prop"
```

---

## Task 8: Full verification + follow-up issue

- [ ] **Step 1: Full frontend test suite**

Run (from `frontend/`): `npx vitest run`
Expected: all PASS (no regressions; the line count should drop while suite count holds).

- [ ] **Step 2: Typecheck + build**

Run (from `frontend/`): `npm run build`
Expected: `tsc -b` clean, vite build succeeds.

- [ ] **Step 3: Lint + format (rtk masks prettier — use the proxy)**

Run (from `frontend/`): `npx eslint .`
Expected: clean.
Run (from `frontend/`): `rtk proxy npx prettier --check .`
Expected: "All matched files use Prettier code style!" with a real exit 0. If any file is unformatted, run `rtk proxy npx prettier --write <files>` and re-commit.

- [ ] **Step 4: Verify the dedup landed (sanity)**

Run: `git diff --stat origin/main...HEAD -- frontend/src/components/PrDetail/Composer/`
Expected: `InlineCommentComposer.tsx` and `ReplyComposer.tsx` show large deletions; new `useDraftComposer.ts` / `ComposerActionsBar.tsx` / `ComposerModals.tsx` / `matchComposerKey.ts` added. Net composer LOC down.

- [ ] **Step 5: File the deferred follow-up issue**

```
gh issue create --repo prpande/PRism \
  --title "Frontend: extract useDraftBackedDisclosure from ExistingCommentWidget + PrRootConversation" \
  --label tech-debt --label area:frontend --label code-quality \
  --body "Carved out of #326. The useState(!!existingDraft) + resync-useEffect disclosure block is duplicated in ExistingCommentWidget.tsx:89-96 and PrRootConversation.tsx:80-87. Extract a useDraftBackedDisclosure(existingDraft) hook. Deferred from #326 because it is disclosure state (not composer state), touches the Overview tab (B1 surface), and is orthogonal to the shared-composer-shell work. See docs/specs/2026-06-11-shared-composer-core-design.md."
```
Record the new issue number for the PR cross-link.

- [ ] **Step 6: Hand off to pr-autopilot** (gated B1 — pause for the visual assert at green-and-ready; do not merge).

---

## Self-Review (completed by plan author)

- **Spec coverage:** matchComposerKey (Task 1) ✓; useDraftComposer grouped return (Task 5) ✓; ComposerActionsBar/Modals (Tasks 3-4) ✓; InlineComposer/ReplyComposer glue + ownerKey prop (Tasks 6-7) ✓; PrRootReplyComposer matcher (Task 2) ✓; discard try/catch dropped (Task 5 step 3) ✓; zero-behavior-change guard = existing suites unchanged (Tasks 2,6,7) ✓; button-order assertion (Tasks 3,6) ✓; follow-up issue (Task 8) ✓; B1 gate (Task 8 step 6) ✓.
- **Placeholders:** none — every new module's full code is shown; verbatim-lift instructions cite exact line ranges.
- **Type consistency:** `UseDraftComposerResult.{editor,actions,modals}` field names match `ComposerActionsBarProps` / `ComposerModalsProps` / the textarea binding; `ownerKey: ComposerOwnerKey` (existing union includes `'files-tab'`/`'drafts-tab'`); `deletePatchKind` values match `serializePatch` cases; `ComposerAnchor` is the real exported union.
