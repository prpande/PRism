# File-tree per-file comment indicator (#513) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a per-file comment indicator in the PR-detail Files tree — a fixed left rail with a three-state comment glyph (none / unresolved / resolved) driven off already-loaded `PrDetailDto.reviewComments`, plus a full-row hover/selected highlight spanning all four tree columns.

**Architecture:** Extract the inbox comment octicon into a shared `CommentGlyph`. Derive a `Map<path, 'unresolved'|'resolved'>` in `FilesTab` and thread it into `FileTree`. Add a fixed left column (mirroring the existing right-side AI/checkbox fixed columns) that collapses to width 0 when the PR has no threads. Replace the name-cell-only native `:hover`/selected backgrounds with lifted `hoveredPath` state + `selectedPath`, painted across all four columns via `data-row-hovered`/`data-row-selected` attributes so the highlight is one continuous bar.

**Tech Stack:** React + TypeScript + Vite, CSS Modules (`composes:`), oklch design tokens, vitest + React Testing Library, Playwright (visual proof).

## Global Constraints

- Frontend-only. No backend, DTO, wire, or API change. Data source is the already-loaded `prDetail.reviewComments: ReviewThreadDto[]`.
- Three states only, **no count**: none (blank), unresolved (solid `var(--accent)`), resolved (`var(--accent)` @ `opacity: 0.45`).
- Glyph is Octicon `comment-16`, one shared component so inbox + tree cannot drift.
- The left rail has **no border/seam** and **collapses to width 0** when the PR has zero threads (mirrors the AI column's `data-ai-on` gate).
- Hover (`var(--surface-3)`) and selected (`color-mix(in oklch, var(--accent-soft) 40%, var(--surface-2))`) backgrounds span **all four** columns (comment, name, AI, checkbox). **Selected wins** over hover when a row is both.
- Rail is `aria-hidden`; the spoken signal lives in the row in reading order: status word → filename → AI focus → comment state.
- Directory rows are never selectable; they participate in hover (continuous bar over empty gutters — intentional).
- Prettier + eslint gate CI (`npm run lint`); `_`-prefixed args are ignored by no-unused-vars. Run the full FE suite after aria/attribute/CSS changes.

---

### Task 1: `CommentGlyph` shared component + InboxRow swap

**Files:**
- Create: `frontend/src/components/shared/CommentGlyph.tsx`
- Create: `frontend/src/components/shared/CommentGlyph.test.tsx`
- Modify: `frontend/src/components/Inbox/InboxRow.tsx:247-263` (replace inline `<svg>` with `<CommentGlyph>`)

**Interfaces:**
- Produces: `CommentGlyph({ className }: { className?: string }): JSX.Element` — renders Octicon `comment-16` at 12×12, `fill="currentColor"`, `aria-hidden="true"`, forwarding `className` to the `<svg>`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/shared/CommentGlyph.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CommentGlyph } from './CommentGlyph';

describe('CommentGlyph', () => {
  it('renders an aria-hidden currentColor svg', () => {
    const { container } = render(<CommentGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('forwards className to the svg', () => {
    const { container } = render(<CommentGlyph className="foo" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('foo');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/shared/CommentGlyph.test.tsx`
Expected: FAIL — `Failed to resolve import './CommentGlyph'`.

- [ ] **Step 3: Write the component**

```tsx
// frontend/src/components/shared/CommentGlyph.tsx
// Shared Octicon comment-16. Single source for the inbox PR-row comment-count
// glyph (#501) and the file-tree per-file comment indicator (#513) so the two
// sites cannot drift in shape. State-agnostic: colour comes from the consumer
// via currentColor; the consumer attaches sizing/layout through className.
interface CommentGlyphProps {
  /** Layout/sizing class for the host (e.g. the inbox pill-icon class). */
  className?: string;
}

export function CommentGlyph({ className }: CommentGlyphProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5a.25.25 0 0 0 .25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z" />
    </svg>
  );
}
```

- [ ] **Step 4: Swap InboxRow to consume it**

In `frontend/src/components/Inbox/InboxRow.tsx`, add the import near the other component imports:

```tsx
import { CommentGlyph } from '../shared/CommentGlyph';
```

Replace the comment-metric `<svg>…</svg>` block (currently lines 250-260) so the cell reads:

```tsx
<span className={styles.metricCell}>
  {pr.commentCount > 0 && (
    <span className={styles.comments}>
      {/* Octicon comment-16 — signals the number is a comment count. Shared
          with the file-tree indicator (#513); MUST keep the .commentIcon class
          (composes metricPillIcon: load-bearing pill-icon sizing/accent). */}
      <CommentGlyph className={styles.commentIcon} />
      {pr.commentCount}
    </span>
  )}
</span>
```

(The `styles.commentIcon` class — `composes: metricPillIcon` — is passed through unchanged; the file-icon `<svg>` below it is untouched.)

- [ ] **Step 5: Run tests to verify they pass (glyph + inbox regression)**

Run: `cd frontend && npx vitest run src/components/shared/CommentGlyph.test.tsx src/components/Inbox/InboxRow.test.tsx`
Expected: PASS — including the existing `renders the comment count with an accent comment glyph` / 3-digit cases (they assert `comments.querySelector('svg')` and the count text, both preserved).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/shared/CommentGlyph.tsx frontend/src/components/shared/CommentGlyph.test.tsx frontend/src/components/Inbox/InboxRow.tsx
git commit -m "feat(#513): extract shared CommentGlyph; swap InboxRow onto it"
```

---

### Task 2: Per-file comment-state derivation

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts`
- Create: `frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts`

**Interfaces:**
- Produces:
  - `type CommentIndicatorState = 'unresolved' | 'resolved'`
  - `deriveCommentStateByPath(threads: ReviewThreadDto[]): Map<string, CommentIndicatorState>` — a path appears iff it has ≥1 thread; `'unresolved'` if any thread on that path is unresolved, else `'resolved'`. Unresolved wins on mixed.

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts
import { describe, it, expect } from 'vitest';
import { deriveCommentStateByPath } from './commentIndicatorState';
import type { ReviewThreadDto } from '../../../api/types';

const thread = (filePath: string, isResolved: boolean): ReviewThreadDto => ({
  threadId: `${filePath}:${isResolved}`,
  filePath,
  lineNumber: 1,
  anchorSha: 'sha',
  isResolved,
  comments: [],
});

describe('deriveCommentStateByPath', () => {
  it('omits paths with no threads', () => {
    expect(deriveCommentStateByPath([]).size).toBe(0);
  });

  it('marks a path unresolved when it has an open thread', () => {
    const m = deriveCommentStateByPath([thread('a.ts', false)]);
    expect(m.get('a.ts')).toBe('unresolved');
  });

  it('marks a path resolved when all its threads are resolved', () => {
    const m = deriveCommentStateByPath([thread('a.ts', true), thread('a.ts', true)]);
    expect(m.get('a.ts')).toBe('resolved');
  });

  it('unresolved wins on a mixed path regardless of order', () => {
    expect(deriveCommentStateByPath([thread('a.ts', true), thread('a.ts', false)]).get('a.ts')).toBe(
      'unresolved',
    );
    expect(deriveCommentStateByPath([thread('a.ts', false), thread('a.ts', true)]).get('a.ts')).toBe(
      'unresolved',
    );
  });

  it('keys each path independently', () => {
    const m = deriveCommentStateByPath([thread('a.ts', false), thread('b.ts', true)]);
    expect(m.get('a.ts')).toBe('unresolved');
    expect(m.get('b.ts')).toBe('resolved');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/commentIndicatorState.test.ts`
Expected: FAIL — `Failed to resolve import './commentIndicatorState'`.

- [ ] **Step 3: Write the derivation**

```ts
// frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts
import type { ReviewThreadDto } from '../../../api/types';

// Three visual states collapse to two map values (absent key ⇒ 'none').
export type CommentIndicatorState = 'unresolved' | 'resolved';

// A path is 'unresolved' if ANY thread on it is open, else 'resolved' (it has
// threads and every one is resolved). Unresolved wins on mixed: once set it is
// never downgraded, and a later open thread upgrades a resolved entry.
export function deriveCommentStateByPath(
  threads: ReviewThreadDto[],
): Map<string, CommentIndicatorState> {
  const m = new Map<string, CommentIndicatorState>();
  for (const t of threads) {
    if (!t.isResolved) {
      m.set(t.filePath, 'unresolved');
    } else if (m.get(t.filePath) !== 'unresolved') {
      m.set(t.filePath, 'resolved');
    }
  }
  return m;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/commentIndicatorState.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/commentIndicatorState.ts frontend/src/components/PrDetail/FilesTab/commentIndicatorState.test.ts
git commit -m "feat(#513): derive per-file comment-indicator state map"
```

---

### Task 3: Fixed left comment rail in `FileTree` (render + collapse)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (prop, `data-has-comments`, comment column + `CommentSlot`)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (token, column, slot, state classes)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx` (new assertions)

**Interfaces:**
- Consumes: `CommentIndicatorState` from `./commentIndicatorState` (Task 2).
- Produces (new `FileTreeProps` member): `commentStateByPath?: Map<string, CommentIndicatorState> | null` — optional/nullable so non-FilesTab callers omit it; missing/null/empty ⇒ rail collapsed, every slot blank.
- Produces: each file's comment slot carries `data-comment-state={'none'|'unresolved'|'resolved'}` and `data-row-path={path}`; the `.fileTree` root carries `data-has-comments={'0'|'1'}`.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx`. If the file lacks a shared render helper with `commentStateByPath`, add this local one in the new `describe`:

```tsx
import type { CommentIndicatorState } from './commentIndicatorState';

function renderWithComments(
  files: FileChange[],
  commentStateByPath: Map<string, CommentIndicatorState> | null,
) {
  return render(
    <FileTree
      files={files}
      selectedPath={null}
      onSelectFile={() => {}}
      viewedPaths={new Set()}
      onToggleViewed={() => {}}
      focusEntries={null}
      focusStatus="no-changes"
      aiPreview={false}
      commentStateByPath={commentStateByPath}
    />,
  );
}

describe('FileTree comment rail (#513)', () => {
  const f = (path: string): FileChange => ({ path, status: 'modified', hunks: [] });

  it('collapses the rail (data-has-comments=0) when there are no threads', () => {
    const { getByTestId } = renderWithComments([f('a.ts')], new Map());
    expect(getByTestId('file-tree').getAttribute('data-has-comments')).toBe('0');
  });

  it('expands the rail (data-has-comments=1) when a file has threads', () => {
    const { getByTestId } = renderWithComments([f('a.ts')], new Map([['a.ts', 'unresolved']]));
    expect(getByTestId('file-tree').getAttribute('data-has-comments')).toBe('1');
  });

  it('renders the correct comment-state per file row and blank otherwise', () => {
    const map = new Map<string, CommentIndicatorState>([
      ['a.ts', 'unresolved'],
      ['b.ts', 'resolved'],
    ]);
    const { container } = renderWithComments([f('a.ts'), f('b.ts'), f('c.ts')], map);
    const slots = container.querySelectorAll('[data-comment-state]');
    expect(slots.length).toBe(3); // one per file row
    const byPath = (p: string) =>
      container.querySelector(`[data-row-path="${p}"][data-comment-state]`)!;
    expect(byPath('a.ts').getAttribute('data-comment-state')).toBe('unresolved');
    expect(byPath('b.ts').getAttribute('data-comment-state')).toBe('resolved');
    expect(byPath('c.ts').getAttribute('data-comment-state')).toBe('none');
    // glyph present only for the two stateful rows
    expect(byPath('a.ts').querySelector('svg')).not.toBeNull();
    expect(byPath('c.ts').querySelector('svg')).toBeNull();
  });

  it('keeps the four columns row-aligned: one comment slot per file, dirs get a bare slot', () => {
    const { container } = renderWithComments([f('dir/a.ts'), f('dir/b.ts')], new Map());
    // 2 file comment slots (data-comment-state) + 1 dir bare slot in the comment column
    const col = container.querySelector('.file-tree-comment-col')!;
    expect(col.querySelectorAll('[data-comment-state]').length).toBe(2); // one per file row
    expect(col.querySelectorAll('[data-row-key]').length).toBe(1); // the parent dir's bare slot
    expect(col.children.length).toBe(3); // dir + 2 files, row-aligned with the other columns
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: FAIL — `commentStateByPath` not a prop; no `.file-tree-comment-col` / `data-has-comments`.

- [ ] **Step 3: Add the prop, root attribute, and comment column**

In `FileTree.tsx`:

Add the import:

```tsx
import type { CommentIndicatorState } from './commentIndicatorState';
```

Add to `FileTreeProps` (after `aiPreview`):

```tsx
  // #513 — per-file comment state. Optional/nullable ONLY so non-FilesTab callers
  // (tests, future embeds) can omit it; FilesTab always passes a real Map (possibly
  // empty). Null/empty ⇒ rail collapsed (data-has-comments='0'), every slot blank —
  // mirroring how aiPreview defaults false.
  commentStateByPath?: Map<string, CommentIndicatorState> | null;
```

Add `commentStateByPath` to the destructured params (default it):

```tsx
  aiPreview,
  commentStateByPath = null,
}: FileTreeProps) {
```

Add a derived flag near the other `useMemo`s:

```tsx
  const hasComments = (commentStateByPath?.size ?? 0) > 0;
```

On the main-return root `<div className={`file-tree ...`}` add the attribute alongside `data-ai-on`:

```tsx
      data-has-comments={hasComments ? '1' : '0'}
```

As the **first child** of `<div className={styles.fileTreeBody}>` (before `.fileTreeScroll`), insert the comment column:

```tsx
        {/* #513 — fixed comment rail. First child of the body, OUTSIDE .fileTreeScroll
            (like the AI/check columns on the right) so it never rides off on horizontal
            scroll. Rendered from the same flat `rows` list so row i lines up across all
            four columns. Collapses to width 0 when the PR has no threads (data-has-comments
            on the root). aria-hidden — the spoken signal lives on the row (Task 4). */}
        <div className={`file-tree-comment-col ${styles.fileTreeCommentCol}`} aria-hidden="true">
          {rows.map((row) =>
            row.kind === 'file' ? (
              <CommentSlot
                key={row.key}
                path={row.node.path}
                state={commentStateByPath?.get(row.node.path) ?? null}
              />
            ) : (
              <div key={row.key} className={styles.fileTreeCommentSlot} data-row-key={row.dirKey} />
            ),
          )}
        </div>
```

Add the `CommentSlot` component (next to `AiSlot`), importing `CommentGlyph` at the top (`import { CommentGlyph } from '../../shared/CommentGlyph';`):

```tsx
// #513 — one slot per file row in the fixed comment rail. `none` ⇒ empty slot (glyph
// suppressed); the state class sets the accent colour the glyph inherits via currentColor.
// data-row-path is the hover/selected resolution key (Task 5) — present on EVERY column's
// per-row slot so a pointer anywhere on the row resolves to it.
function CommentSlot({ path, state }: { path: string; state: CommentIndicatorState | null }) {
  const stateClass =
    state === 'unresolved'
      ? styles.fileTreeCommentSlotUnresolved
      : state === 'resolved'
        ? styles.fileTreeCommentSlotResolved
        : '';
  return (
    <div
      className={`${styles.fileTreeCommentSlot}${stateClass ? ` ${stateClass}` : ''}`}
      data-row-path={path}
      data-comment-state={state ?? 'none'}
    >
      {state && <CommentGlyph />}
    </div>
  );
}
```

- [ ] **Step 4: Add the CSS (token, column, slot, state colours)**

In `FileTree.module.css`, inside `.fileTree { … }` (next to `--ai-col-w` / `--check-col-w`):

```css
  /* #513 — occupied width of the fixed comment rail when the PR has threads:
     the 12px glyph + var(--s-1) padding each side. Collapses to 0 via
     [data-has-comments='0']. Keep in sync with .fileTreeCommentSlot padding. */
  --comment-col-w: calc(12px + 2 * var(--s-1));
```

Add the column + slot rules (place near `.fileTreeAiCol`):

```css
/* #513 — fixed comment rail, first (left-most) child of .fileTreeBody, OUTSIDE
   .fileTreeScroll so the glyph never scrolls off. Collapses to 0 width when the PR
   has no threads (data-has-comments on the root), so no-discussion PRs lose no
   filename space. No border/seam — reads as one surface with the tree. */
.fileTreeCommentCol {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  width: 0;
  overflow: hidden;
}
.fileTree[data-has-comments='1'] .fileTreeCommentCol {
  width: var(--comment-col-w);
  overflow: visible;
}
.fileTreeCommentSlot {
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--tree-row-h);
  padding: 0 var(--s-1);
  flex: none;
}
/* Glyph colour via the slot (SVG inherits currentColor). Solid accent = actionable;
   dimmed accent = all resolved (supplementary; the sr-only text carries the meaning). */
.fileTreeCommentSlotUnresolved {
  color: var(--accent);
}
.fileTreeCommentSlotResolved {
  color: var(--accent);
  opacity: 0.45;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: PASS (new comment-rail describe + all pre-existing FileTree tests).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx
git commit -m "feat(#513): fixed left comment rail in FileTree with 3-state glyph"
```

---

### Task 4: Screen-reader comment-state text on the file row

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (`FileCell` gets `commentState`; sr-only span)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx` (reading-order assertion)

**Interfaces:**
- Consumes: `CommentIndicatorState` (Task 2), `commentStateByPath` (Task 3, already threaded into `FileTree`).
- Produces: `FileCell` renders a trailing `<span className="sr-only">` — `" has unresolved comments"` (unresolved) / `" comments resolved"` (resolved) — AFTER the AI-focus sr-only span.

- [ ] **Step 1: Write the failing test**

Append to the `FileTree comment rail (#513)` describe in `FileTree.test.tsx`:

```tsx
  it('exposes comment state in reading order: status word → filename → comment state', () => {
    const { container } = renderWithComments([f('a.ts')], new Map([['a.ts', 'unresolved']]));
    const row = container.querySelector('[data-testid="files-tab-tree-row"]')!;
    const text = row.textContent!;
    // Order assertion (not mere containment): the comment sr-text must follow the
    // filename, which must follow the status word. The AI-focus sr-span sits between
    // name and comment by construction (Step 3 appends comment AFTER the AI block);
    // it is absent here because focusEntries is null, so we pin the observable three.
    const statusIdx = text.indexOf('Modified');
    const nameIdx = text.indexOf('a.ts');
    const commentIdx = text.indexOf('has unresolved comments');
    expect(statusIdx).toBeGreaterThanOrEqual(0);
    expect(nameIdx).toBeGreaterThan(statusIdx);
    expect(commentIdx).toBeGreaterThan(nameIdx);
  });

  it('says "comments resolved" for a fully-resolved file', () => {
    const { container } = renderWithComments([f('a.ts')], new Map([['a.ts', 'resolved']]));
    const row = container.querySelector('[data-testid="files-tab-tree-row"]')!;
    expect(row.textContent).toContain('comments resolved');
  });

  it('adds no comment sr-text for a file with no threads', () => {
    const { container } = renderWithComments([f('a.ts')], new Map());
    const row = container.querySelector('[data-testid="files-tab-tree-row"]')!;
    expect(row.textContent).not.toContain('comment');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: FAIL — the sr-only text is not yet rendered.

- [ ] **Step 3: Thread `commentState` into `FileCell` and render the span**

In `FileTree.tsx`, at the file-row branch of the SCROLLING tree column (`rows.map` at ~line 252), pass the state:

```tsx
                <FileCell
                  key={row.key}
                  row={row}
                  isSelected={selectedPath === row.node.path}
                  isViewed={viewedPaths.has(row.node.path)}
                  onSelectFile={onSelectFile}
                  focusLevel={focusByPath?.get(row.node.path) ?? null}
                  commentState={commentStateByPath?.get(row.node.path) ?? null}
                />
```

Add `commentState` to `FileCell`'s prop type and destructure:

```tsx
function FileCell({
  row,
  isSelected,
  isViewed,
  onSelectFile,
  focusLevel,
  commentState,
}: {
  row: FileRow;
  isSelected: boolean;
  isViewed: boolean;
  onSelectFile: (path: string) => void;
  focusLevel: FocusLevel | null;
  commentState: CommentIndicatorState | null;
}) {
```

Immediately AFTER the existing AI-focus sr-only span (the `focusLevel && focusLevel !== 'low'` block, ~line 385-387), add:

```tsx
      {/* #513 — comment state in reading order (status word → name → AI focus →
          comment state). Carries the resolved/unresolved distinction non-visually
          so the accent-dim glyph is not a colour-only signal (WCAG 1.4.1). */}
      {commentState === 'unresolved' && (
        <span className="sr-only"> has unresolved comments</span>
      )}
      {commentState === 'resolved' && <span className="sr-only"> comments resolved</span>}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx
git commit -m "feat(#513): sr-only comment-state text in file-tree reading order"
```

---

### Task 5: Full-row hover/selected highlight across all four columns

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (lifted `hoveredPath`, delegated handlers, `data-row-*` on every column's slot)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (attribute-driven background rules; remove name/dir native `:hover` + selected-class backgrounds)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx` (highlight assertions)

**Interfaces:**
- Consumes: `selectedPath` (existing prop), `rows` (existing).
- Produces: every per-row slot in all four columns carries `data-row-path` (files) / `data-row-key` (dirs); the currently selected file row's four slots carry `data-row-selected="true"`; the hovered row's four slots carry `data-row-hovered="true"`. Precedence in CSS: selected wins.

**Mechanism note:** File `path` (slash-joined) and dir `dirKey` (NUL-joined, `DIR_KEY_SEP`) never collide, so a single `hoveredPath: string | null` holding either value is unambiguous. The delegated handler reads whichever attribute `closest` finds.

- [ ] **Step 1: Write the failing tests**

Append a new describe to `FileTree.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react';

describe('FileTree full-row highlight (#513)', () => {
  const f = (path: string): FileChange => ({ path, status: 'modified', hunks: [] });

  function renderTree(selectedPath: string | null) {
    return render(
      <FileTree
        files={[f('a.ts'), f('b.ts')]}
        selectedPath={selectedPath}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview
        commentStateByPath={new Map([['a.ts', 'unresolved']])}
      />,
    );
  }

  const slots = (container: HTMLElement, path: string) =>
    Array.from(container.querySelectorAll(`[data-row-path="${path}"]`));

  it('marks all four column slots selected for the selected file (not just the name cell)', () => {
    const { container } = renderTree('a.ts');
    const marked = slots(container, 'a.ts').filter(
      (el) => el.getAttribute('data-row-selected') === 'true',
    );
    expect(marked.length).toBe(4); // comment, name, ai, check
    expect(slots(container, 'b.ts').some((el) => el.getAttribute('data-row-selected') === 'true')).toBe(
      false,
    );
  });

  it('sets hovered on all four slots when a row is hovered, and clears on leave', () => {
    const { container } = renderTree(null);
    // The body div carries only the hashed CSS-module class (styles.fileTreeBody);
    // target it by class-substring. It owns the delegated handlers, so it is the
    // correct mouseLeave target for the clear-on-leave assertion.
    const body = container.querySelector('[class*="fileTreeBody"]')! as HTMLElement;
    // hover via the AI gutter slot to prove gutter-hover resolution
    const aiSlot = slots(container, 'b.ts').find((el) => el.className.includes('fileTreeAiSlot'))!;
    fireEvent.mouseOver(aiSlot);
    expect(
      slots(container, 'b.ts').filter((el) => el.getAttribute('data-row-hovered') === 'true').length,
    ).toBe(4);
    fireEvent.mouseLeave(body);
    expect(
      slots(container, 'b.ts').some((el) => el.getAttribute('data-row-hovered') === 'true'),
    ).toBe(false);
  });

  it('selected wins: hovering the selected row keeps selected and adds hover flag without dropping selected', () => {
    const { container } = renderTree('a.ts');
    const nameCell = slots(container, 'a.ts').find((el) =>
      el.getAttribute('data-testid') === 'files-tab-tree-row',
    )!;
    fireEvent.mouseOver(nameCell);
    const sel = slots(container, 'a.ts');
    expect(sel.every((el) => el.getAttribute('data-row-selected') === 'true')).toBe(true);
    // hover flag may also be present; CSS precedence (selected after hover) keeps the wash.
  });

  it('directory rows hover across their empty gutter slots and never enter selected', () => {
    const { container } = render(
      <FileTree
        files={[f('dir/a.ts')]}
        selectedPath="dir/a.ts"
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview
        commentStateByPath={new Map()}
      />,
    );
    const dirSlots = Array.from(container.querySelectorAll('[data-row-key]'));
    expect(dirSlots.length).toBeGreaterThanOrEqual(1);
    fireEvent.mouseOver(dirSlots[0]);
    const dirKey = dirSlots[0].getAttribute('data-row-key')!;
    const marked = Array.from(container.querySelectorAll(`[data-row-key="${dirKey}"]`));
    expect(marked.every((el) => el.getAttribute('data-row-selected') !== 'true')).toBe(true);
    expect(marked.some((el) => el.getAttribute('data-row-hovered') === 'true')).toBe(true);
  });
});
```

> Note: the `[class*="fileTreeBody"]` lookup resolves the CSS-module-hashed body div (Step 3 gives it `className={styles.fileTreeBody}` and the `onMouseOver`/`onMouseLeave` handlers). If a stable hook is preferred later, add a `data-testid` to that div in Step 3 and target it instead — the `mouseLeave` target must be the div that owns the handlers.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: FAIL — no `data-row-selected`/`data-row-hovered`; gutter slots lack `data-row-path`.

- [ ] **Step 3: Lift `hoveredPath` + delegated handlers, and stamp attributes on all four columns**

In `FileTree.tsx`, add state + handlers inside the component (near `collapsed`):

```tsx
  // #513 — full-row highlight. The four columns are separate DOM siblings, so a
  // per-row background must be painted on each column's slot from lifted state, not
  // via :hover on one column. hoveredPath holds a file path (slash-joined) or a dir
  // key (NUL-joined) — the two spaces never collide, so one string is unambiguous.
  const [hoveredPath, setHoveredPath] = useState<string | null>(null);
  const handleBodyMouseOver = useCallback((e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest('[data-row-path],[data-row-key]');
    if (!el) return; // pointer over a gap — keep the current highlight (only leave clears)
    const id = el.getAttribute('data-row-path') ?? el.getAttribute('data-row-key');
    setHoveredPath((prev) => (prev === id ? prev : id));
  }, []);
  const handleBodyMouseLeave = useCallback(() => setHoveredPath(null), []);
```

Add the handlers to the body div:

```tsx
      <div
        className={styles.fileTreeBody}
        onMouseOver={handleBodyMouseOver}
        onMouseLeave={handleBodyMouseLeave}
      >
```

**Comment column** — pass `selected`/`hovered` into `CommentSlot`:

```tsx
              <CommentSlot
                key={row.key}
                path={row.node.path}
                state={commentStateByPath?.get(row.node.path) ?? null}
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
```

Dir branch of the comment column:

```tsx
              <div
                key={row.key}
                className={styles.fileTreeCommentSlot}
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
```

Update `CommentSlot` to accept and stamp the flags:

```tsx
function CommentSlot({
  path,
  state,
  selected,
  hovered,
}: {
  path: string;
  state: CommentIndicatorState | null;
  selected: boolean;
  hovered: boolean;
}) {
  const stateClass =
    state === 'unresolved'
      ? styles.fileTreeCommentSlotUnresolved
      : state === 'resolved'
        ? styles.fileTreeCommentSlotResolved
        : '';
  return (
    <div
      className={`${styles.fileTreeCommentSlot}${stateClass ? ` ${stateClass}` : ''}`}
      data-row-path={path}
      data-comment-state={state ?? 'none'}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
      {state && <CommentGlyph />}
    </div>
  );
}
```

**AI column** — pass flags to `AiSlot` (file branch) and stamp the dir bare slot:

```tsx
              <AiSlot
                key={row.key}
                focusLevel={focusByPath?.get(row.node.path) ?? null}
                aiPreview={aiPreview}
                path={row.node.path}
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
```
```tsx
              <div
                key={row.key}
                className={styles.fileTreeAiSlot}
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
```

Update `AiSlot`:

```tsx
function AiSlot({
  focusLevel,
  aiPreview,
  path,
  selected,
  hovered,
}: {
  focusLevel: FocusLevel | null;
  aiPreview: boolean;
  path: string;
  selected: boolean;
  hovered: boolean;
}) {
  return (
    <div
      className={styles.fileTreeAiSlot}
      data-row-path={path}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
      <span
        className={`file-tree-ai ${styles.fileTreeAi}`}
        data-on={aiPreview ? '1' : '0'}
        aria-hidden="true"
      >
        {focusLevel && focusLevel !== 'low' && (
          <span
            className={focusLevel === 'high' ? styles.fileTreeAiHigh : styles.fileTreeAiMed}
            title={`AI focus: ${focusLevel}`}
          />
        )}
      </span>
    </div>
  );
}
```

**Checkbox column** — pass flags to `CheckSlot` (file branch) and stamp the dir bare slot:

```tsx
              <CheckSlot
                key={row.key}
                node={row.node}
                isViewed={viewedPaths.has(row.node.path)}
                onToggleViewed={onToggleViewed}
                selected={row.node.path === selectedPath}
                hovered={hoveredPath === row.node.path}
              />
```
```tsx
              <div
                key={row.key}
                className={styles.fileTreeCheckSlot}
                aria-hidden="true"
                data-row-key={row.dirKey}
                data-row-hovered={hoveredPath === row.dirKey ? 'true' : undefined}
              />
```

Update `CheckSlot` signature + outer div:

```tsx
function CheckSlot({
  node,
  isViewed,
  onToggleViewed,
  selected,
  hovered,
}: {
  node: FileTreeNode;
  isViewed: boolean;
  onToggleViewed: (path: string) => void;
  selected: boolean;
  hovered: boolean;
}) {
  const handleChange = useCallback(() => {
    onToggleViewed(node.path);
  }, [onToggleViewed, node.path]);

  return (
    <div
      className={styles.fileTreeCheckSlot}
      data-row-path={node.path}
      data-row-selected={selected ? 'true' : undefined}
      data-row-hovered={hovered ? 'true' : undefined}
    >
      <input
        type="checkbox"
        checked={isViewed}
        onChange={handleChange}
        aria-label={`Viewed ${node.path}`}
        className={`file-tree-viewed-checkbox ${styles.fileTreeViewedCheckbox}`}
      />
    </div>
  );
}
```

**Name cell (`FileCell`)** — add `isHovered` prop and stamp `data-row-*`. Update the call site (scrolling column) to pass `isHovered={hoveredPath === row.node.path}`, then add to the props type and the root `<div>`:

```tsx
      data-path={node.path}
      data-row-path={node.path}
      data-row-selected={isSelected ? 'true' : undefined}
      data-row-hovered={isHovered ? 'true' : undefined}
```

(Keep existing `data-path` and `data-selected` — other consumers/tests use them.)

**Dir name cell (`DirCell`)** — add `isHovered` prop; pass `isHovered={hoveredPath === row.dirKey}` at the call site; stamp on the root `<div>`:

```tsx
      data-row-key={row.dirKey}
      data-row-hovered={isHovered ? 'true' : undefined}
```

- [ ] **Step 4: Replace name/dir native `:hover` + selected-class backgrounds with one attribute-driven rule set**

In `FileTree.module.css`:

Remove the background from the name-cell hover and selected rules, and the dir hover. Change:

```css
.fileTreeFile:hover {
  background: var(--surface-3);
}
.fileTreeFileSelected {
  background: color-mix(in oklch, var(--accent-soft) 40%, var(--surface-2));
  color: var(--text-1);
}
```
to:
```css
.fileTreeFileSelected {
  color: var(--text-1);
}
```
and change:
```css
.fileTreeDirHeader:hover {
  background: var(--surface-3);
}
```
to remove that rule (the dir header keeps its `transition: background`).

Add ONE attribute-driven rule set (selected AFTER hovered so selected wins on a row that is both):

```css
/* #513 — full-row highlight. Painted on EVERY column's per-row slot (comment, name,
   ai, check) from lifted state, so a hovered/selected row is one continuous bar with
   no step at a column boundary. Source order = precedence: the selected rule follows
   the hovered rule, so a row that is both keeps its selected wash (hover adds nothing
   on an already-open file). */
.fileTreeBody [data-row-hovered='true'] {
  background: var(--surface-3);
}
.fileTreeBody [data-row-selected='true'] {
  background: color-mix(in oklch, var(--accent-soft) 40%, var(--surface-2));
}
```

(The `.fileTreeBody` div already exists; the attribute rules are scoped under it. `transition: background` stays on `.fileTreeFile` / `.fileTreeDirHeader` for the fade.)

- [ ] **Step 5: Run the FileTree suite**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.test.tsx`
Expected: PASS — highlight describe + all prior FileTree tests (selection/viewed/AI slots unchanged).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/src/components/PrDetail/FilesTab/FileTree.test.tsx
git commit -m "feat(#513): full-row hover/selected highlight across all four tree columns"
```

---

### Task 6: Synthetic-hscroll leading spacer (#214 alignment)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (prepend leading spacer to the hscroll row)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (leading spacer class + collapse gate)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.scrollbar.test.tsx` (update child-count assertion)

**Interfaces:**
- Consumes: `data-has-comments` on `.fileTree` (Task 3).
- Produces: `.file-tree-hscroll-row` first child is a leading spacer of width `--comment-col-w` (collapses to 0 when `data-has-comments='0'`), so the synthetic scrollbar stays aligned under `.fileTreeScroll` once the tree is shifted right by the rail.

- [ ] **Step 1: Update the failing scrollbar test**

In `FileTree.scrollbar.test.tsx`, the existing test `renders the bar inside a two-column footer` asserts `row.children.length === 2` and `children[0] === bar`. The leading spacer makes the row `[lead spacer][bar][right spacer]`. Update that test and add a collapse assertion. Replace the body of that `it` with:

```tsx
  it('renders the bar inside a three-cell footer (leading rail spacer, bar, right gutter)', () => {
    const { getByTestId } = renderTree([file('a.cs')]);
    const bar = getByTestId('file-tree-hscroll');
    const row = bar.closest('.file-tree-hscroll-row')!;
    // Footer mirrors .fileTreeBody: [comment-rail spacer][bar][ai+check gutter spacer].
    expect(row.children.length).toBe(3);
    expect(row.children[1]).toBe(bar);
  });
```

Add a new test in the same describe:

```tsx
  it('keeps the leading rail spacer present so it aligns under the tree column (width gated by CSS)', () => {
    const { getByTestId } = render(
      <FileTree
        files={[file('a.cs')]}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
        commentStateByPath={new Map([['a.cs', 'unresolved']])}
      />,
    );
    const row = getByTestId('file-tree-hscroll').closest('.file-tree-hscroll-row')!;
    // data-has-comments='1' drives the leading spacer's width via CSS; assert the
    // root flag here (jsdom does no layout, so width itself is covered by e2e).
    expect(getByTestId('file-tree').getAttribute('data-has-comments')).toBe('1');
    expect(row.children.length).toBe(3);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.scrollbar.test.tsx`
Expected: FAIL — the row still has 2 children; `children[1]` is not the bar.

- [ ] **Step 3: Prepend the leading spacer in the JSX**

In `FileTree.tsx`, inside `<div ref={hScrollRowRef} className={`file-tree-hscroll-row ...`} aria-hidden="true">`, add as the FIRST child (before the `hScrollRef` bar div):

```tsx
        {/* #513 — leading spacer mirrors the comment rail so the synthetic bar stays
            aligned under .fileTreeScroll once the tree is shifted right by the rail.
            Collapses to 0 in lockstep with the rail (same data-has-comments gate). */}
        <div className={styles.fileTreeHScrollSpacerColLead} />
```

- [ ] **Step 4: Add the leading-spacer CSS**

In `FileTree.module.css`, near `.fileTreeHScrollSpacerCol`:

```css
/* #513 — leading spacer reserving the comment rail's width so the synthetic bar
   spans only the tree column. 0 by default; widened to --comment-col-w in lockstep
   with .fileTreeCommentCol when the PR has threads. */
.fileTreeHScrollSpacerColLead {
  flex: 0 0 auto;
  width: 0;
}
.fileTree[data-has-comments='1'] .fileTreeHScrollSpacerColLead {
  width: var(--comment-col-w);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd frontend && npx vitest run src/components/PrDetail/FilesTab/FileTree.scrollbar.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/src/components/PrDetail/FilesTab/FileTree.scrollbar.test.tsx
git commit -m "feat(#513): leading hscroll spacer keeps #214 bar aligned under the rail"
```

---

### Task 7: Wire `FilesTab` → `FileTree` and run the full gate

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` (derive + pass `commentStateByPath`)

**Interfaces:**
- Consumes: `deriveCommentStateByPath` (Task 2), `FileTree`'s new `commentStateByPath` prop (Task 3).

- [ ] **Step 1: Derive the map in `FilesTab` and pass it**

In `FilesTab.tsx`, extend the FileTree import:

```tsx
import { FileTree } from './FileTree';
import { deriveCommentStateByPath } from './commentIndicatorState';
```

Add the memo near `fileThreads` (~line 290):

```tsx
  // #513 — per-file comment indicator state. Reactive for free: posting/resolving a
  // thread updates prDetail.reviewComments → this recomputes → the tree glyph updates.
  const commentStateByPath = useMemo(
    () => deriveCommentStateByPath(prDetail.reviewComments),
    [prDetail.reviewComments],
  );
```

Pass it to `<FileTree>` (add the prop alongside `aiPreview={aiDotsOn}`):

```tsx
              aiPreview={aiDotsOn}
              commentStateByPath={commentStateByPath}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Run the full frontend test suite**

Run: `cd frontend && npx vitest run`
Expected: PASS (all suites — FileTree, scrollbar, InboxRow, commentIndicatorState, CommentGlyph, plus untouched suites). Investigate any failure before proceeding.

- [ ] **Step 4: Lint + format gate (mirrors CI)**

Run: `cd frontend && npm run lint`
Expected: clean (prettier `--check` + eslint). If prettier flags the new files, run `npx prettier --write` on them and re-run.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx
git commit -m "feat(#513): wire per-file comment state from FilesTab into FileTree"
```

---

### Task 8: Playwright B1 visual proof (both themes)

**Files:**
- No source change. Produces screenshots for the PR `## Proof` and verifies no unintended visual-baseline shift.

- [ ] **Step 1: Launch the app against a real PR with mixed threads**

Per project memory: serve detached via `run.ps1` (port 5180) with the real data dir; auth via `gh auth token` → POST `/api/auth/connect`. Use a PR that has BOTH an unresolved and a fully-resolved thread on different files (e.g. `mindbody/Mindbody.Clients#973` per `reference_live_validate_comment_cards_needs_real_pr_threads`). Open the Files tab.

- [ ] **Step 2: Capture the three states, both themes**

With Playwright MCP (serve over HTTP; `file://` is blocked), screenshot the file tree in light and dark showing: a file with the solid-accent glyph (unresolved), a file with the dimmed glyph (resolved), and a file with a blank slot (none). Include at least one frame with the **resolved** glyph on the **selected** row and one on a **hovered** row, so the resolved-vs-blank contrast on the selected/hover wash is proven (Accessibility requirement). Also capture a **no-comment (blank) row under hover and selected** in both themes to confirm the rail still reads seamless (no residual gutter edge) in the state most likely to reveal one.

- [ ] **Step 2a: Objectively measure the resolved-glyph contrast on the selected wash (not eyeball-only)**

Judgment-by-screenshot is not sufficient here — oklch surface scales are theme-asymmetric (light descends, dark ascends+compressed), so "looks fine in light" does not transfer to dark, and the resolved glyph is a same-hue accent tint over an accent-soft wash. Measure the rendered contrast objectively via the project's 1px-canvas method (`getComputedStyle` returns authored oklch, not rgb — sample through a canvas). In the running app, on a **selected** row carrying a **resolved** glyph, sample the glyph's effective painted color (accent @ 0.45 composited over the selected wash) and the adjacent blank-slot background, and compute their ΔL / contrast. **Acceptance:** the resolved glyph must be perceptibly distinct from the blank slot on rest, hover, AND selected in BOTH themes. If it fails on the selected wash in either theme, raise `.fileTreeCommentSlotResolved`'s opacity floor (or swap the opacity dim for a hue/stroke cue), re-run the FE suite, and record the deviation from the owner-approved 0.45 at-rest value in the PR `## Proof`. (The 0.45 value is the approved at-rest treatment; this step guards it under the new washes, it does not override it.)

- [ ] **Step 2b: Re-verify the pre-existing AI Medium-focus dot on the new washes**

Task 5 paints the hover/selected backgrounds under the AI column for the first time (today it stays `--surface-1`). The row-level Medium-focus dot (`.fileTreeAiMed`, a flat `opacity: 0.6` accent dot) was gate-verified only against static `--surface-1` — unlike the header marker, it uses no theme-aware token. Screenshot (both themes) a row with a Medium-focus AI dot in the **hovered** and **selected** states and confirm the dot stays visible against `--surface-3` and the accent-soft selected wash. If it doesn't, bump `.fileTreeAiMed`'s opacity or move it to a theme-aware token (mirroring the header's `--ai-idle-opacity`), re-run the FE suite, and note it in `## Proof`.

- [ ] **Step 3: Verify no unintended visual-baseline regression**

The rail collapses to width 0 when a PR has no threads, so the existing file-tree parity/visual baselines (threadless fixtures, 2% tolerance) should not shift. Confirm by running the e2e visual/parity job (CI is the source of truth on Linux). Grep e2e specs for file-tree tree-row assertions before pushing:

Run: `cd frontend && npx vitest run` is already green; then push and let the ubuntu e2e job decide. If a baseline legitimately shifts (a fixture PR has threads), regen from the CI artifact per `reference_regen_linux_parity_baseline_via_ci_artifact` and commit into this PR.

- [ ] **Step 4: Assemble `## Proof`**

Host the PNGs on a throwaway `review-assets/pr-<n>` branch (raw URLs) per `feedback_visual_verification_screenshots_on_pr`. In `## Proof`, record: the three states both themes; the resolved-on-selected contrast frame; the **no-count deviation** from the issue AC (owner-directed); and the ce-doc-review disposition summary.

---

## Self-Review

**Spec coverage:**
- Shared `CommentGlyph` + inbox swap with class pass-through → Task 1. ✓
- Per-file state map (unresolved wins, absent ⇒ none) → Task 2. ✓
- Fixed left rail, `data-has-comments` collapse, state colours, no seam → Task 3. ✓
- Accessibility sr-only reading order → Task 4. ✓
- Full-row highlight across four columns, selected-wins, dir-hover, delegated hover, gutter resolution → Task 5. ✓
- #214 leading spacer → Task 6. ✓
- FilesTab wiring + reactivity → Task 7 (reactivity asserted in Task 3/5 via re-render; the memo dep is `prDetail.reviewComments`). ✓
- B1 visual proof + resolved-contrast check + no-count deviation → Task 8. ✓
- Edge cases (optimistic, off-diff path, deleted file, mixed) are behavioural consequences of the derivation (Task 2) + render (Task 3); mixed is unit-tested in Task 2. ✓
- Out-of-scope items (dir rollup, click-to-jump, outdated, count, forced-colors) — intentionally not built. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code and exact commands. ✓

**Type consistency:** `CommentIndicatorState` defined in Task 2, imported by Tasks 3/4/7; `commentStateByPath?: Map<string, CommentIndicatorState> | null` consistent across FileTree prop, FilesTab pass, and test helpers. `deriveCommentStateByPath` name identical in Tasks 2 and 7. Attribute names (`data-row-path`, `data-row-key`, `data-row-selected`, `data-row-hovered`, `data-has-comments`, `data-comment-state`) consistent across TSX, CSS, and tests. `--comment-col-w` token used in the column, the leading spacer, and declared once in `.fileTree`. ✓

**One reviewer-gate note:** Tasks 5 and 6 both edit `FileTree.tsx`/`.module.css`/tests; they are split because a reviewer could accept the highlight (Task 5) while rejecting the hscroll-spacer approach (Task 6) or vice versa — independent deliverables with their own test cycles.
