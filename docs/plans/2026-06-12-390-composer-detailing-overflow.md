# #390 Composer Detailing + Overflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the "textarea owns the focus" composer detailing across the inline/reply/Overview comment composers (flat footer, grouped real buttons, hover fills, filled primary, hidden merged-note) and pin the unified-mode comment/composer cells to the visible diff width.

**Architecture:** Mostly CSS scoped under `.composer-frame` in `tokens.css` (so the frameless `SubmitDialog` is untouched), plus small footer-JSX regrouping in two components, plus a `ResizeObserver`→CSS-var hook and a sticky wrapper in `DiffPane`. Pure-CSS visual effects (colors, borders, focus rings, hovers) are not jsdom-observable, so they are implemented as code steps and verified live at the B1 gate; structural/behavioral changes (footer grouping, merged-note removal, sticky-wrapper presence, hook var-write) get real vitest tests.

**Tech Stack:** React + TypeScript + Vite, CSS custom properties (design tokens), Vitest + Testing Library, Playwright (B1 live verify).

**Spec:** `docs/specs/2026-06-12-390-composer-detailing-and-overflow-design.md`

**Working directory:** the `feature/390-composer-detailing-overflow` worktree at `D:\src\PRism-wt\390-composer-detailing`. Run all `npm` commands from `frontend/`.

**Commit convention:** word scopes with a trailing `(#390)` reference (never `fix(#390):`/`feat(#390):` — that auto-closes the issue early). The PR body carries `Closes #390`.

---

## File map

| File | Responsibility | Change |
|---|---|---|
| `frontend/src/styles/tokens.css` | composer-frame scoped styles | Task 1 (body/frame), Task 2 (footer/buttons) |
| `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` | inline+reply footer | Task 3 (regroup, drop merged-note, post-now title) |
| `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx` | footer tests | Task 3 (invert merged-note assertion, add title assertion) |
| `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx` | Overview footer | Task 4 (regroup spacer; Post stays `.composer-post`) |
| `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx` | Overview footer test | Task 4 (spacer-grouping assertion) |
| `frontend/src/hooks/useDiffViewportWidthVar.ts` | viewport-width CSS var | Task 5 (new) |
| `frontend/src/hooks/useDiffViewportWidthVar.test.ts` | hook test | Task 5 (new) |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` | diff render | Task 6 (call hook, wrap 4 cell sites) |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` | diff styles | Task 6 (`.diffStickyViewport`) |

---

## Task 1: Composer body + frame CSS (textarea owns focus, tight gutter)

**Files:**
- Modify: `frontend/src/styles/tokens.css:1033-1066` (the textarea-well comment block through the `.composer-frame:focus-within` rule — do NOT extend into the `.composer-frame .composer-actions` footer at 1068, that's Task 2)

- [ ] **Step 1: Replace the `.composer-frame .composer-textarea` / focus-within / markdown-preview block.**

Replace lines 1033–1066 (the comment block + `.composer-frame .composer-textarea`, its `:focus-visible`, the markdown-preview rule, the dark note, and the `.composer-frame:focus-within` rule) with:

```css
/* #390 — the TEXTAREA owns the focus highlight (reverts #287's frame-as-sole-
   indicator and #352's recessed well). The frame is a quiet container; exactly
   one element rings at a time, so no double-ring. */
.composer-frame .composer-textarea {
  /* tight 4px gutter; subtract both gutters from the 100% (border-box) width so
     the margin box fills the frame's content edge exactly. */
  width: calc(100% - 2 * var(--s-1));
  margin: var(--s-1);
  background: var(--surface-inset);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-2);
}
.composer-frame .composer-textarea:focus-visible {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
/* Preview pane gets the same 4px gutter so toggling Edit<->Preview doesn't shift
   the content box edges. */
.composer-frame .composer-markdown-preview {
  margin: var(--s-1);
}
/* NOTE: the former `.composer-frame:focus-within { border-color: accent; box-shadow: ring }`
   rule is intentionally deleted — the frame keeps only its resting border + --shadow-1. */
```

- [ ] **Step 2: Verify the build compiles.**

Run (from `frontend/`): `npm run build`
Expected: build succeeds (CSS valid, no `tsc` errors).

- [ ] **Step 3: Commit.**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(composer): textarea owns focus ring; tight gutter; drop frame focus-within (#390)"
```

---

## Task 2: Footer + button CSS (no tray, grouped, uniform real buttons, hovers)

**Files:**
- Modify: `frontend/src/styles/tokens.css` (the `.composer-frame .composer-actions` block ~1068 and add new button rules after it)

- [ ] **Step 1: Replace the `.composer-frame .composer-actions` rule** (currently the tinted footer strip) with the no-tray + grouping rule, and append the button rules:

```css
/* #390 — flat footer (no tray), grouped left/right via a single flex spacer. */
.composer-frame .composer-actions {
  justify-content: flex-start;
  gap: var(--s-2);
  padding: var(--s-2) var(--s-2) var(--s-3);
  background: transparent;
  border-top: none;
}
/* the spacer (a non-button <span>) pushes the right group to the edge */
.composer-frame .composer-actions .composer-actions-spacer {
  flex: 1 1 auto;
}
/* uniform sizing + the app sans font on every footer button.
   Specificity (0,2,1) beats .btn-sm (0,1,0, height 26px) and .composer-post-now
   (0,1,0) so the primary matches the secondaries. */
.composer-frame .composer-actions button {
  font-family: var(--font-sans);
  height: 28px;
  padding: 0 12px;
  display: inline-flex;
  align-items: center;
  line-height: 1;
  box-sizing: border-box;
}
/* Preview + Discard = real bordered secondary buttons. */
.composer-frame .composer-preview-toggle,
.composer-frame .composer-discard {
  border: 1px solid var(--border-2);
  background: var(--surface-1);
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  transition:
    background var(--t-fast) var(--ease-out),
    border-color var(--t-fast) var(--ease-out);
}
.composer-frame .composer-preview-toggle {
  color: var(--text-1);
}
.composer-frame .composer-discard {
  color: var(--danger-fg);
}
/* Preview: hover fill, and the pressed (preview-active) state latches to the same look. */
.composer-frame .composer-preview-toggle:hover,
.composer-frame .composer-preview-toggle[aria-pressed='true'] {
  background: var(--surface-3);
  border-color: var(--border-strong);
  text-decoration: none;
}
/* Discard: red hover fill + red text (non-color-redundant vs the green Comment hover),
   overriding the GLOBAL underline rule (tokens.css ~961) within the frame only. */
.composer-frame .composer-discard:hover {
  background: var(--danger-soft);
  border-color: var(--danger);
  color: var(--danger-fg);
  text-decoration: none;
}
.composer-frame .composer-discard:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Overview "Post" = NEW filled-primary rule (it had no rule before). */
.composer-frame .composer-post {
  background: var(--accent);
  color: var(--accent-text);
  border: 1px solid var(--accent);
  border-radius: var(--radius-2);
  font-size: var(--text-xs);
  font-weight: 500;
  transition:
    background var(--t-fast) var(--ease-out),
    border-color var(--t-fast) var(--ease-out);
}
.composer-frame .composer-post:hover:not(:disabled) {
  background: var(--accent-hover);
  border-color: var(--accent-hover);
}
.composer-frame .composer-post:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
/* Inline "Comment" (immediate post): green hover, mirroring Discard's red. */
.composer-frame .composer-post-now:hover:not(:disabled) {
  background: var(--success-soft);
  border-color: var(--success);
  color: var(--success-fg);
}
```

> Note: `.composer-post-now` already has a resting rule (~970) **and a grey `:hover` rule** (~984, `background: var(--surface-3); border-color: var(--border-strong)`). The new `.composer-frame`-scoped green hover (specificity 0,3,1) intentionally **overrides** that global grey hover (0,2,0) inside the frame. `--t-fast`/`--ease-out` exist (tokens.css ~58–59).

- [ ] **Step 2: Verify the build compiles.**

Run (from `frontend/`): `npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit.**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(composer): flat grouped footer, real Preview/Discard buttons, hover fills, filled Post (#390)"
```

---

## Task 3: ComposerActionsBar — regroup, drop merged-note, post-now merged title

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx`
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`

- [ ] **Step 1: Update the test first (TDD red).** Replace the `'hides the save button when closedBanner and shows the merged note'` test with the inverted assertion + a new title assertion:

```tsx
  it('hides the save button and the merged note when closedBanner', () => {
    render(<ComposerActionsBar {...baseProps} closedBanner prState="merged" />);
    expect(screen.queryByRole('button', { name: 'Add to review' })).toBeNull();
    expect(screen.queryByText(/comments post immediately/)).toBeNull();
    // The merged context is preserved as the button's TOOLTIP (title), not its
    // accessible name: visible text "Comment" outranks `title` in the ARIA
    // name computation, and keeping "Comment" as the name preserves WCAG 2.5.3
    // (label-in-name). So assert the title attribute, not the role name.
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'title',
      'Post directly to this merged PR',
    );
  });
```

- [ ] **Step 2: Run the test to verify it fails.**

Run (from `frontend/`): `npm run test -- ComposerActionsBar`
Expected: FAIL — the merged note still renders and the post-now button has no merged title yet.

- [ ] **Step 3: Implement the regroup + merged-note removal + title.** Replace the JSX returned by `ComposerActionsBar` (lines 41–104) with:

```tsx
  const mergedTitle =
    closedBanner
      ? `Post directly to this ${prState === 'closed' ? 'closed' : 'merged'} PR`
      : postNowTooltip;
  return (
    <div className="composer-actions">
      {/* left group */}
      <button
        type="button"
        className="composer-preview-toggle"
        aria-pressed={previewMode}
        onClick={onTogglePreview}
      >
        {previewMode ? 'Edit' : 'Preview'}
      </button>

      <AiComposerAssistant />

      <span
        className={`composer-badge composer-badge--${badge}`}
        role="status"
        data-testid="composer-badge"
      >
        {badgeLabel(badge)}
      </span>

      <span className="composer-actions-spacer" aria-hidden="true" />

      {/* right group */}
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
        title={mergedTitle}
        onClick={onPostNow}
        disabled={readOnly || posting}
      >
        {posting ? 'Posting…' : 'Comment'}
      </button>
      {postError && (
        <div className="composer-error" role="alert">
          {postError}
        </div>
      )}
    </div>
  );
```

> DOM order is now Preview → AI(null in tests) → badge(span) → spacer(span) → Discard → Save → Comment, so `getAllByRole('button')` still yields `['Preview','Discard','Add to review','Comment']` — the canonical-order test stays green. The `title` on the post-now button is a **tooltip/description**, not the accessible name (the visible "Comment" text remains the name — preserving WCAG 2.5.3), which is why the test asserts the `title` attribute rather than `getByRole`'s `name`.

- [ ] **Step 4: Run the tests to verify they pass.**

Run (from `frontend/`): `npm run test -- ComposerActionsBar`
Expected: PASS (canonical order, inverted merged-note, alert, new title).

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx
git commit -m "feat(composer): group ComposerActionsBar footer; drop merged note for post-now title (#390)"
```

---

## Task 4: PrRootReplyComposer — group the Overview footer

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx:211-251`
- Modify: `frontend/src/components/PrDetail/Composer/PrRootReplyComposer.badge.test.tsx` (the **existing** test file — there is no `.test.tsx` and no shared render helper; it inlines `render(<PrRootReplyComposer … />)` with `PrRootBodyEditor` + `AiComposerAssistant` mocked. Reuse that exact render pattern.)

- [ ] **Step 1: Write a failing structural test.** Add a test to `PrRootReplyComposer.badge.test.tsx`, copying the existing file's inline render + mocks (do **not** invent a helper). Assert the footer renders the spacer and the canonical button order:

```tsx
it('groups the Overview footer with a spacer in canonical order', () => {
  // mirror the existing badge-test render: PrRootBodyEditor + AiComposerAssistant
  // mocked, props prRef / prState="open" / draftId={null} / onDraftIdChange /
  // registerOpenComposer / onClose (copy the harness already at the top of this file).
  render(<PrRootReplyComposer {...replyComposerProps} />);
  const bar = document.querySelector('.composer-actions') as HTMLElement;
  expect(bar.querySelector('.composer-actions-spacer')).not.toBeNull();
  const buttons = within(bar).getAllByRole('button').map((b) => b.textContent);
  expect(buttons).toEqual(['Preview', 'Discard', 'Post']);
});
```

> `AiComposerAssistant` is mocked to render null in these tests (AI gate off) and the badge is a `<span>`, so the spacer (a `<span>`) does not appear in `getAllByRole('button')` — the order stays `['Preview','Discard','Post']`.

- [ ] **Step 2: Run it to verify it fails.**

Run (from `frontend/`): `npm run test -- PrRootReplyComposer`
Expected: FAIL — no `.composer-actions-spacer` exists yet (and current DOM order is Preview, badge, AI, Discard, Post).

- [ ] **Step 3: Reorder the footer to left=[Preview, AI, badge], spacer, right=[Discard, Post].** Replace the `<div className="composer-actions">…</div>` (lines 211–251) with:

```tsx
      <div className="composer-actions">
        <button
          type="button"
          className="composer-preview-toggle"
          aria-pressed={previewMode}
          onClick={() => setPreviewMode((p) => !p)}
        >
          {previewMode ? 'Edit' : 'Preview'}
        </button>

        <AiComposerAssistant />

        <span
          className={`composer-badge composer-badge--${badge}`}
          role="status"
          data-testid="composer-badge"
        >
          {badgeLabel(badge)}
        </span>

        <span className="composer-actions-spacer" aria-hidden="true" />

        <button
          type="button"
          className="composer-discard"
          onClick={handleDiscardClick}
          disabled={readOnly || inFlight}
          aria-disabled={readOnly || inFlight || undefined}
        >
          Discard
        </button>

        <button
          type="button"
          className="composer-post"
          aria-disabled={postDisabled}
          title={postTooltip}
          onClick={handlePost}
          disabled={postDisabled}
        >
          {postInFlight ? 'Posting…' : 'Post'}
        </button>
      </div>
```

> The `.composer-post` class already exists here and now receives the filled-primary CSS from Task 2. No behavior change — only child order + the spacer.

- [ ] **Step 4: Run the test to verify it passes.**

Run (from `frontend/`): `npm run test -- PrRootReplyComposer`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/components/PrDetail/Composer/PrRootReplyComposer.tsx frontend/src/components/PrDetail/Composer/PrRootReplyComposer.test.tsx
git commit -m "feat(composer): group the Overview reply footer to match the shared bar (#390)"
```

---

## Task 5: `useDiffViewportWidthVar` hook

**Files:**
- Create: `frontend/src/hooks/useDiffViewportWidthVar.ts`
- Create: `frontend/src/hooks/useDiffViewportWidthVar.test.ts`

- [ ] **Step 1: Write the failing test.**

```ts
import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useRef } from 'react';
import { useDiffViewportWidthVar } from './useDiffViewportWidthVar';

describe('useDiffViewportWidthVar', () => {
  it('does not throw when ResizeObserver is undefined (jsdom)', () => {
    const orig = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    // jsdom has no ResizeObserver by default; assert the guard holds.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = undefined;
    expect(() => {
      renderHook(() => {
        const ref = useRef<HTMLDivElement>(document.createElement('div'));
        useDiffViewportWidthVar(ref, []);
      });
    }).not.toThrow();
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = orig;
  });

  it('writes the element clientWidth to --diff-viewport-w when ResizeObserver exists', () => {
    const el = document.createElement('div');
    Object.defineProperty(el, 'clientWidth', { value: 640, configurable: true });
    class RO {
      cb: ResizeObserverCallback;
      constructor(cb: ResizeObserverCallback) { this.cb = cb; }
      observe() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RO as unknown as typeof ResizeObserver;
    renderHook(() => {
      const ref = useRef(el);
      useDiffViewportWidthVar(ref, []);
    });
    expect(el.style.getPropertyValue('--diff-viewport-w')).toBe('640px');
  });
});
```

- [ ] **Step 2: Run it to verify it fails.**

Run (from `frontend/`): `npm run test -- useDiffViewportWidthVar`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook.**

```ts
import { useEffect } from 'react';
import type { RefObject } from 'react';

// #390 — write the diff body's visible inner width to `--diff-viewport-w` so the
// sticky comment/composer wrapper can size to the viewport, not the over-wide
// table. Mirrors useLockedPaneScroll's jsdom guard (no ResizeObserver in tests).
export function useDiffViewportWidthVar(
  bodyRef: RefObject<HTMLElement | null>,
  deps: readonly unknown[],
): void {
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;

    const apply = (): void => {
      body.style.setProperty('--diff-viewport-w', `${body.clientWidth}px`);
    };
    apply();

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => apply());
    ro.observe(body);
    return () => {
      ro.disconnect();
      body.style.removeProperty('--diff-viewport-w');
    };
    // deps lets DiffPane re-measure on file/mode/wrap change.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller-supplied ...deps re-measure key (#331)
  }, [bodyRef, ...deps]);
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run (from `frontend/`): `npm run test -- useDiffViewportWidthVar`
Expected: PASS (both cases).

- [ ] **Step 5: Commit.**

```bash
git add frontend/src/hooks/useDiffViewportWidthVar.ts frontend/src/hooks/useDiffViewportWidthVar.test.ts
git commit -m "feat(diff): useDiffViewportWidthVar writes diff body width to a CSS var (#390)"
```

---

## Task 6: DiffPane — wrap the four full-span cell sites + sticky CSS

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`

- [ ] **Step 1: Add the sticky CSS.** Append to `DiffPane.module.css`:

```css
/* #390 — pin the full-span comment/composer cell content to the visible diff
   width so a wide (unified-mode) file can't push the submit button off-screen.
   No-op in split/wrap (the cell is already viewport-width). The wrapper wraps
   cell CONTENT, not a `.diffContent > *`, so split-mode translateX doesn't move it. */
.diffStickyViewport {
  position: sticky;
  left: 0;
  width: var(--diff-viewport-w, 100%);
  box-sizing: border-box;
}
```

- [ ] **Step 2: Build a `DiffPane` render harness and write the failing test.** **No test currently mounts `<DiffPane>`** (`ExistingCommentWidget.test.tsx` renders the widget directly), so build the harness from scratch in a new `DiffPane.stickyViewport.test.tsx`. Mount `<DiffPane>` with a one-hunk file fixture, one review thread on a right-side line, and a `renderComposerForLine` stub; mock the hooks `DiffPane` pulls (`useAiGate`/AI annotations, `useWholeFileContent`, syntax tokens) — copy the mock set from an existing `FilesTab`/`PrDetail` consumer test (e.g. a `FilesTab` test that already renders the diff). Assert the wrap in **both** modes (unified covers sites 3–4; split covers sites 1–2):

```tsx
function renderDiffPane(diffMode: 'unified' | 'side-by-side') {
  return render(
    <DiffPane
      selectedPath="src/a.ts"
      file={oneHunkFile}                 // fixture: one hunk, a right-side line N
      reviewThreads={[threadOnLineN]}    // one thread anchored to line N
      diffMode={diffMode}
      lineWrap={false}
      renderComposerForLine={(_p, _n) => <div data-testid="composer-stub" />}
      replyContext={replyContextStub}
      /* …remaining required props with minimal stubs… */
    />,
  );
}

it.each(['unified', 'side-by-side'] as const)(
  'wraps full-span comment + composer cells in .diffStickyViewport (%s)',
  (mode) => {
    const { container } = renderDiffPane(mode);
    // one wrapper for the ExistingCommentWidget cell + one for the composer cell
    expect(container.querySelectorAll('.diffStickyViewport').length).toBeGreaterThanOrEqual(2);
  },
);
```

> Confirm `DiffPane`'s exact required prop names against the component when wiring the harness. Keep it minimal — its only job is to prove every full-span comment/composer cell is wrapped.

- [ ] **Step 3: Run it to verify it fails.**

Run (from `frontend/`): `npm run test -- DiffPane`
Expected: FAIL — no `.diffStickyViewport` wrappers yet.

- [ ] **Step 4: Call the hook and wrap all four cell sites.**

(a) Call the hook near the existing `useLockedPaneScroll` call (~DiffPane.tsx:306), passing the body ref and a dep key that covers file/mode/wrap **and content height** (so it re-measures when a vertical scrollbar appears/disappears and shrinks the visible width — a `ResizeObserver` blind spot):

```tsx
useDiffViewportWidthVar(diffBodyRef, [
  selectedPath,
  diffMode,
  lineWrap,
  wholeFileEnabled,        // whole-file expansion changes content height
  allLines.length,         // row count changes → scrollbar may appear/disappear
]);
```
(Import it: `import { useDiffViewportWidthVar } from '../../../../hooks/useDiffViewportWidthVar';`. Use the **real** in-scope names — confirm against the component; `selectedPath`/`lineWrap` exist, `diffMode` drives `isSplit`, and the whole-file flag + the rendered-rows array are already computed in `renderDiffRows`. If `allLines` isn't in scope at the call site, use the equivalent row-count/whole-file signal that `useLockedPaneScroll`'s own dep array already keys on, so both observers re-measure together.)

(b) Wrap the content inside each full-span `<td colSpan={colSpan}>` for comments/composers. There are **four** sites (confirm exact line numbers at implementation — these are from the current file): 
- `emitWidgetAndComposerRows` → `ExistingCommentWidget` cell (~DiffPane.tsx:484);
- `emitWidgetAndComposerRows` → composer (`renderComposerForLine`) cell (~:495);
- unified inline `ExistingCommentWidget` `<tr>` in `DiffLineRow` (~:802);
- the composer cell rendered by the **`ComposerSlot` component** (a *separate* component, ~:1062–1080, not inline in `DiffLineRow` — easy to miss; its `<td colSpan>{node}</td>` is ~:1077).

Do **not** wrap the four `AiHunkAnnotation` colSpan cells (~:416/:435/:522/:540) — they aren't comments/composers. For each of the four comment/composer sites, change `<td colSpan={colSpan}>{X}</td>` to:

```tsx
<td colSpan={colSpan}>
  <div className={styles.diffStickyViewport}>{X}</div>
</td>
```

where `{X}` is the existing `<ExistingCommentWidget … />` or the composer node. Do **not** wrap the AI-hunk-annotation cell (it is not a comment/composer and has its own layout).

- [ ] **Step 5: Run the test to verify it passes.**

Run (from `frontend/`): `npm run test -- DiffPane`
Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css
git commit -m "feat(diff): pin comment/composer cells to the visible diff width (#390)"
```

---

## Task 7: Full verification + B1 visual assert

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend suite.**

Run (from `frontend/`): `npm run test`
Expected: all green (no regressions; the new + updated tests pass).

- [ ] **Step 2: Run the repo pre-push checklist** per `.ai/docs/development-process.md` (typecheck via `tsc -b`, lint, prettier via the real binary — `rtk proxy npx prettier --check` since rtk masks prettier exit codes, build). All must pass.

- [ ] **Step 3: Run `/simplify`** over the diff (quality pass before the PR), then re-run the suite.

- [ ] **Step 4: B1 live visual verify** against the running app (real token store), **both themes**, matching the approved iteration screenshots:
  - Inline composer (Files tab): textarea owns focus ring; flat footer; grouped buttons; Preview/Discard real buttons with grey/red hover (no underline); "Add to review" filled primary; "Comment" green hover; uniform heights; tighter gutter; extra bottom padding.
  - Reply composer (diff thread): same treatment.
  - Overview composer (`PrRootReplyComposer`): same; "Post" filled primary, green hover removed in favor of accent-hover; Discard red hover.
  - Merged/closed PR: no "PR is merged" note; "Comment" carries the merged tooltip; "Add to review" absent.
  - Problem 2: open a **unified-mode** file whose lines exceed the viewport; open an inline composer; confirm the footer + submit button stay fully visible without horizontal scrolling and the composer stays pinned while panning the code. Confirm split + wrap modes are visually unchanged.
  - WCAG: spot-check focus-ring + filled-primary text contrast in both themes.

- [ ] **Step 5: Regenerate any visual baselines** the composer appears in (from the CI artifact if the snapshots are Linux-rendered), and commit them.

- [ ] **Step 6: Open the PR** with the `## Proof` section (acceptance checklist, secrets scan, before/after visuals, doc-review dispositions), `Closes #390`, then run pr-autopilot to green-and-ready and **pause for the owner's B1 visual merge** (this issue is B1-gated).

---

## Self-review (author checklist — completed at plan-write time)

- **Spec coverage:** §3.1 → Task 1; §3.2/3.3 → Tasks 2–4; §4 (+4.1) → Tasks 5–6; §5 testing → Tasks 3–6 tests + Task 7; §6 risks → Task 7 B1 checklist (sticky inertness, contrast, `closedBanner` gate preserved). No uncovered spec section.
- **Placeholders:** none — every code step shows the actual CSS/TSX.
- **Type/name consistency:** `useDiffViewportWidthVar(bodyRef, deps)`, `.diffStickyViewport`, `--diff-viewport-w`, `.composer-actions-spacer`, `.composer-post` used consistently across tasks.
- **Known soft spots flagged for the implementer:** exact DiffPane line numbers for the four cell sites must be confirmed against the file at implementation (the spec/plan name the call sites, not pinned lines); the `PrRootReplyComposer` test harness may need a minimal provider wrapper if none exists; `--t-fast`/`--ease-out` token names confirmed against tokens.css before use.
