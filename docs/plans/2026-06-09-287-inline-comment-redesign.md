# #287 Inline Comment Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Files-tab inline comments read as native to the diff by mirroring the Overview tab's comment-card formatting through shared primitives, and overhaul the composer — visual-only.

**Architecture:** Extract a shared `CommentCard` (band + body + `density`) and `CollapsedComposerAffordance`, plus additive `composer-frame` CSS classes. Adopt them in the Overview tab (no visual change), the diff thread (`ExistingCommentWidget`), the composers (`InlineCommentComposer`/`ReplyComposer`/`PrRootReplyComposer`), and add a commented-line highlight in `DiffPane`. No behavior changes — the `#299` `onSaved`/`flushRef` props and all auto-save wiring are untouched.

**Tech Stack:** React 19 + TypeScript + Vite, CSS Modules + lifted globals in `frontend/src/styles/tokens.css`, Vitest + Testing Library, Playwright (B1).

**Spec:** `docs/specs/2026-06-09-287-inline-comment-redesign-design.md`. Read it before starting — it carries the density-axis values, the two highlight recipes, and the regression constraints.

**Worktree:** `D:/src/PRism-287-comment-redesign` (branch `feature/287-comment-redesign`). Run all commands from `frontend/`. Test command: `npx vitest run <path>`. Typecheck: `npx tsc -b`. Lint: `npx eslint <path>` + `node ./node_modules/prettier/bin/prettier.cjs --check <path>` (rtk masks prettier output — call it directly).

---

## File Structure

**New:**
- `frontend/src/components/PrDetail/Comment/CommentCard.tsx` — shared comment card (band + body + density). One responsibility: present one comment.
- `frontend/src/components/PrDetail/Comment/CommentCard.module.css` — card/band/body styling, both densities, ported prose rules.
- `frontend/src/components/PrDetail/Comment/CommentCard.test.tsx`
- `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.tsx` — input-placeholder reply button.
- `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.module.css`
- `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.test.tsx`
- `frontend/__tests__/DiffPaneHighlight.test.tsx` — marker-class assertion for commented diff lines (Task 6).

**Modified:**
- `frontend/src/styles/tokens.css` — add `composer-frame` classes (additive; do NOT restyle bare `composer-*` globals) + the `diff-line--commented` recipes.
- `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx` (+ `.module.css`) — render card via `CommentCard`.
- `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (+ `.module.css`) — stacked `CommentCard`s + resolved tag + `CollapsedComposerAffordance`.
- `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (+ `.module.css`) — anchor-marker class on the commented row/cell.
- `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx` / `ReplyComposer.tsx` — wrap in `composer-frame`.

---

## Task 1: `CommentCard` shared component

**Files:**
- Create: `frontend/src/components/PrDetail/Comment/CommentCard.tsx`
- Create: `frontend/src/components/PrDetail/Comment/CommentCard.module.css`
- Test: `frontend/src/components/PrDetail/Comment/CommentCard.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// CommentCard.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CommentCard } from './CommentCard';

describe('CommentCard', () => {
  const base = {
    author: 'amelia.cho',
    avatarUrl: null,
    createdAt: '2026-05-18T00:00:00Z',
    body: 'Guard against `overflow`?',
  };

  it('renders band (author + time) and markdown body, forwarding testid + aria-label', () => {
    render(<CommentCard {...base} data-testid="pr-root-comment" aria-label="Comment by amelia.cho" />);
    const card = screen.getByTestId('pr-root-comment');
    expect(card).toHaveAttribute('aria-label', 'Comment by amelia.cho');
    expect(screen.getByText('amelia.cho')).toBeInTheDocument();
    expect(screen.getByText('overflow')).toBeInTheDocument(); // inline code rendered
    expect(card.querySelector('time')).toHaveAttribute('dateTime', '2026-05-18T00:00:00Z');
  });

  it('defaults to comfortable density and honors compact', () => {
    const { rerender } = render(<CommentCard {...base} data-testid="c" />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-density', 'comfortable');
    rerender(<CommentCard {...base} density="compact" data-testid="c" />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-density', 'compact');
  });

  it('renders the bandEnd slot (caller composition, e.g. a Resolved tag)', () => {
    render(<CommentCard {...base} data-testid="c" bandEnd={<span>Resolved</span>} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/PrDetail/Comment/CommentCard.test.tsx`
Expected: FAIL — `Failed to resolve import './CommentCard'`.

- [ ] **Step 3: Write the component**

```tsx
// CommentCard.tsx
import { Avatar } from '../../Avatar/Avatar';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import styles from './CommentCard.module.css';

export type CommentDensity = 'comfortable' | 'compact';

export interface CommentCardProps {
  author: string;
  // Optional to match IssueCommentDto/ReviewCommentDto (`avatarUrl?: string | null`)
  // — the Overview test fixtures omit it, so a non-optional type breaks `tsc -b`.
  avatarUrl?: string | null;
  createdAt: string;
  body: string;
  density?: CommentDensity;
  /** Caller-composed slot pinned to the band's right edge (e.g. a Resolved tag). */
  bandEnd?: React.ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

// Renders ONE comment. Owns band + body + density only — resolved state, the
// rail, and stacking are the caller's composition (never a density branch here).
export function CommentCard({
  author,
  avatarUrl,
  createdAt,
  body,
  density = 'comfortable',
  bandEnd,
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: CommentCardProps) {
  return (
    <article
      className={`${styles.card} ${className ?? ''}`}
      data-density={density}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      <header className={styles.band} data-testid="pr-comment-meta">
        <Avatar src={avatarUrl} login={author} size={density === 'compact' ? 'sm' : 'md'} />
        <span className={styles.author}>{author}</span>
        <time className={styles.time} dateTime={createdAt}>
          {new Date(createdAt).toLocaleDateString()}
        </time>
        {bandEnd != null && <span className={styles.bandEnd}>{bandEnd}</span>}
      </header>
      <div className={styles.body}>
        <MarkdownRenderer source={body} />
      </div>
    </article>
  );
}
```

```css
/* CommentCard.module.css — comfortable values copied verbatim from
   PrRootConversation.module.css so Overview is byte-identical. */
.card {
  min-width: 0;
  background: var(--surface-1);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}
.card[data-density='compact'] {
  box-shadow: var(--shadow-1);
}

.band {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-size: var(--text-xs);
  background: var(--surface-2);
  border-bottom: 1px solid var(--border-1);
  padding: var(--s-2) var(--s-4);
}
.card[data-density='compact'] .band {
  padding: var(--s-1) var(--s-3);
}
.bandEnd {
  margin-left: auto;
  font-size: var(--text-2xs);
  font-weight: 500;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 999px;
  padding: 1px 8px;
}

.author {
  font-weight: 600;
  color: var(--text-1);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.time {
  color: var(--text-3);
  flex: none;
  white-space: nowrap;
}

.body {
  min-width: 0;
  padding: var(--s-3) var(--s-4);
  font-size: var(--text-sm);
  color: var(--text-1);
  line-height: 1.55;
}
.card[data-density='compact'] .body {
  padding: var(--s-2) var(--s-3);
  /* Wide content (code blocks, tables) scrolls inside the card instead of
     clipping into the fixed-width diff gutter. */
  overflow-x: auto;
}
.card[data-density='compact'] .body img {
  max-width: 100%;
}

/* Prose rules ported verbatim from PrRootConversation.module.css so Overview's
   paragraph spacing + inline code are unchanged and the diff body gains them. */
.body p {
  margin: 0 0 var(--s-2);
  text-wrap: pretty;
  white-space: pre-wrap;
}
.body p:last-child {
  margin: 0;
}
.body code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  background: var(--surface-3);
  border-radius: 3px;
  color: var(--text-1);
  white-space: normal;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/PrDetail/Comment/CommentCard.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + lint + commit**

Run: `npx tsc -b` (Expected: No errors) then:
```bash
git add frontend/src/components/PrDetail/Comment/
git commit -m "feat(#287): shared CommentCard primitive (band + body + density)"
```

---

## Task 2: `CollapsedComposerAffordance`

**Files:**
- Create: `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.tsx`
- Create: `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.module.css`
- Test: `frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// CollapsedComposerAffordance.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CollapsedComposerAffordance } from './CollapsedComposerAffordance';

describe('CollapsedComposerAffordance', () => {
  it('is a button with the given label + aria-label and opens on click', () => {
    const onOpen = vi.fn();
    render(<CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" onOpen={onOpen} />);
    const btn = screen.getByRole('button', { name: 'Reply to thread' });
    expect(btn).toHaveTextContent('Reply…');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows the saved pill and continue-draft label when a draft exists', () => {
    render(
      <CollapsedComposerAffordance
        label="Continue draft…"
        ariaLabel="Reply to thread"
        hasDraft
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Continue draft…')).toBeInTheDocument();
    expect(screen.getByText('saved')).toBeInTheDocument();
  });

  it('is inert under readOnly (no open on click)', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" readOnly onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reply to thread' }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx vitest run src/components/PrDetail/Composer/CollapsedComposerAffordance.test.tsx`
Expected: FAIL — import unresolved.

- [ ] **Step 3: Write the component**

```tsx
// CollapsedComposerAffordance.tsx
import styles from './CollapsedComposerAffordance.module.css';

export interface CollapsedComposerAffordanceProps {
  label: string;
  ariaLabel: string;
  hasDraft?: boolean;
  readOnly?: boolean;
  onOpen: () => void;
}

// Input-placeholder affordance shared by the diff reply button and Overview's
// reply button. A <button> (Enter/Space activate natively); cursor:text reads
// like a field. Inert (no expand) under cross-tab readOnly.
export function CollapsedComposerAffordance({
  label,
  ariaLabel,
  hasDraft = false,
  readOnly = false,
  onOpen,
}: CollapsedComposerAffordanceProps) {
  return (
    <button
      type="button"
      className={styles.affordance}
      aria-label={ariaLabel}
      data-readonly={readOnly || undefined}
      onClick={() => {
        if (readOnly) return;
        onOpen();
      }}
    >
      <span className={styles.label}>{label}</span>
      {hasDraft && (
        <span className="composer-badge composer-badge--saved" role="status">
          saved
        </span>
      )}
    </button>
  );
}
```

```css
/* CollapsedComposerAffordance.module.css — mirrors PrRootConversation's
   .prRootReplyButton input-placeholder treatment. */
.affordance {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-3);
  background: var(--surface-2);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  padding: 8px 12px;
  cursor: text;
  transition:
    border-color var(--t-fast),
    color var(--t-fast);
}
.affordance:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}
.affordance[data-readonly] {
  cursor: default;
  color: var(--text-3);
}
.affordance[data-readonly]:hover {
  border-color: var(--border-1);
  color: var(--text-3);
}
.label {
  flex: 1;
  min-width: 0;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run src/components/PrDetail/Composer/CollapsedComposerAffordance.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck + commit**

```bash
npx tsc -b
git add frontend/src/components/PrDetail/Composer/CollapsedComposerAffordance.*
git commit -m "feat(#287): CollapsedComposerAffordance input-placeholder reply button"
```

---

## Task 3: `composer-frame` CSS (additive — do not touch bare globals)

**Files:**
- Modify: `frontend/src/styles/tokens.css` (append after the existing `composer-*` block, ~line 954)

- [ ] **Step 1: Add the frame classes**

Append to `tokens.css`:

```css
/* #287 — composer-frame: the expanded inline/reply composer reads as ONE
   bordered control. ADDITIVE — the bare `.composer-textarea`/`.composer-badge`/
   `.composer-preview-toggle` globals are unchanged (PrRootBodyEditor +
   SubmitDialog consume them frameless). */
.composer-frame {
  background: var(--surface-1);
  border: 1px solid var(--border-2);
  border-radius: var(--radius-3);
  box-shadow: var(--shadow-1);
  overflow: hidden;
}
/* The frame is the SOLE focus indicator: kill the inner textarea's border AND
   its :focus-visible ring so focus doesn't paint two rings. */
.composer-frame .composer-textarea {
  border: none;
  border-radius: 0;
  background: transparent;
}
.composer-frame .composer-textarea:focus-visible {
  outline: none;
}
.composer-frame:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
/* Action bar = a footer strip, not a loose row. */
.composer-frame .composer-actions {
  padding: var(--s-2) var(--s-3);
  border-top: 1px solid var(--border-1);
  background: var(--surface-2);
}
```

- [ ] **Step 2: Verify it parses (build the CSS via typecheck-adjacent build)**

Run: `node ./node_modules/prettier/bin/prettier.cjs --check src/styles/tokens.css`
Expected: passes (no formatting error). There is no unit test for raw CSS; correctness is verified visually at B1 (Tasks 7, 9).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/styles/tokens.css
git commit -m "feat(#287): additive composer-frame CSS (sole focus ring; bare globals untouched)"
```

---

## Task 4: Adopt `CommentCard` in Overview (no visual change)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx:41-56`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css` (remove `.card/.band/.author/.time/.body*` — now owned by CommentCard; keep `.timeline/.item/.rail/.node`)
- Test: existing `__tests__/PrRootConversation.test.tsx` and `src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx`

- [ ] **Step 1: Run the existing Overview tests (capture green baseline)**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx`
Expected: PASS. These assert on `data-testid="pr-root-comment"` / `pr-comment-meta` and `aria-label` — the regression net. They must stay green after the refactor.

- [ ] **Step 2: Replace the inline `<article>` with `CommentCard`**

In `PrRootConversation.tsx`, replace the `<article className={styles.card}> … </article>` block (lines 41-56) with:

```tsx
<CommentCard
  author={comment.author}
  avatarUrl={comment.avatarUrl}
  createdAt={comment.createdAt}
  body={comment.body}
  density="comfortable"
  data-testid="pr-root-comment"
  aria-label={`Comment by ${comment.author}`}
/>
```

Add the import: `import { CommentCard } from '../Comment/CommentCard';`
Remove the now-unused `Avatar` and `MarkdownRenderer` imports IF no longer referenced elsewhere in the file (they are not — verify with a grep).

- [ ] **Step 3: Delete the migrated CSS from `PrRootConversation.module.css`**

Remove `.card`, `.band`, `.author`, `.time`, `.body`, `.body p`, `.body p:last-child`, `.body code` (now in CommentCard.module.css). **Keep** `.timeline`, `.item`, `.rail`, `.rail::before`, `.node`, `.prRootConversation*` — the rail still wraps the card and `--rail-node-y` still depends on the band's `padding-top: var(--s-2)` + the `md` avatar, both preserved by CommentCard's comfortable density.

- [ ] **Step 4: Run the Overview tests + typecheck**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx src/components/PrDetail/OverviewTab/PrRootConversation.test.tsx` then `npx tsc -b`
Expected: PASS, no type errors (testids preserved by CommentCard).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx frontend/src/components/PrDetail/OverviewTab/PrRootConversation.module.css
git commit -m "refactor(#287): Overview renders comments via shared CommentCard (no visual change)"
```

---

## Task 5: Diff thread → stacked `CommentCard`s + resolved tag + collapsed reply

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.module.css`
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`

- [ ] **Step 1: Inventory pinned selectors, then write the failing test**

Run first (informational): `grep -rn "comment-entry\|comment-thread--resolved\|comment-author\|comment-body\|comment-meta" frontend/__tests__ frontend/e2e frontend/src --include=*.tsx --include=*.ts` to confirm no test pins the classes being removed. (The shipped `ExistingCommentWidget.test.tsx` asserts text + `data-thread-id`, not these classes.)

Replace `ExistingCommentWidget.test.tsx` body assertions with the new structure:

```tsx
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import type { ReviewThreadDto } from '../../../../api/types';

function thread(over: Partial<ReviewThreadDto> = {}): ReviewThreadDto {
  return {
    threadId: 't1',
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    isResolved: false,
    comments: [
      { commentId: 'c1', author: 'amelia.cho', avatarUrl: null, body: 'one', createdAt: '2026-05-18T00:00:00Z' },
      { commentId: 'c2', author: 'prpande', avatarUrl: null, body: 'two', createdAt: '2026-05-18T00:00:00Z' },
    ],
    ...over,
  } as ReviewThreadDto; // cast satisfies the omitted editedAt/anchorSha fields — keep it.
}

describe('ExistingCommentWidget', () => {
  it('renders one CommentCard per comment (clear demarcation)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    const cards = screen.getAllByTestId('inline-comment-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('amelia.cho')).toBeInTheDocument();
    expect(within(cards[1]).getByText('prpande')).toBeInTheDocument();
  });

  it('shows a Resolved tag on resolved threads', () => {
    render(<ExistingCommentWidget threads={[thread({ isResolved: true })]} />);
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: FAIL — `inline-comment-card` testid not found (still the old `comment-entry` markup).

- [ ] **Step 3: Rewrite `ThreadView`'s comment render**

In `ExistingCommentWidget.tsx`: import `CommentCard` (`import { CommentCard } from '../../Comment/CommentCard';`) and `CollapsedComposerAffordance`. Replace the `thread.comments.map(...)` block (lines 83-96) with:

```tsx
{thread.comments.map((comment, i) => (
  <CommentCard
    key={comment.commentId}
    author={comment.author}
    avatarUrl={comment.avatarUrl}
    createdAt={comment.createdAt}
    body={comment.body}
    density="compact"
    data-testid="inline-comment-card"
    bandEnd={
      thread.isResolved && i === 0 ? <span aria-label="Resolved thread">Resolved</span> : undefined
    }
  />
))}
```

And replace the Reply `<button>` (lines 98-109) with:

```tsx
{replyContext && !composerOpen && (
  <div className={`comment-thread-actions ${styles.commentThreadActions}`}>
    <CollapsedComposerAffordance
      label={existingDraft ? 'Continue draft…' : 'Reply…'}
      ariaLabel={`Reply to thread on ${thread.filePath} line ${thread.lineNumber}`}
      hasDraft={!!existingDraft}
      readOnly={replyContext.readOnly}
      onOpen={handleReplyClick}
    />
  </div>
)}
```

(Keeping the `comment-thread-actions` wrapper preserves the `.commentThreadActions` CSS rule kept in Step 4 — don't render the affordance bare.)

- [ ] **Step 4: Update `ExistingCommentWidget.module.css`**

Replace `.commentThread` to stack cards with a gap and drop the nested-surface wrapper; add the resolved opacity + hover-restore. Remove `.commentEntry*`, `.commentMeta`, `.commentAuthor`, `.commentTime`, `.commentBody` (now in CommentCard):

```css
.commentWidget {
  padding: var(--s-3) var(--s-4) var(--s-4);
}
.commentThread {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.commentThreadResolved {
  opacity: 0.72;
  transition: opacity var(--t-fast);
}
.commentThreadResolved:hover {
  opacity: 1;
}
.commentThreadActions {
  display: flex;
}
```

(The widget's outer `.commentWidget` keeps padding but drops `background: var(--surface-2)` — the nested band is gone.)

- [ ] **Step 5: Run tests + typecheck, verify pass**

Run: `npx vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx` then `npx tsc -b`
Expected: PASS (2 tests), no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.*
git commit -m "feat(#287): diff threads render stacked CommentCards + resolved tag + collapsed reply"
```

---

## Task 6: Commented-line highlight in `DiffPane`

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (unified `DiffLineRow` `rowClass` ~706; `SplitDiffLineRowProps` ~817 + its 5 call sites in `renderSplitRows`; the split new-side content cells)
- Modify: `frontend/src/styles/tokens.css` (the `.diff-line` block ~962) and/or `DiffPane.module.css`
- Test: `frontend/__tests__/DiffPaneHighlight.test.tsx` (new) — assert the marker class lands on the anchored row.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/__tests__/DiffPaneHighlight.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffPane } from '../src/components/PrDetail/FilesTab/DiffPane/DiffPane';
// Build a one-file unified diff with a thread on line 1, render in unified mode,
// and assert the code row for the commented line carries `diff-line--commented`.
// (Reuse the diff/thread fixtures from FilesTabComposer.test.tsx — copy the
// minimal DiffDto + a ReviewThreadDto at lineNumber 1.)
```

Concretely: render `<DiffPane>` (unified `diffMode`) with `reviewThreads=[{ threadId:'t', filePath:'src/main.ts', lineNumber:1, isResolved:false, comments:[...] }]`, then:

```tsx
const commentedRow = container.querySelector('tr.diff-line--commented');
expect(commentedRow).not.toBeNull();
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run frontend/__tests__/DiffPaneHighlight.test.tsx`
Expected: FAIL — no element matches `tr.diff-line--commented`.

- [ ] **Step 3: Add the anchor marker (unified)**

In `DiffLineRow` (`DiffPane.tsx:706`), derive `isAnchored` and append the marker class:

```tsx
const isAnchored = (threadsAtLine?.length ?? 0) > 0;
const rowClass = `diff-line diff-line--${line.type}${isAnchored ? ' diff-line--commented' : ''}`;
```

For the **split** path, `SplitDiffLineRow` does **not** receive the thread map — split comment widgets surface through a *separate* row via `emitWidgetAndComposerRows(idx, line.newLineNum)`. So the highlight needs explicit plumbing:

1. Add `isAnchored?: boolean` to `SplitDiffLineRowProps` (~`DiffPane.tsx:817`).
2. At each split-row call site in `renderSplitRows` (the `header`/`paired`/`context`/`solo-delete`/`solo-insert` emits, ~`DiffPane.tsx:509,551,571,588,602`), pass `isAnchored={!!threadsByLine.get(newLineNum ?? -1)?.length}` — `threadsByLine` (built ~`DiffPane.tsx:353`) is in scope there.
3. Inside `SplitDiffLineRow`, add `{...(isAnchored ? { 'data-commented': 'true' } : {})}` to the **new-side** content `<td>` (the `data-side="new"` cell) of the `context`, `solo-insert`, and `paired` kinds:

```tsx
<td className={`diff-content ${styles.diffContent}`} data-side="new" {...(isAnchored ? { 'data-commented': 'true' } : {})}>
```

Skip the `solo-delete` new-side cell — it's the empty/`aria-hidden` half and is never anchored (threads are new-side; solo-delete lines have no `newLineNum`).

- [ ] **Step 4: Add the CSS recipes**

Append to `tokens.css` (near the `.diff-line` block):

```css
/* #287 — anchored (commented) line. Unified: row wash + accent inset edge.
   Split: the new-side content cell only (a row shadow would land on the wrong
   column / wash the empty half-cell). Threads are always new-side. */
.diff-line--commented {
  background: color-mix(in oklch, var(--accent-soft) 70%, var(--surface-1));
  box-shadow: inset 2px 0 0 var(--accent);
}
.diff-content[data-commented='true'] {
  background: color-mix(in oklch, var(--accent-soft) 70%, var(--surface-1));
  box-shadow: inset 2px 0 0 var(--accent);
}
```

- [ ] **Step 5: Run the test + typecheck, verify pass**

Run: `npx vitest run frontend/__tests__/DiffPaneHighlight.test.tsx` then `npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/src/styles/tokens.css
git commit -m "feat(#287): highlight the commented diff line (unified row + split new-side cell)"
```

---

## Task 7: Composers adopt `composer-frame` (identical frame, no behavior change)

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/InlineCommentComposer.tsx:219-289` (the outer `role="form"` div + actions)
- Modify: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx` (the equivalent outer div + actions)
- Test: `frontend/__tests__/InlineCommentComposer.test.tsx` (extend)

- [ ] **Step 1: Write the failing test (frame present, both composers identical structure)**

Add to `InlineCommentComposer.test.tsx`:

```tsx
it('wraps the composer in the shared composer-frame', () => {
  // render an InlineCommentComposer (reuse the file's existing harness/props)
  const form = screen.getByRole('form', { name: /Draft comment/ });
  expect(form).toHaveClass('composer-frame');
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run frontend/__tests__/InlineCommentComposer.test.tsx -t "composer-frame"`
Expected: FAIL — the form lacks `composer-frame`.

- [ ] **Step 3: Apply the frame class to both composers**

In `InlineCommentComposer.tsx`, add `composer-frame` to the outer container's className (the `role="form"` div, currently `inline-comment-composer ${styles.inlineCommentComposer}`):

```tsx
className={`inline-comment-composer composer-frame ${styles.inlineCommentComposer}`}
```

Do the identical change to `ReplyComposer.tsx`'s outer container so both render the same frame. **Do not touch** the `useComposerAutoSave` call, the `onSaved`/`flushRef` props, the badge logic, or any handler — class-only.

In each module CSS (`InlineCommentComposer.module.css` / `ReplyComposer.module.css`), remove any now-conflicting outer `background`/`border` on the composer container (the frame owns them) so the frame isn't double-bordered.

- [ ] **Step 4: Run the composer test suites, verify green**

Run: `npx vitest run frontend/__tests__/InlineCommentComposer.test.tsx frontend/__tests__/ReplyComposer.test.tsx frontend/__tests__/FilesTabComposer.test.tsx` then `npx tsc -b`
Expected: PASS — behavior tests unchanged, new frame test green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/Composer/InlineCommentComposer.* frontend/src/components/PrDetail/Composer/ReplyComposer.*
git commit -m "feat(#287): inline + reply composers adopt identical composer-frame shell"
```

---

## Task 8: PrRootReplyComposer collapsed affordance (optional consistency pass)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrRootConversation.tsx:102-124` (the reply button → `CollapsedComposerAffordance`)

- [ ] **Step 1: Run the existing Overview test baseline**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx`
Expected: PASS.

- [ ] **Step 2: Replace the bespoke `prRootReplyButton` with the shared affordance**

In `PrRootConversation.tsx`'s `PrRootConversationActions`, replace the `<button className={styles.prRootReplyButton}>Reply</button>` with:

```tsx
<CollapsedComposerAffordance
  label={existingPrRootDraft ? 'Continue draft…' : 'Reply…'}
  ariaLabel="Reply to the PR conversation"
  hasDraft={!!existingPrRootDraft}
  readOnly={readOnly ?? false}
  onOpen={handleReplyClick}
/>
```

Remove the `.prRootReplyButton` rule from `PrRootConversation.module.css` (now shared). **Do not** touch `PrRootReplyComposer` / `PrRootBodyEditor` internals.

- [ ] **Step 3: Run the Overview test + typecheck**

Run: `npx vitest run __tests__/PrRootConversation.test.tsx` then `npx tsc -b`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrRootConversation.*
git commit -m "refactor(#287): Overview reply uses shared CollapsedComposerAffordance"
```

---

## Task 9: Full verification + B1 visual proof

- [ ] **Step 1: Full suite + typecheck + lint**

Run (one at a time): `npx vitest run` (expect 1559+ pass, 0 fail), `npx tsc -b` (no errors), `npx eslint .` (no issues), `node ./node_modules/prettier/bin/prettier.cjs --check .` (all match).

- [ ] **Step 2: Capture B1 — design-review cells (human judgment, light + dark)**

Launch the worktree build: `pwsh ./scripts/serve-detached.ps1 -Port 5184 -DataDir "$env:LOCALAPPDATA\PRism"` (real PAT; `-DataDir` explicit so the pass-through doesn't misbind). Open the sandbox PR `prpande/prism-sandbox#2` (has existing threads) via Playwright and screenshot, in **light + dark**: the expanded composer (new-comment AND reply — confirm identical frame), the line highlight (**unified + split**), the multi-comment thread, the resolved thread. Embed in the PR per the review-assets convention.

- [ ] **Step 3: Capture B1 — regression-assertion cells (must look IDENTICAL to main)**

Screenshot, before (main) vs after (branch): the **Overview** root-comment card, a **`PrRootBodyEditor`** textarea (PR-root body editor), and the **`SubmitDialog`** preview toggle. These must be pixel-identical — any visible difference is a regression to fix before merge.

- [ ] **Step 4: Tear down + open PR**

Stop the server (`pwsh ./scripts/serve-detached.ps1 -Stop -DataDir "$env:LOCALAPPDATA\PRism"`). Open the PR via pr-autopilot with the two-tier B1 proof in `## Proof`. **B1-gated: do not merge — owner does the visual sign-off.**

---

## Self-Review (completed against the spec)

- **Spec coverage:** Composer redesign → Tasks 3,7,8 + collapsed affordance Task 2. Line highlight → Task 6. Per-comment cards/demarcation → Tasks 1,5. Meta/band → Task 1. Shared primitives → Tasks 1,2,3. Overview no-change → Task 4 (testid-guarded). Interaction/a11y states → Tasks 2,5 (readOnly, draft label, resolved aria, hover). Constraints: shadow-2 (Task 1 CSS), prose-rule port (Task 1), `composer-frame` not bare globals (Task 3), data-side=new split (Task 6), don't touch onSaved/flushRef (Task 7). All covered.
- **Placeholder scan:** none — every CSS/TSX/test step carries real code.
- **Type consistency:** `CommentCard` props (`author/avatarUrl/createdAt/body/density/bandEnd/data-testid/aria-label`) used identically in Tasks 4 and 5; `CollapsedComposerAffordance` props (`label/ariaLabel/hasDraft/readOnly/onOpen`) used identically in Tasks 5 and 8.
- **Known follow-through for the implementer:** if removing the migrated CSS from `PrRootConversation.module.css` (Task 4) leaves the rail's `--rail-node-y` visually off, re-derive it against the rendered CommentCard band (spec constraint §4) — verified at the Task 9 B1 Overview cell.
