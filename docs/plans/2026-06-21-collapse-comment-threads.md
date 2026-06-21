# Collapse Inline Comment Threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer collapse an inline review-comment thread in the diff view to a single summary line (Variant A), with resolved threads auto-collapsed by default, persisted for the open-tab lifetime.

**Architecture:** A per-thread disclosure in `ThreadView` (inside `ExistingCommentWidget`). Collapsed/expanded is derived from a tab-lifetime override map owned by `FilesTab` and threaded through `DiffPane` as a `ThreadCollapseControl`, alongside the existing `replyContext`. Default derives from `thread.isResolved`; the map holds only explicit toggles and resets when the PR tab unmounts. Pure presentational `Badge` + `ThreadDisclosureHeader` components carry the UI.

**Tech Stack:** React + Vite + TypeScript, CSS Modules, vitest + @testing-library/react.

**Spec:** `docs/specs/2026-06-21-collapse-comment-threads-design.md`

## Global Constraints

- Reuse the centered column from #522 — the disclosure lives inside `.commentWidget` (`width: min(80%, var(--pr-detail-content-max))` + `margin-inline: auto`). Add no new width/centering rule.
- Reuse `Avatar` (`size="sm"`), `stripMarkdown` (`frontend/src/components/PrDetail/HotspotsTab/stripMarkdown.ts`, signature `stripMarkdown(md: string): string`), and a single shared `Badge` for the count pill + Resolved badge. Do not mirror the `.bandEnd` declarations.
- Feature stays in diff scope (`ExistingCommentWidget` / `FilesTab` / `DiffPane` / new `Badge`, `ThreadDisclosureHeader`). Overview/Hotspots and the `CommentCard` body are untouched.
- A11y first-class: disclosure is a `<button>` with `aria-expanded`, `aria-controls`, keyboard-operable; chevron rotation + any body transition gated on `prefers-reduced-motion: no-preference`.
- Default: unresolved → expanded, resolved → collapsed. State is tab-lifetime in-memory only (no `localStorage`).
- Count pill copy: `1 comment` (singular) / `N comments` (N ≥ 2) / omitted when 0.
- Expanded header shows `▾ + Resolved badge` only (no author/snippet/count). Collapsed shows full Variant A.
- No backend / no wire change. `ReviewThreadDto` unchanged.
- Pre-push (run locally before any push, from `frontend/`): `npm run lint` → `npm run build` → `npm test` (use the project binaries, never `npx`). `tsc -b` (inside `npm run build`) is the real typecheck.

## File Structure

| File | Responsibility |
|------|----------------|
| `frontend/src/components/Badge/Badge.tsx` *(new)* | Presentational pill (the extracted `.bandEnd` recipe). One consumer-agnostic component. |
| `frontend/src/components/Badge/Badge.module.css` *(new)* | Pill styling (five declarations moved from `CommentCard.module.css`). |
| `frontend/src/components/Badge/Badge.test.tsx` *(new)* | Renders children inside the pill; passes through `aria-label`/`data-testid`. |
| `frontend/src/components/PrDetail/Comment/CommentCard.tsx` *(modify)* | Render `bandEnd` via `<Badge>` instead of an inline `.bandEnd` span. |
| `frontend/src/components/PrDetail/Comment/CommentCard.module.css` *(modify)* | Delete the now-shared `.bandEnd` rule. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.tsx` *(new)* | The disclosure button: collapsed Variant A line / expanded minimal header. Pure — all data via props. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.module.css` *(new)* | Row layout, chevron, hover/focus states, surface token. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx` *(new)* | All header variants/edge cases. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` *(modify)* | `ThreadCollapseControl` type; `collapse?` prop; `ThreadView` renders header + conditional body; relocate Resolved badge; compute snippet. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx` *(modify)* | Collapsed/expanded integration via a `collapse` stub. |
| `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` *(modify)* | Optional `collapse?: ThreadCollapseControl` prop; forward to both `ExistingCommentWidget` emit sites (unified + split). |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` *(modify)* | Own `collapseOverrides` state; build the controller; pass to `DiffPane`. |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx` *(new)* | Default derivation + persistence-across-file-switch (the O1 gate). |

Dependency order: **Task 1 (Badge) → Task 2 (ThreadDisclosureHeader) → Task 3 (ThreadView integration) → Task 4 (FilesTab + DiffPane plumbing).**

---

### Task 1: Shared `Badge` pill (extract `.bandEnd`)

**Files:**
- Create: `frontend/src/components/Badge/Badge.tsx`
- Create: `frontend/src/components/Badge/Badge.module.css`
- Create: `frontend/src/components/Badge/Badge.test.tsx`
- Modify: `frontend/src/components/PrDetail/Comment/CommentCard.tsx` (line ~49: the `bandEnd` render)
- Modify: `frontend/src/components/PrDetail/Comment/CommentCard.module.css` (delete `.bandEnd`, lines 27–35)

**Interfaces:**
- Produces: `Badge({ children, className?, 'data-testid'?, 'aria-label'? }): JSX.Element` — a `<span>` pill.

- [ ] **Step 1: Write the failing test** — `Badge.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders children inside a pill and forwards aria-label + data-testid', () => {
    render(
      <Badge data-testid="b" aria-label="Resolved thread">
        Resolved
      </Badge>,
    );
    const el = screen.getByTestId('b');
    expect(el).toHaveTextContent('Resolved');
    expect(el).toHaveAttribute('aria-label', 'Resolved thread');
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (`Badge` not found)

Run (from `frontend/`): `node_modules/.bin/vitest run src/components/Badge/Badge.test.tsx`
Expected: FAIL — cannot resolve `./Badge`.

- [ ] **Step 3: Implement `Badge.tsx`**

```tsx
import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function Badge({ children, className, 'data-testid': testId, 'aria-label': ariaLabel }: BadgeProps) {
  return (
    <span
      className={`${styles.badge} ${className ?? ''}`.trim()}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 4: Implement `Badge.module.css`** (the recipe moved verbatim from `CommentCard.module.css`)

```css
.badge {
  margin-left: auto;
  font-size: var(--text-2xs);
  font-weight: 500;
  color: var(--text-3);
  background: var(--surface-3);
  border-radius: 999px;
  padding: 1px 8px;
}
```

> Note: `margin-left: auto` is what pinned the old `.bandEnd` to the band's right edge. It is harmless where the parent is not a flex row, but if `ThreadDisclosureHeader` (Task 2) does not want the auto-margin, it overrides it via its own class on the same element. Keep it here so `CommentCard` behavior is byte-identical.

- [ ] **Step 5: Refactor `CommentCard.tsx`** — render `bandEnd` via `Badge`

Replace (line ~49):
```tsx
{bandEnd != null && <span className={styles.bandEnd}>{bandEnd}</span>}
```
with:
```tsx
{bandEnd != null && <Badge>{bandEnd}</Badge>}
```
Add the import at top: `import { Badge } from '../../Badge/Badge';`

- [ ] **Step 6: Delete `.bandEnd` from `CommentCard.module.css`** (lines 27–35).

- [ ] **Step 7: Run Badge + CommentCard tests — expect PASS**

Run: `node_modules/.bin/vitest run src/components/Badge/Badge.test.tsx src/components/PrDetail/Comment/CommentCard.test.tsx`
Expected: PASS (CommentCard's existing `bandEnd`/Resolved assertions still hold — same text, same visual pill).

- [ ] **Step 8: Typecheck + format**

Run: `npm run build` (tsc -b clean) and `node_modules/.bin/prettier --write src/components/Badge/Badge.tsx src/components/Badge/Badge.module.css src/components/Badge/Badge.test.tsx src/components/PrDetail/Comment/CommentCard.tsx src/components/PrDetail/Comment/CommentCard.module.css`

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/Badge frontend/src/components/PrDetail/Comment/CommentCard.tsx frontend/src/components/PrDetail/Comment/CommentCard.module.css
git commit -m "refactor(comment): extract shared Badge pill from CommentCard .bandEnd (#569)"
```

---

### Task 2: `ThreadDisclosureHeader` (pure presentational disclosure)

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.tsx`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.module.css`
- Create: `frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx`

**Interfaces:**
- Consumes: `Badge` (Task 1), `Avatar` (`{ src, login, size }`).
- Produces:
  ```ts
  export interface ThreadDisclosureHeaderProps {
    collapsed: boolean;
    onToggle: () => void;
    bodyId: string;
    author?: string;
    avatarUrl?: string | null;
    snippet?: string;          // already stripped + capped; undefined/'' → omit slot
    commentCount: number;
    isResolved: boolean;
    filePath: string;
    lineNumber: number;
  }
  export function ThreadDisclosureHeader(p: ThreadDisclosureHeaderProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests** — `ThreadDisclosureHeader.test.tsx`

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ThreadDisclosureHeader } from './ThreadDisclosureHeader';

function props(over = {}) {
  return {
    collapsed: true,
    onToggle: () => {},
    bodyId: 'thread-body-t1',
    author: 'amelia.cho',
    avatarUrl: null,
    snippet: 'Looks like a race here',
    commentCount: 2,
    isResolved: true,
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    ...over,
  };
}

describe('ThreadDisclosureHeader', () => {
  it('collapsed: shows author, snippet, count, Resolved; aria-expanded=false', () => {
    render(<ThreadDisclosureHeader {...props()} />);
    const btn = screen.getByTestId('thread-disclosure');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'thread-body-t1');
    expect(btn).toHaveAccessibleName(/expand thread on src\/Calc\.cs line 5/i);
    expect(screen.getByText('amelia.cho')).toBeInTheDocument();
    expect(screen.getByText(/Looks like a race here/)).toBeInTheDocument();
    expect(screen.getByText('2 comments')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });

  it('expanded: minimal header — Resolved badge but no author/snippet/count; aria-expanded=true', () => {
    render(<ThreadDisclosureHeader {...props({ collapsed: false })} />);
    const btn = screen.getByTestId('thread-disclosure');
    expect(btn).toHaveAttribute('aria-expanded', 'true');
    expect(btn).toHaveAccessibleName(/collapse thread on src\/Calc\.cs line 5/i);
    expect(screen.queryByText('amelia.cho')).not.toBeInTheDocument();
    expect(screen.queryByText(/Looks like a race here/)).not.toBeInTheDocument();
    expect(screen.queryByText('2 comments')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });

  it('count pill is singular for 1 and omitted for 0', () => {
    const { rerender } = render(<ThreadDisclosureHeader {...props({ commentCount: 1 })} />);
    expect(screen.getByText('1 comment')).toBeInTheDocument();
    rerender(<ThreadDisclosureHeader {...props({ commentCount: 0 })} />);
    expect(screen.queryByText(/comment/)).not.toBeInTheDocument();
  });

  it('omits the snippet slot when snippet is empty (image-only/empty body)', () => {
    render(<ThreadDisclosureHeader {...props({ snippet: '' })} />);
    expect(screen.queryByTestId('thread-snippet')).not.toBeInTheDocument();
  });

  it('non-resolved: no Resolved badge', () => {
    render(<ThreadDisclosureHeader {...props({ isResolved: false })} />);
    expect(screen.queryByLabelText('Resolved thread')).not.toBeInTheDocument();
  });

  it('activating the button calls onToggle (click + keyboard)', async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(<ThreadDisclosureHeader {...props({ onToggle })} />);
    const btn = screen.getByTestId('thread-disclosure');
    await user.click(btn);
    btn.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledTimes(3);
  });

  it('truncated snippet carries a title for mouse hover', () => {
    render(<ThreadDisclosureHeader {...props({ snippet: 'full text here' })} />);
    expect(screen.getByTestId('thread-snippet')).toHaveAttribute('title', 'full text here');
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (component missing)

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `ThreadDisclosureHeader.tsx`**

```tsx
import { Avatar } from '../../../Avatar/Avatar';
import { Badge } from '../../../Badge/Badge';
import styles from './ThreadDisclosureHeader.module.css';

export interface ThreadDisclosureHeaderProps {
  collapsed: boolean;
  onToggle: () => void;
  bodyId: string;
  author?: string;
  avatarUrl?: string | null;
  snippet?: string;
  commentCount: number;
  isResolved: boolean;
  filePath: string;
  lineNumber: number;
}

function countLabel(n: number): string | null {
  if (n <= 0) return null;
  return n === 1 ? '1 comment' : `${n} comments`;
}

export function ThreadDisclosureHeader({
  collapsed,
  onToggle,
  bodyId,
  author,
  avatarUrl,
  snippet,
  commentCount,
  isResolved,
  filePath,
  lineNumber,
}: ThreadDisclosureHeaderProps) {
  const count = countLabel(commentCount);
  const resolvedBadge = isResolved ? (
    <Badge aria-label="Resolved thread">Resolved</Badge>
  ) : null;

  return (
    <button
      type="button"
      className={styles.header}
      data-testid="thread-disclosure"
      data-collapsed={collapsed}
      aria-expanded={!collapsed}
      aria-controls={bodyId}
      aria-label={`${collapsed ? 'Expand' : 'Collapse'} thread on ${filePath} line ${lineNumber}`}
      onClick={onToggle}
    >
      <svg className={styles.chevron} viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {collapsed ? (
        <>
          {author != null && <Avatar src={avatarUrl} login={author} size="sm" />}
          {author != null && <span className={styles.author}>{author}</span>}
          {snippet ? (
            <span className={styles.snippet} data-testid="thread-snippet" title={snippet}>
              {snippet}
            </span>
          ) : (
            <span className={styles.spacer} />
          )}
          {count && <Badge className={styles.pill}>{count}</Badge>}
          {resolvedBadge}
        </>
      ) : (
        <>
          <span className={styles.spacer} />
          {resolvedBadge}
        </>
      )}
    </button>
  );
}
```

- [ ] **Step 4: Implement `ThreadDisclosureHeader.module.css`**

```css
.header {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  width: 100%;
  padding: var(--s-2) var(--s-3);
  background: var(--surface-2);
  border: none;
  border-radius: var(--radius-2);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--text-2);
  text-align: left;
  cursor: pointer;
}
.header:hover {
  background: var(--surface-3);
}
.header:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.chevron {
  flex: 0 0 auto;
  color: var(--text-3);
  transform: rotate(0deg);
}
.header[aria-expanded='true'] .chevron {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: no-preference) {
  .chevron {
    transition: transform var(--t-fast);
  }
}
.author {
  flex: 0 0 auto;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-1);
}
.snippet {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-3);
}
.spacer {
  flex: 1 1 auto;
}
/* the count/resolved pills sit at the row end; override Badge's margin-left:auto
   so they don't each try to claim all the free space (the .spacer owns it). */
.pill {
  margin-left: 0;
}
```

> If `--radius-2` / `--t-fast` differ in `tokens.css`, use the actual tokens the codebase exposes (grep `tokens.css`). `--accent`, `--surface-2/3`, `--text-1/2/3`, `--s-2/3`, `--text-sm`, `--font-sans` are all in use elsewhere in this folder.

- [ ] **Step 5: Run — expect PASS**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 6: Typecheck + format**

Run: `npm run build`; `node_modules/.bin/prettier --write src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.*`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.module.css frontend/src/components/PrDetail/FilesTab/DiffPane/ThreadDisclosureHeader.test.tsx
git commit -m "feat(diff): ThreadDisclosureHeader collapsed/expanded disclosure (#569)"
```

---

### Task 3: `ThreadView` integration — `collapse` prop, header + conditional body

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (the `ExistingCommentWidgetProps` interface ~49–54; `ExistingCommentWidget` ~56; `ThreadView` ~68–178)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`

**Interfaces:**
- Consumes: `ThreadDisclosureHeader` (Task 2), `stripMarkdown` (`stripMarkdown(md: string): string`).
- Produces:
  ```ts
  export interface ThreadCollapseControl {
    isCollapsed: (threadId: string, isResolved: boolean) => boolean;
    toggle: (threadId: string, isResolved: boolean) => void;
  }
  // ExistingCommentWidgetProps gains: collapse?: ThreadCollapseControl
  ```

- [ ] **Step 1: Write the failing tests** — append to `ExistingCommentWidget.test.tsx`

```tsx
import userEvent from '@testing-library/user-event';
// reuse the existing `thread()` factory in this file.

function collapseStub(collapsed: boolean, toggle = () => {}) {
  return { isCollapsed: () => collapsed, toggle };
}

describe('ExistingCommentWidget — collapse', () => {
  it('collapsed: renders the disclosure summary, not the cards or reply affordance', () => {
    render(<ExistingCommentWidget threads={[thread({ isResolved: true })]} collapse={collapseStub(true)} />);
    expect(screen.getByTestId('thread-disclosure')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('inline-comment-card')).not.toBeInTheDocument();
  });

  it('expanded: renders the cards and an aria-expanded=true header', () => {
    render(<ExistingCommentWidget threads={[thread()]} collapse={collapseStub(false)} />);
    expect(screen.getByTestId('thread-disclosure')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('inline-comment-card').length).toBeGreaterThan(0);
  });

  it('no collapse prop: threads render fully expanded (back-compat)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    expect(screen.getAllByTestId('inline-comment-card').length).toBeGreaterThan(0);
  });

  it('toggling the disclosure calls collapse.toggle(threadId, isResolved)', async () => {
    const toggle = vi.fn();
    const user = userEvent.setup();
    render(<ExistingCommentWidget threads={[thread({ threadId: 't1', isResolved: true })]} collapse={collapseStub(true, toggle)} />);
    await user.click(screen.getByTestId('thread-disclosure'));
    expect(toggle).toHaveBeenCalledWith('t1', true);
  });

  it('collapsed snippet derives from the first comment body, stripped', () => {
    const t = thread({ isResolved: true });
    t.comments[0].body = '## Heading\nfirst line of prose';
    render(<ExistingCommentWidget threads={[t]} collapse={collapseStub(true)} />);
    // stripMarkdown returns the first non-empty stripped line: 'Heading'
    expect(screen.getByTestId('thread-snippet')).toHaveTextContent('Heading');
  });
});
```

Add `import { vi } from 'vitest';` if not already imported in this file.

- [ ] **Step 2: Run — expect FAIL** (`collapse` prop unknown / header absent)

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Add the `ThreadCollapseControl` type + `collapse` prop**

In `ExistingCommentWidget.tsx`, add the interface near the top and extend props:
```tsx
export interface ThreadCollapseControl {
  isCollapsed: (threadId: string, isResolved: boolean) => boolean;
  toggle: (threadId: string, isResolved: boolean) => void;
}

export interface ExistingCommentWidgetProps {
  threads: ReviewThreadDto[];
  replyContext?: ExistingCommentWidgetReplyContext;
  collapse?: ThreadCollapseControl;
}
```
Thread `collapse` into the map: `ExistingCommentWidget({ threads, replyContext, collapse })` → `<ThreadView ... collapse={collapse} />`.

- [ ] **Step 4: Rework `ThreadView` to render the disclosure**

Add imports: `import { ThreadDisclosureHeader } from './ThreadDisclosureHeader';` and `import { stripMarkdown } from '../../HotspotsTab/stripMarkdown';`.

`ThreadView` signature gains `collapse: ThreadCollapseControl | undefined`. Inside, before the return:
```tsx
const collapsed = collapse?.isCollapsed(thread.threadId, thread.isResolved) ?? false;
const bodyId = `thread-body-${thread.threadId}`;
const first = thread.comments[0];
const snippet = collapsed && first ? stripMarkdown(first.body).slice(0, 200) : undefined;
```
Render the header first, then the body only when not collapsed. Replace the `.comment-thread` block's children with:
```tsx
<ThreadDisclosureHeader
  collapsed={collapsed}
  onToggle={() => collapse?.toggle(thread.threadId, thread.isResolved)}
  bodyId={bodyId}
  author={first?.author}
  avatarUrl={first?.avatarUrl}
  snippet={snippet || undefined}
  commentCount={thread.comments.length}
  isResolved={thread.isResolved}
  filePath={thread.filePath}
  lineNumber={thread.lineNumber}
/>
{!collapsed && (
  <div id={bodyId}>
    {/* existing: thread.comments.map(...CommentCard...), optimisticForThread.map(...),
        the reply affordance, and the ReplyComposer — moved verbatim inside this div */}
  </div>
)}
```
In the existing `CommentCard` map, **remove the `bandEnd` Resolved span** (pass nothing) — the Resolved badge now lives in the header. The `density="comfortable"`, `data-testid`, optimistic cards, and reply/composer logic are unchanged; they just move inside the `{!collapsed && (...)}` body `div`.

- [ ] **Step 5: Run — expect PASS**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`
Expected: PASS — new collapse tests + the existing render/density/resolved tests (the resolved-tag test now finds the badge in the header; update its selector if it asserted a card-scoped location).

- [ ] **Step 6: Typecheck + format**

Run: `npm run build`; `node_modules/.bin/prettier --write src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx`

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.test.tsx
git commit -m "feat(diff): wire thread collapse disclosure into ThreadView (#569)"
```

---

### Task 4: `FilesTab` state + `DiffPane` plumbing (default + persistence)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (props ~130; the two `<ExistingCommentWidget>` emit sites — split via `emitWidgetAndComposerRows`, unified via `DiffLineRow`)
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` (build the controller; pass to `DiffPane`)
- Create: `frontend/src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx`

**Interfaces:**
- Consumes: `ThreadCollapseControl` (Task 3, exported from `ExistingCommentWidget.tsx`).

- [ ] **Step 1: Thread `collapse` through `DiffPane`**

In `DiffPane.tsx`: import the type (`import type { ThreadCollapseControl } from './ExistingCommentWidget';`), add `collapse?: ThreadCollapseControl` to `DiffPaneProps` next to `replyContext`, and forward it to **every** `<ExistingCommentWidget ... />` (both the split path in `emitWidgetAndComposerRows` and the unified path via `DiffLineRow`), mirroring exactly how `replyContext` is forwarded. Where `replyContext` is destructured/passed through intermediate row components, do the same for `collapse`.

(No standalone unit test for the plumbing — it's covered by Task 3's widget tests plus the FilesTab persistence test below and the live pass. Verify by typecheck.)

- [ ] **Step 2: Write the failing test** — `FilesTab.collapse.test.tsx`

This test exercises the controller logic in isolation by extracting it; if the controller is defined inline in `FilesTab`, instead test it through a tiny exported helper. Define and export a pure helper in `FilesTab.tsx` to keep this testable:

```tsx
// in FilesTab.tsx — exported pure helpers
export function effectiveCollapsed(
  overrides: Record<string, boolean>,
  threadId: string,
  isResolved: boolean,
): boolean {
  return overrides[threadId] ?? isResolved;
}
export function nextOverrides(
  overrides: Record<string, boolean>,
  threadId: string,
  isResolved: boolean,
): Record<string, boolean> {
  return { ...overrides, [threadId]: !(overrides[threadId] ?? isResolved) };
}
```

Test:
```tsx
import { describe, it, expect } from 'vitest';
import { effectiveCollapsed, nextOverrides } from './FilesTab';

describe('FilesTab collapse model', () => {
  it('default: resolved collapsed, unresolved expanded (empty overrides)', () => {
    expect(effectiveCollapsed({}, 't1', true)).toBe(true);
    expect(effectiveCollapsed({}, 't2', false)).toBe(false);
  });
  it('explicit override wins over the resolved default', () => {
    expect(effectiveCollapsed({ t1: false }, 't1', true)).toBe(false);
    expect(effectiveCollapsed({ t2: true }, 't2', false)).toBe(true);
  });
  it('toggle flips the effective state and records it', () => {
    // unresolved (default expanded=false) → collapse
    expect(nextOverrides({}, 't2', false)).toEqual({ t2: true });
    // resolved (default collapsed=true) → expand
    expect(nextOverrides({}, 't1', true)).toEqual({ t1: false });
    // already-overridden flips back
    expect(nextOverrides({ t1: false }, 't1', true)).toEqual({ t1: true });
  });
  it('override is sticky and not cleared when isResolved later differs', () => {
    // user expanded a resolved thread; a later render passes isResolved=true again
    expect(effectiveCollapsed({ t1: false }, 't1', true)).toBe(false);
  });
});
```

- [ ] **Step 3: Run — expect FAIL** (helpers not exported)

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement state + controller in `FilesTab.tsx`**

Add the two exported helpers above. Add state and build the controller:
```tsx
const [collapseOverrides, setCollapseOverrides] = useState<Record<string, boolean>>({});
const collapse = useMemo<ThreadCollapseControl>(
  () => ({
    isCollapsed: (threadId, isResolved) => effectiveCollapsed(collapseOverrides, threadId, isResolved),
    toggle: (threadId, isResolved) =>
      setCollapseOverrides((m) => nextOverrides(m, threadId, isResolved)),
  }),
  [collapseOverrides],
);
```
Import `ThreadCollapseControl` from `./DiffPane/ExistingCommentWidget`, and `useMemo`/`useState` from React. Pass `collapse={collapse}` to `<DiffPane ... />` (next to the existing `replyContext={...}`).

- [ ] **Step 5: Run — expect PASS**

Run: `node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 6: Full pre-push**

Run (from `frontend/`): `npm run lint` → `npm run build` → `npm test`.
Expected: lint clean; build clean; all tests pass (existing + new).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx
git commit -m "feat(diff): tab-lifetime thread-collapse state with resolved-collapsed default (#569)"
```

---

## Live validation (after Task 4, before PR — required for this UI-visual issue)

Run the app against the real token store (`scripts/serve-detached.ps1 -Port 5180 -DataDir <real %LocalApplicationData%\PRism> -Force --no-browser`), open a PR with resolved + unresolved inline threads (`mindbody/Mindbody.Clients#973`). Verify across **both themes × Unified + Split**:
- Resolved threads load collapsed, unresolved expanded.
- Collapsed line = Variant A within the centered 80% column; visually distinct from diff code rows.
- Count pill + Resolved badge meet WCAG AA contrast on `--surface-2` in both themes.
- Expand → cards; collapse → one line; chevron rotates (instant under reduced-motion); hover highlight + `cursor:pointer`; focus-visible ring not clipped.
- State persists across file switches within the PR tab; resets on close+reopen.
- Keyboard: tab to disclosure, Enter/Space toggles.
Capture before/after screenshots for the PR Proof. Check `frontend/e2e` for any baseline rendering an inline thread (none expected; regenerate Linux baseline via CI artifact if one shifts).

## Self-Review

**Spec coverage:** §1 model → Task 4 (helpers + state) & Task 3 (`collapse` prop). §2 ThreadView disclosure → Task 3. §3 ThreadDisclosureHeader (layout, count singular/plural/0, empty snippet, author cap, hover/focus/cursor, chevron, surface, shared badge) → Task 2 (+ Badge in Task 1). §4 a11y → Tasks 2–3 (aria-expanded/controls/label, keyboard, reduced-motion). §5 snippet (reuse stripMarkdown, cap, lazy) → Task 3. §6 default/scope → Task 4 default; composer untouched (not in any task). §7 state interactions (override stickiness) → Task 4 test. Testing matrix → per-task tests + live pass. Covered.

**Placeholder scan:** no TBD/TODO; every code step carries real code; the DiffPane forwarding step (Task 4 Step 1) intentionally has no code block because it mirrors the existing `replyContext` threading verbatim — the implementer follows the real `replyContext` path; flagged as such, not a hidden placeholder.

**Type consistency:** `ThreadCollapseControl.{isCollapsed,toggle}(threadId: string, isResolved: boolean)` is identical in Task 3 (definition), Task 2 (`onToggle: () => void` is the header's own callback, wired to `collapse.toggle` in Task 3 — distinct names, intentional), and Task 4 (`effectiveCollapsed`/`nextOverrides` back the controller). `stripMarkdown(md: string): string`, `Avatar({src, login, size})`, `Badge({children, className?, 'data-testid'?, 'aria-label'?})` consistent across tasks.

---

## Plan revision (2026-06-21, post-live-validation, owner-approved)

After Task 2–4 implemented the plan above and the live pass ran, the owner iterated the collapse UX. The visual/layout deviations are documented authoritatively in the spec's **"Design revision"** section; the items below are the plan-mechanics that changed. Where this section conflicts with the tasks above, **this section governs.**

- **Task 1 (shared `Badge`) is superseded — not built as planned.** The count became an accent-tinted comment **glyph + number** (Octicon `comment-16`, inbox parity), not a text pill; the Resolved cue reuses the global **`chip chip-success`** utility (`frontend/src/styles/tokens.css`) plus a one-line `.resolvedBadge` override. No new shared `Badge`/`metaPill` class and no `.bandEnd` extraction were needed, so `CommentCard` was left untouched.
- **Task 2 (`ThreadDisclosureHeader`) renders two layouts, not one inline row.** Collapsed = a single full-row click target (`.collapsed`) with the chevron in a rounded-square `.chevronBox`; expanded = a thin `.expandedHeader` with a standalone square `.toggle` button + the persistent Resolved pill (cards in the body below). Shared square frame: `.toggle, .chevronBox` at `border-radius: var(--radius-2)`. Chevron matches the **file-tree** chevron (15px / stroke 1.75).
- **Surface tokens differ from §3.** The comment band (`.diffCommentRow`/`.diffComposerRow` in `DiffPane.module.css`) moved to **`--surface-3`** (dark-mode standout vs the surface-1 code rows); the collapsed card uses **`--surface-1`** + border (inset from the band) with an accent-tinted hover. Hover is gated to the collapsed card + toggle only — no hover on expanded cards.
- **`/simplify` cleanups (this branch):** removed a dead `data-collapsed` attribute from the `comment-thread` wrapper `<div>` (the header button keeps its own, which the tests use); merged the byte-identical `.commentThread`/`.body` rule bodies; swapped the bespoke `.resolvedBadge` color/radius declarations for `chip chip-success`. No behavior change; the green pill's live appearance is identical (same `--success-soft`/`--success-fg`/`999px`).
- **Live-validation checklist corrections:** the "count pill" line now reads as the glyph+number metric; "visually distinct from diff code rows" is satisfied by the `--surface-3` band (not `--surface-2`); the serve-detached command is `scripts/serve-detached.ps1 -SkipBuild -Force` (no `--no-browser`, which binds to `-Port`). All states (collapsed/expanded × dark/light × Unified/Split) were live-validated and owner-approved.
