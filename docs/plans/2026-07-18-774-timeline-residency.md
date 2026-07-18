# Timeline Residency + Click-Through Navigation Implementation Plan (#774)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render PR review threads as collapsed accordion rows under their parent review card in the Activity timeline, and let a user click an anchored thread through to the Files tab where it scrolls into view, focuses, and flashes.

**Architecture:** Slice 2 of the review-threads timeline-residency design (spec: `docs/specs/2026-07-17-review-threads-timeline-residency-design.md`). Slice 1 (#773, merged) already put every needed field on the wire — `ReviewThreadDto` carries `lineNumber: number | null`, `isOutdated`, `originalLine`, `originalStartLine`, `subjectType`, `diffHunk`, `reviewDatabaseId`. This slice is **frontend-only** for production code; the sole backend change is a test-hook that seeds review threads for e2e (opt-in, default-empty, zero effect on existing specs). The timeline join is client-side: `PrDetailDto.reviewComments` grouped by `reviewDatabaseId` and matched to `review:{databaseId}` timeline events. No timeline reader/endpoint change.

**Tech Stack:** React + Vite + TypeScript (frontend); vitest + Testing Library (unit); Playwright (e2e); .NET minimal-API test hooks (C#).

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec's Decisions (D1–D8) and "Review card: thread accordion rows".

- **B1-gated (UI-visual).** Human review on the plan and every PR. **No self-merge** on any PR in this plan. Visual-verification screenshots (both themes) posted on each PR.
- **D1 — group under the parent review card**, never as independent flat-feed items. A review event is a `TimelineEvent` whose `verb ∈ {'reviewed','approved','changes-requested'}` and whose `id` is `review:{databaseId}`.
- **D2 — one collapsed accordion per thread, collapsed by default.**
- **D3 — expanded view is read-only** and reuses `CommentCard`. Reply/resolve stay exclusively in the Files tab. No composer, no resolve button anywhere in the timeline.
- **D4 — client-side join, no timeline endpoint change.** `useThreadsByReview(reviewComments)` → `Map<number, ReviewThreadDto[]>`; `ActivityFeed` keeps its explicit-props pattern (it does NOT consume `prDetailContext`).
- **D6 — outdated & file-level threads get no click-through.** Their surface is the badge + frozen `diffHunk` snippet.
- **Chip precedence on the collapsed row (exact):** (1) `subjectType === 'FILE'` → **File** chip (never the Outdated badge, even when outdated); else (2) `lineNumber != null` (anchored) → monospace `path:line` chip + a **View in diff** button; else (3) → **Outdated** badge. Reply count = `comments.length − 1`, shown only when > 0. Resolved threads show a **Resolved** chip matching the Files-tab resolved styling.
- **Outdated "was L…" label (exact):** shown in the expanded view above the hunk, for outdated LINE threads only — ``was L${originalStartLine}–${originalLine}`` when `originalStartLine != null`, else ``was L${originalLine}``. Never mix these original-range numbers with current-head numbers.
- **Expanded hunk block:** render `diffHunk` in a muted monospace block that scrolls inside its own `overflow-x` container. When `diffHunk` is null (file-level threads) omit the block entirely — never render an empty scrollable box.
- **Scroll mechanism:** manual `container.scrollTo` mirroring `useChangeNavigation`, honoring `prefers-reduced-motion` (`behavior: 'auto'` when reduced). Never `element.scrollIntoView()` — it is unused in this codebase and absent in jsdom.
- **Accessibility:** the accordion row is a `<button aria-expanded>`; "View in diff" is a **sibling** button, never nested inside the disclosure button. Announce navigation via the always-mounted sr-only `role="status" aria-live="polite"` region convention (paired with a visible cue).
- **Reduced-motion:** the transient highlight flash is gated behind `@media (prefers-reduced-motion: reduce)` with `animation: none`.

---

## File Structure

**PR 1 — Timeline residency (display only; no navigation):**
- Create `frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.ts` — grouping hook.
- Create `frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.test.ts`.
- Create `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.tsx` — accordion row (collapsed + expanded). No "View in diff" button yet.
- Create `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.module.css`.
- Create `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx`.
- Modify `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx` — `threadsByReview` prop, `ReviewNode`, dispatch branch.
- Modify `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css` — `.threadList`.
- Modify `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx` — thread-rendering tests.
- Modify `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` — run the hook, pass the prop.
- Modify `PRism.Web/TestHooks/FakeReviewBackingStore.cs` — `ReviewThreads` list + `SeedReviewThreads` + `Reset` clear.
- Modify `PRism.Web/TestHooks/FakePrReader.cs` — return `_store.ReviewThreads`.
- Modify `PRism.Web/TestHooks/TestEndpoints.cs` — `/test/seed-review-threads` endpoint.
- Modify `frontend/e2e/helpers/s4-setup.ts` — `seedReviewThreads(page)` helper.
- Create `frontend/e2e/pr-detail-timeline-threads.spec.ts` — display assertions.

**PR 2 — Click-through navigation:**
- Modify `frontend/src/components/PrDetail/prDetailContext.tsx` — widen `requestFileView`, add `pendingThreadId` + `clearPendingThreadId`.
- Modify `frontend/src/components/PrDetail/PrDetailView.tsx` — `pendingThreadId` state, 2-arg `requestFileView`, `useDiffScrollRestore` suppression.
- Modify `frontend/src/components/PrDetail/testUtils.tsx` — widen the context stub.
- Modify `frontend/src/hooks/diffScrollMemory.ts` — `suppress` option on `useDiffScrollRestore`.
- Create `frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.ts` — center-scroll util.
- Create `frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.test.ts`.
- Modify `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` — pending-thread effect + miss Snackbar.
- Create `frontend/src/components/PrDetail/FilesTab/FilesTab.threadDeepLink.test.tsx`.
- Modify the global stylesheet that defines `.comment-thread--resolved` — add `.comment-thread--flash` keyframes (grep for `comment-thread--resolved` to locate).
- Modify `ReviewThreadRow.tsx` + `.module.css` — add the "View in diff" button (anchored only) + `onViewInDiff` prop.
- Modify `ReviewThreadRow.test.tsx` — button presence/absence + click.
- Modify `ActivityFeed.tsx` + `OverviewTab.tsx` — thread `onThreadNavigate` prop wiring.
- Modify `frontend/e2e/pr-detail-timeline-threads.spec.ts` — click-through assertions.

Two PRs keep each change set at or under the 10–15-file cap; check `git diff --stat` before each `gh pr create` and split if a PR overflows.

---

# PR 1 — Timeline residency (display)

### Task 1: `useThreadsByReview` grouping hook

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.ts`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.test.ts`

**Interfaces:**
- Consumes: `ReviewThreadDto` from `../../../../api/types` (matches ActivityFeed's existing import path).
- Produces: `useThreadsByReview(reviewComments: ReviewThreadDto[]): Map<number, ReviewThreadDto[]>` — keyed by `reviewDatabaseId`; threads with `reviewDatabaseId == null` are omitted; each review's list is ordered by first-comment `createdAt` ascending.

- [ ] **Step 1: Write the failing test**

```ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useThreadsByReview } from './useThreadsByReview';
import type { ReviewThreadDto } from '../../../../api/types';

const thread = (over: Partial<ReviewThreadDto>): ReviewThreadDto => ({
  threadId: 't',
  filePath: 'src/Calc.cs',
  lineNumber: 1,
  isResolved: false,
  comments: [{ commentId: 'c', author: 'a', createdAt: '2026-01-01T00:00:00Z', body: 'b', editedAt: null }],
  ...over,
});

describe('useThreadsByReview', () => {
  it('groups threads by reviewDatabaseId', () => {
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 't1', reviewDatabaseId: 1 }),
        thread({ threadId: 't2', reviewDatabaseId: 2 }),
        thread({ threadId: 't3', reviewDatabaseId: 1 }),
      ]),
    );
    expect(result.current.get(1)?.map((t) => t.threadId)).toEqual(['t1', 't3']);
    expect(result.current.get(2)?.map((t) => t.threadId)).toEqual(['t2']);
  });

  it('omits threads with a null reviewDatabaseId', () => {
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 't1', reviewDatabaseId: null }),
        thread({ threadId: 't2', reviewDatabaseId: undefined }),
        thread({ threadId: 't3', reviewDatabaseId: 5 }),
      ]),
    );
    expect([...result.current.keys()]).toEqual([5]);
  });

  it('orders each review’s threads by first-comment createdAt ascending', () => {
    const early = { commentId: 'c1', author: 'a', createdAt: '2026-01-01T00:00:00Z', body: 'b', editedAt: null };
    const late = { commentId: 'c2', author: 'a', createdAt: '2026-02-01T00:00:00Z', body: 'b', editedAt: null };
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 'late', reviewDatabaseId: 1, comments: [late] }),
        thread({ threadId: 'early', reviewDatabaseId: 1, comments: [early] }),
      ]),
    );
    expect(result.current.get(1)?.map((t) => t.threadId)).toEqual(['early', 'late']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.test.ts --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import { useMemo } from 'react';
import type { ReviewThreadDto } from '../../../../api/types';

/**
 * Groups a PR's review threads by the database id of the review that owns them, so the
 * Activity timeline can hang each thread under its `review:{databaseId}` card (#774). Threads
 * with no owning review (`reviewDatabaseId == null`) are omitted — they stay visible in the
 * Files tab if anchored. Each review's threads are ordered by first-comment createdAt ascending.
 */
export function useThreadsByReview(
  reviewComments: ReviewThreadDto[],
): Map<number, ReviewThreadDto[]> {
  return useMemo(() => {
    const map = new Map<number, ReviewThreadDto[]>();
    for (const t of reviewComments) {
      if (t.reviewDatabaseId == null) continue;
      const list = map.get(t.reviewDatabaseId);
      if (list) list.push(t);
      else map.set(t.reviewDatabaseId, [t]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => firstCreatedAt(a).localeCompare(firstCreatedAt(b)));
    }
    return map;
  }, [reviewComments]);
}

function firstCreatedAt(t: ReviewThreadDto): string {
  return t.comments.length > 0 ? t.comments[0].createdAt : '';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.ts frontend/src/components/PrDetail/OverviewTab/timeline/useThreadsByReview.test.ts
git commit -m "feat(#774): add useThreadsByReview grouping hook"
```

---

### Task 2: `ReviewThreadRow` accordion row (display)

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.module.css`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx`

**Interfaces:**
- Consumes: `ReviewThreadDto` from `../../../../api/types`; `CommentCard` from `../../Comment/CommentCard`; `Avatar` from `../../../Avatar/Avatar`.
- Produces: `ReviewThreadRow({ thread }: { thread: ReviewThreadDto })`. (PR 2 adds an optional `onViewInDiff?: (path: string, threadId: string) => void` prop — do NOT add it now.)

Chip precedence and the "was L…" label are in Global Constraints — follow them exactly.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReviewThreadRow } from './ReviewThreadRow';
import type { ReviewThreadDto } from '../../../../api/types';

const base = (over: Partial<ReviewThreadDto>): ReviewThreadDto => ({
  threadId: 't1',
  filePath: 'src/Calc.cs',
  lineNumber: 5,
  isResolved: false,
  comments: [
    { commentId: 'c1', author: 'alice', avatarUrl: null, createdAt: '2026-01-01T00:00:00Z', body: 'First body', editedAt: null },
  ],
  ...over,
});

describe('ReviewThreadRow', () => {
  it('anchored thread shows a path:line chip and the first-comment snippet, collapsed', () => {
    render(<ReviewThreadRow thread={base({})} />);
    expect(screen.getByText('src/Calc.cs:5')).toBeInTheDocument();
    expect(screen.getByText('First body')).toBeInTheDocument();
    // collapsed: the hunk/comment panel is not rendered
    expect(screen.getByRole('button', { name: /thread/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('outdated LINE thread shows an Outdated badge and no line chip', () => {
    render(<ReviewThreadRow thread={base({ lineNumber: null, isOutdated: true, subjectType: 'LINE', originalLine: 12, originalStartLine: null })} />);
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.queryByText(/src\/Calc\.cs:/)).not.toBeInTheDocument();
  });

  it('file-level thread shows a File chip even when outdated', () => {
    render(<ReviewThreadRow thread={base({ lineNumber: null, isOutdated: true, subjectType: 'FILE' })} />);
    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.queryByText('Outdated')).not.toBeInTheDocument();
  });

  it('shows a reply count only when there is more than one comment', () => {
    const two = base({ comments: [
      { commentId: 'c1', author: 'alice', createdAt: '2026-01-01T00:00:00Z', body: 'a', editedAt: null },
      { commentId: 'c2', author: 'bob', createdAt: '2026-01-02T00:00:00Z', body: 'b', editedAt: null },
    ] });
    render(<ReviewThreadRow thread={two} />);
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows a Resolved chip for resolved threads', () => {
    render(<ReviewThreadRow thread={base({ isResolved: true })} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('expanding an anchored thread reveals the diffHunk block and the comment stack', async () => {
    const user = userEvent.setup();
    render(<ReviewThreadRow thread={base({ diffHunk: '@@ -1,2 +1,2 @@\n-old\n+new' })} />);
    await user.click(screen.getByRole('button', { name: /thread/i }));
    expect(screen.getByRole('button', { name: /thread/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('timeline-thread-hunk')).toHaveTextContent('+new');
  });

  it('expanding an outdated thread labels the snippet with the original range and omits the hunk when null', async () => {
    const user = userEvent.setup();
    render(<ReviewThreadRow thread={base({ lineNumber: null, isOutdated: true, subjectType: 'LINE', originalStartLine: 592, originalLine: 596, diffHunk: null })} />);
    await user.click(screen.getByRole('button', { name: /thread/i }));
    expect(screen.getByText('was L592–596')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-thread-hunk')).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx --reporter=dot`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the component**

`ReviewThreadRow.tsx`:

```tsx
import { useState } from 'react';
import { Avatar } from '../../../Avatar/Avatar';
import { CommentCard } from '../../Comment/CommentCard';
import type { ReviewThreadDto } from '../../../../api/types';
import styles from './ReviewThreadRow.module.css';

export function ReviewThreadRow({ thread }: { thread: ReviewThreadDto }) {
  const [expanded, setExpanded] = useState(false);

  const fileLevel = thread.subjectType === 'FILE';
  const anchored = thread.lineNumber != null;
  const outdated = !fileLevel && !anchored;

  const first = thread.comments[0];
  const snippet = first?.body ?? '';
  const replyCount = thread.comments.length - 1;
  const wasLabel = outdated
    ? thread.originalStartLine != null
      ? `was L${thread.originalStartLine}–${thread.originalLine}`
      : `was L${thread.originalLine}`
    : null;

  return (
    <li className={styles.threadRow}>
      <div className={styles.rowLine}>
        <button
          type="button"
          className={styles.rowHeader}
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          data-testid="timeline-thread-row"
          aria-label={`Review thread on ${thread.filePath}`}
        >
          <span className={styles.chevron} data-expanded={expanded} aria-hidden="true">
            ▸
          </span>
          {fileLevel ? (
            <span className={styles.fileChip}>File</span>
          ) : anchored ? (
            <span className={styles.lineChip}>
              {thread.filePath}:{thread.lineNumber}
            </span>
          ) : (
            <span className={styles.outdatedBadge}>Outdated</span>
          )}
          <Avatar src={first?.avatarUrl ?? null} login={first?.author ?? ''} size="sm" />
          <span className={styles.author}>{first?.author}</span>
          <span className={styles.snippet}>{snippet}</span>
          {replyCount > 0 && (
            <span className={styles.replyCount}>
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </span>
          )}
          {thread.isResolved && <span className={styles.resolvedChip}>Resolved</span>}
        </button>
        {/* PR 2 (#774) adds a sibling "View in diff" button here, anchored threads only. */}
      </div>
      {expanded && (
        <div className={styles.panel}>
          {wasLabel && <p className={styles.wasLabel}>{wasLabel}</p>}
          {thread.diffHunk != null && (
            <pre className={styles.hunk} data-testid="timeline-thread-hunk">
              {thread.diffHunk}
            </pre>
          )}
          <ul className={styles.commentStack}>
            {thread.comments.map((c) => (
              <li key={c.commentId}>
                <CommentCard
                  density="compact"
                  avatarSize="sm"
                  author={c.author}
                  avatarUrl={c.avatarUrl ?? undefined}
                  createdAt={c.createdAt}
                  body={c.body}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}
```

`ReviewThreadRow.module.css` (uses the repo's design tokens — mirror the spacing/colour token names already used in `ActivityFeed.module.css`: `--s-*`, `--text-*`, `--border-1`, `--surface-*`, `--text-1/2/3`, `--accent`, `--font-mono`, `--radius-2`, `--warning-soft`/`--warning-fg`, `--success-soft`/`--success-fg`):

```css
.threadRow {
  list-style: none;
}
.rowLine {
  display: flex;
  align-items: center;
  gap: var(--s-2);
}
.rowHeader {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--s-2);
  background: none;
  border: none;
  padding: 4px 6px;
  cursor: pointer;
  text-align: left;
  font-size: var(--text-sm);
  color: var(--text-2);
  border-radius: var(--radius-2);
}
.rowHeader:hover {
  background: var(--surface-3);
}
.chevron {
  transition: transform 120ms ease;
  color: var(--text-3);
  flex-shrink: 0;
}
.chevron[data-expanded='true'] {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  .chevron {
    transition: none;
  }
}
.lineChip {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--accent);
  flex-shrink: 0;
}
.fileChip,
.outdatedBadge,
.resolvedChip {
  font-size: var(--text-xs);
  border-radius: 999px;
  padding: 1px 8px;
  flex-shrink: 0;
}
.fileChip {
  color: var(--text-2);
  background: var(--surface-3);
}
.outdatedBadge {
  color: var(--warning-fg);
  background: var(--warning-soft);
}
.resolvedChip {
  color: var(--success-fg);
  background: var(--success-soft);
}
.author {
  font-weight: 600;
  color: var(--text-1);
  flex-shrink: 0;
}
.snippet {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-2);
}
.replyCount,
.wasLabel {
  color: var(--text-3);
  font-size: var(--text-xs);
}
.replyCount {
  flex-shrink: 0;
}
.panel {
  margin: var(--s-2) 0 var(--s-3) 24px;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
.wasLabel {
  margin: 0;
  font-family: var(--font-mono);
}
.hunk {
  margin: 0;
  padding: var(--s-2);
  background: var(--surface-3);
  border: 1px solid var(--border-1);
  border-radius: var(--radius-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-2);
  overflow-x: auto;
  white-space: pre;
}
.commentStack {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS (7 tests). If a token name is wrong the render still passes (CSS modules don't fail on unknown vars) — verify token names against `ActivityFeed.module.css` visually before the PR screenshots.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.tsx frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.module.css frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx
git commit -m "feat(#774): add ReviewThreadRow accordion (display, no navigation)"
```

---

### Task 3: `ActivityFeed` — `ReviewNode` + dispatch + `threadsByReview` prop

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css`
- Test: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx`

**Interfaces:**
- Consumes: `ReviewThreadDto`; the new `ReviewThreadRow`.
- Produces: `ActivityFeed` gains a prop `threadsByReview?: Map<number, ReviewThreadDto[]>` (default empty). A review event with ≥1 thread renders as a `ReviewNode` (card-or-shell + a `.threadList` of `ReviewThreadRow`s). Reviews with no threads render exactly as today (`CommentNode` if bodied, `Marker` if not) — do not change that path.

Context (verbatim from the current file): the dispatch at lines ~255–271 is:

```tsx
node.kind === 'commit-group' ? (
  <CommitGroup key={node.commits[0].id} commits={node.commits} commitBase={commitBase} />
) : node.event.body != null ? (
  <CommentNode key={node.event.id} event={node.event} />
) : (
  <Marker key={node.event.id} event={node.event} />
),
```

`stateBand`, `commentTone`, `NodeBadge`, `VERB_PHRASE`, `COMMENT_PATH`, `verbMeta`, `Avatar`, `formatAge` already exist in this file.

- [ ] **Step 1: Write the failing tests** (append to `ActivityFeed.test.tsx`, reusing its existing `ev()` helper and `getTimelinePage` mock pattern)

```tsx
import type { ReviewThreadDto } from '../../../../api/types';

const seededThread = (over: Partial<ReviewThreadDto> = {}): ReviewThreadDto => ({
  threadId: 'th1',
  filePath: 'src/Calc.cs',
  lineNumber: 5,
  isResolved: false,
  reviewDatabaseId: 1,
  comments: [{ commentId: 'c1', author: 'alice', avatarUrl: null, createdAt: '2026-01-01T00:00:00Z', body: 'nit here', editedAt: null }],
  ...over,
});

it('renders thread rows under the matching review card', async () => {
  vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
    events: [ev('review:1', { verb: 'approved' })],
    olderCursor: null,
    hasOlder: false,
  });
  const threadsByReview = new Map<number, ReviewThreadDto[]>([[1, [seededThread()]]]);
  render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={<div />} threadsByReview={threadsByReview} />);
  expect(await screen.findByTestId('timeline-thread-row')).toBeInTheDocument();
  expect(screen.getByText('src/Calc.cs:5')).toBeInTheDocument();
});

it('does not alter a review with no threads (still a bare marker)', async () => {
  vi.spyOn(api, 'getTimelinePage').mockResolvedValue({
    events: [ev('review:9', { verb: 'approved' })],
    olderCursor: null,
    hasOlder: false,
  });
  render(<ActivityFeed prRef={pr} prUpdatedSignal={0} composerSlot={<div />} threadsByReview={new Map()} />);
  expect(await screen.findByTestId('timeline-marker')).toHaveTextContent('approved');
  expect(screen.queryByTestId('timeline-thread-row')).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx --reporter=dot`
Expected: FAIL — `threadsByReview` not a prop; no `timeline-thread-row`.

- [ ] **Step 3: Implement**

Add the import and helpers near the top of `ActivityFeed.tsx`:

```tsx
import type { PrReference, TimelineEvent, ActivityVerb, ReviewThreadDto } from '../../../../api/types';
import { ReviewThreadRow } from './ReviewThreadRow';

const isReview = (v: ActivityVerb): boolean =>
  v === 'reviewed' || v === 'approved' || v === 'changes-requested';

const reviewDbId = (id: string): number | null => {
  const m = /^review:(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
};
```

Add the `ReviewNode` component (next to `CommentNode`):

```tsx
function ReviewNode({ event, threads }: { event: TimelineEvent; threads: ReviewThreadDto[] }) {
  const { tone, path } = verbMeta(event.verb);
  return (
    <li className={styles.node}>
      <NodeBadge
        tone={event.body != null ? commentTone(event.verb) : tone}
        path={event.body != null ? COMMENT_PATH : path}
      />
      <div className={styles.cardWrap}>
        {event.body != null ? (
          <CommentCard
            density="comfortable"
            avatarSize="sm"
            author={event.actor.login ?? ''}
            avatarUrl={event.actor.avatarUrl ?? undefined}
            createdAt={event.timestamp}
            body={event.body}
            bandEnd={stateBand(event.verb)}
            data-testid="timeline-comment"
          />
        ) : (
          <span className={styles.line} data-testid="timeline-marker">
            <Avatar src={event.actor.avatarUrl} login={event.actor.login ?? ''} size="sm" />
            <span className={styles.lineText}>
              {event.actor.login && <span className={styles.actor}>{event.actor.login} </span>}
              <span className={styles.verb}>{VERB_PHRASE[event.verb]}</span>
              <span className={styles.when}> · {formatAge(event.timestamp)}</span>
            </span>
          </span>
        )}
        <ul className={styles.threadList} data-testid="timeline-thread-list">
          {threads.map((t) => (
            <ReviewThreadRow key={t.threadId} thread={t} />
          ))}
        </ul>
      </div>
    </li>
  );
}
```

Widen the props (the inline props object at ~line 176) — add `threadsByReview`:

```tsx
  threadsByReview = new Map<number, ReviewThreadDto[]>(),
}: {
  prRef: PrReference;
  prUpdatedSignal: number;
  composerSlot: React.ReactNode;
  onRegisterRefetch?: (fn: () => void) => void;
  prHtmlUrl?: string | null;
  threadsByReview?: Map<number, ReviewThreadDto[]>;
}) {
```

Change the dispatch to route reviews-with-threads to `ReviewNode` (leave the other branches untouched):

```tsx
{nodes.map((node) => {
  if (node.kind === 'commit-group') {
    return <CommitGroup key={node.commits[0].id} commits={node.commits} commitBase={commitBase} />;
  }
  const dbId = reviewDbId(node.event.id);
  const threads = dbId != null ? threadsByReview.get(dbId) : undefined;
  if (isReview(node.event.verb) && threads && threads.length > 0) {
    return <ReviewNode key={node.event.id} event={node.event} threads={threads} />;
  }
  return node.event.body != null ? (
    <CommentNode key={node.event.id} event={node.event} />
  ) : (
    <Marker key={node.event.id} event={node.event} />
  );
})}
```

Add `.threadList` to `ActivityFeed.module.css`:

```css
.threadList {
  list-style: none;
  margin: var(--s-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

- [ ] **Step 4: Run to verify they pass**

Run: same as Step 2. Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.module.css frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.test.tsx
git commit -m "feat(#774): render review-thread rows under their timeline review card"
```

---

### Task 4: `OverviewTab` — run the hook, pass the prop

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`

**Interfaces:**
- Consumes: `useThreadsByReview`; `prDetail.reviewComments` (already read for `threadsCount`).
- Produces: passes `threadsByReview={useThreadsByReview(prDetail.reviewComments)}` into `<ActivityFeed>`.

- [ ] **Step 1: Implement** (this is a pure wiring change; its behavior is verified by Task 3's ActivityFeed tests and Task 6's e2e — no new unit test file).

Add the import and the hook call (near line 63 where `threadsCount` is derived):

```tsx
import { useThreadsByReview } from './timeline/useThreadsByReview';
// ...
const threadsByReview = useThreadsByReview(prDetail.reviewComments);
```

Pass it into `<ActivityFeed>` (the call site at ~line 148):

```tsx
<ActivityFeed
  prRef={prRef}
  prUpdatedSignal={prUpdatedSignal}
  prHtmlUrl={prDetail.pr.htmlUrl}
  onRegisterRefetch={handleRegisterRefetch}
  threadsByReview={threadsByReview}
  composerSlot={/* unchanged */}
/>
```

- [ ] **Step 2: Typecheck + run the existing OverviewTab tests**

Run: `cd frontend && ./node_modules/.bin/tsc -b && ./node_modules/.bin/vitest run src/components/PrDetail/OverviewTab --reporter=dot`
Expected: PASS (tsc clean; existing OverviewTab tests unaffected — the new prop is optional).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx
git commit -m "feat(#774): feed grouped review threads from OverviewTab into ActivityFeed"
```

---

### Task 5: Backend test-hook — seed review threads (opt-in)

**Files:**
- Modify: `PRism.Web/TestHooks/FakeReviewBackingStore.cs`
- Modify: `PRism.Web/TestHooks/FakePrReader.cs`
- Modify: `PRism.Web/TestHooks/TestEndpoints.cs`
- Modify: `frontend/e2e/helpers/s4-setup.ts`

**Why opt-in matters:** `FakePrReader.GetPrDetailAsync` returns `ReviewComments: Array.Empty<ReviewThreadDto>()` today, so every existing e2e sees zero threads. Keep that the default. Only a spec that calls `/test/seed-review-threads` gets threads — no existing spec (single-comment, timeline #620, parity `pr-detail-overview`) is affected, and the Overview parity baseline does not shift.

`FakePrTimelineFeedReader` already emits a body-less approval with id `review:1` (alice). Seed threads with `reviewDatabaseId: 1` so they hang under that existing card — no timeline-reader change needed.

- [ ] **Step 1: Add seeded-thread state to `FakeReviewBackingStore`**

Add the field (near `ExtraTreeFiles`):

```csharp
// #774 e2e-only: review threads returned by FakePrReader.GetPrDetailAsync. Default EMPTY so
// existing specs (and the Overview parity baseline) are unaffected; a spec opts in via
// POST /test/seed-review-threads. Cleared by Reset(). reviewDatabaseId must match a
// timeline review event id (FakePrTimelineFeedReader emits review:1) for the row to attach.
public List<ReviewThreadDto> ReviewThreads { get; } = new();
```

Add the seeding method (near `SetExtraTreeFiles`):

```csharp
// #774 e2e-only. Replaces the seeded review-thread list returned by GetPrDetailAsync.
public void SeedReviewThreads(IReadOnlyList<ReviewThreadDto> threads)
{
    ArgumentNullException.ThrowIfNull(threads);
    lock (Gate)
    {
        ReviewThreads.Clear();
        ReviewThreads.AddRange(threads);
    }
}
```

Clear it in `Reset()` (next to `ExtraTreeFiles.Clear();`):

```csharp
ReviewThreads.Clear();
```

- [ ] **Step 2: Return the seeded threads from `FakePrReader.GetPrDetailAsync`**

Change the `PrDetailDto` construction (currently `ReviewComments: Array.Empty<ReviewThreadDto>()`, inside the existing `lock (_store.Gate)`):

```csharp
ReviewComments: _store.ReviewThreads.ToList(),
```

- [ ] **Step 3: Add the `/test/seed-review-threads` endpoint to `TestEndpoints.cs`**

Add the request records (near the other `internal sealed record`s):

```csharp
internal sealed record SeedReviewThreadsRequest(IReadOnlyList<SeedReviewThread> Threads);

internal sealed record SeedReviewThread(
    string ThreadId,
    string FilePath,
    int? LineNumber,
    bool IsOutdated,
    int? OriginalLine,
    int? OriginalStartLine,
    string SubjectType,
    string? DiffHunk,
    long? ReviewDatabaseId,
    bool IsResolved,
    IReadOnlyList<SeedReviewComment> Comments);

internal sealed record SeedReviewComment(string CommentId, string Author, string CreatedAt, string Body);
```

Register the endpoint (mirror `/test/seed-tree-files`):

```csharp
// #774 e2e-only. Seeds the review threads FakePrReader returns for the scenario PR. Opt-in:
// default is empty, so specs that don't call this keep zero threads and their baselines
// unchanged. reviewDatabaseId should match a FakePrTimelineFeedReader review event (review:1)
// for the thread to render under a timeline card.
app.MapPost("/test/seed-review-threads", (SeedReviewThreadsRequest req, IServiceProvider sp) =>
{
    var store = sp.GetService<FakeReviewBackingStore>();
    if (store is null) return StoreMissing("/test/seed-review-threads");
    var threads = (req.Threads ?? Array.Empty<SeedReviewThread>())
        .Select(t => new ReviewThreadDto(
            ThreadId: t.ThreadId,
            FilePath: t.FilePath,
            LineNumber: t.LineNumber,
            IsOutdated: t.IsOutdated,
            OriginalLine: t.OriginalLine,
            OriginalStartLine: t.OriginalStartLine,
            SubjectType: string.IsNullOrEmpty(t.SubjectType) ? "LINE" : t.SubjectType,
            DiffHunk: t.DiffHunk,
            ReviewDatabaseId: t.ReviewDatabaseId,
            IsResolved: t.IsResolved,
            Comments: (t.Comments ?? Array.Empty<SeedReviewComment>())
                .Select(c => new ReviewCommentDto(c.CommentId, c.Author, null, c.CreatedAt, c.Body, null, null))
                .ToList()))
        .ToList();
    store.SeedReviewThreads(threads);
    return Results.Ok(new { ok = true, threadCount = threads.Count });
});
```

Note: confirm the exact `ReviewThreadDto` and `ReviewCommentDto` constructor argument order against `PRism.Core.Contracts` (slice 1 shipped an 11-component `ReviewThreadDto` and a `ReviewCommentDto` whose optional args are `AvatarUrl`, `EditedAt`, `DatabaseId`). Adjust the positional args if the record differs.

- [ ] **Step 4: Add the e2e helper to `frontend/e2e/helpers/s4-setup.ts`** (mirror the existing POST helpers that supply the `Origin` header)

```ts
export async function seedReviewThreads(page: import('@playwright/test').Page): Promise<void> {
  const res = await page.request.post('/test/seed-review-threads', {
    headers: { Origin: 'http://localhost:5180' },
    data: {
      threads: [
        {
          threadId: 'seed-anchored',
          filePath: 'src/Calc.cs',
          lineNumber: 5,
          isOutdated: false,
          originalLine: null,
          originalStartLine: null,
          subjectType: 'LINE',
          diffHunk: '@@ -1,4 +1,6 @@\n   public static int Mul(int a, int b) => a * b;\n+  public static int Div(int a, int b) => a / b;',
          reviewDatabaseId: 1,
          isResolved: false,
          comments: [{ commentId: 'sc1', author: 'alice', createdAt: '2026-01-01T00:00:00Z', body: 'Guard against divide-by-zero?' }],
        },
        {
          threadId: 'seed-outdated',
          filePath: 'src/Calc.cs',
          lineNumber: null,
          isOutdated: true,
          originalLine: 3,
          originalStartLine: null,
          subjectType: 'LINE',
          diffHunk: '@@ -1,2 +1,2 @@\n-  public static int Sub(int a, int b) => a - b;',
          reviewDatabaseId: 1,
          isResolved: false,
          comments: [{ commentId: 'sc2', author: 'noah.s', createdAt: '2026-01-01T00:01:00Z', body: 'This moved in a later push.' }],
        },
      ],
    },
  });
  if (!res.ok()) throw new Error(`seedReviewThreads failed: ${res.status()}`);
}
```

- [ ] **Step 5: Build + verify the hook end to end**

Run: `dotnet build --configuration Release` (Expected: 0 warnings/errors). The endpoint is exercised by Task 6's e2e; no C# unit test is added (the existing `TestEndpoints_NotRegisteredInProduction_404` negative test already covers the registration guard for all `/test/*` routes).

- [ ] **Step 6: Commit**

```bash
git add PRism.Web/TestHooks/FakeReviewBackingStore.cs PRism.Web/TestHooks/FakePrReader.cs PRism.Web/TestHooks/TestEndpoints.cs frontend/e2e/helpers/s4-setup.ts
git commit -m "test(#774): opt-in /test/seed-review-threads hook for timeline e2e"
```

---

### Task 6: Display e2e — thread rows render in the timeline

**Files:**
- Create: `frontend/e2e/pr-detail-timeline-threads.spec.ts`

**Interfaces:**
- Consumes: `setupAndOpenScenarioPr`, `resetBackendState`, `seedReviewThreads` from `./helpers/s4-setup`.

- [ ] **Step 1: Write the spec** (prod project; follows the existing `pr-detail-timeline.spec.ts` / `pr-detail-single-comment.spec.ts` shape)

```ts
import { test, expect } from '@playwright/test';
import { resetBackendState, setupAndOpenScenarioPr, seedReviewThreads } from './helpers/s4-setup';

test.beforeEach(async ({ page }) => {
  await resetBackendState(page);
});

test('#774 review threads render as accordion rows under their review card', async ({ page }) => {
  await seedReviewThreads(page);
  await setupAndOpenScenarioPr(page); // lands on acme/api/123 Overview
  await page.getByTestId('overview-tab').waitFor();

  const rows = page.getByTestId('timeline-thread-row');
  await expect(rows).toHaveCount(2);

  // Anchored thread: path:line chip; outdated thread: Outdated badge.
  await expect(page.getByText('src/Calc.cs:5')).toBeVisible();
  await expect(page.getByText('Outdated')).toBeVisible();

  // Expanding the anchored row reveals its hunk + comment.
  await page.getByRole('button', { name: /thread on src\/Calc\.cs/i }).first().click();
  await expect(page.getByTestId('timeline-thread-hunk').first()).toContainText('Div');
  await expect(page.getByText('Guard against divide-by-zero?')).toBeVisible();
});
```

- [ ] **Step 2: Run the spec**

Run: `cd frontend && ./node_modules/.bin/playwright test pr-detail-timeline-threads --project=prod`
Expected: PASS. (If the run reuses a stale server on 5180, kill all `PRism.Web` processes first — see the repo's e2e notes.)

- [ ] **Step 3: Confirm no parity-baseline shift**

The parity `pr-detail-overview` fixture (`setupAndOpenHandoffParityFixture`) never calls `seedReviewThreads`, so its baseline is unaffected. Run `./node_modules/.bin/playwright test parity-baselines --project=prod` to confirm green. If — and only if — it shifts, regenerate the Linux baseline from the CI artifact and commit it into the PR (do not regenerate a win32 baseline; CI is Linux-only).

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/pr-detail-timeline-threads.spec.ts
git commit -m "test(#774): e2e — review-thread rows render in the timeline"
```

**PR 1 gate:** run the repo's full pre-push checklist verbatim (`npm run lint`, `tsc -b`, `npm test`, `dotnet build`+`dotnet test`, `playwright test`). Post before/after Overview screenshots (both themes) on the PR. **B1-gated — request owner review; do not self-merge.**

---

# PR 2 — Click-through navigation

### Task 7: Extend `requestFileView` with an optional `threadId`

**Files:**
- Modify: `frontend/src/components/PrDetail/prDetailContext.tsx`
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx`
- Modify: `frontend/src/components/PrDetail/testUtils.tsx`
- Test: `frontend/src/components/PrDetail/prDetailContext.test.tsx` (extend if it asserts the value shape; otherwise the change is exercised by Task 10/11 tests)

**Interfaces:**
- Produces: `requestFileView(path: string, threadId?: string): void`; new context fields `pendingThreadId: string | null` and `clearPendingThreadId(): void`. Single-arg callers (HotspotsTab) are unchanged.

- [ ] **Step 1: Widen the context type** (`prDetailContext.tsx`)

```tsx
  pendingFilePath: string | null;
  pendingThreadId: string | null;
  requestFileView: (path: string, threadId?: string) => void;
  clearPendingFilePath: () => void;
  clearPendingThreadId: () => void;
```

- [ ] **Step 2: Update `PrDetailView.tsx`**

```tsx
const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
const requestFileView = useCallback(
  (path: string, threadId?: string) => {
    selectSubTab('files');
    setPendingFilePath(path);
    setPendingThreadId(threadId ?? null);
  },
  [selectSubTab],
);
const clearPendingFilePath = useCallback(() => setPendingFilePath(null), []);
const clearPendingThreadId = useCallback(() => setPendingThreadId(null), []);
```

Thread `pendingThreadId` and `clearPendingThreadId` into the context value object and its `useMemo` dependency array (alongside the existing `pendingFilePath`/`requestFileView`/`clearPendingFilePath` entries).

- [ ] **Step 3: Widen the test stub** (`testUtils.tsx`, `makePrDetailContextValue`)

```tsx
  pendingFilePath: null,
  pendingThreadId: null,
  requestFileView: vi.fn(),
  clearPendingFilePath: vi.fn(),
  clearPendingThreadId: vi.fn(),
```

- [ ] **Step 4: Typecheck**

Run: `cd frontend && ./node_modules/.bin/tsc -b`
Expected: PASS. tsc surfaces any other `requestFileView` or context-consumer that needs the new fields — fix each (the only production caller is HotspotsTab, which stays single-arg and compiles unchanged).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/prDetailContext.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/testUtils.tsx
git commit -m "feat(#774): thread an optional threadId through requestFileView"
```

---

### Task 8: Suppress `diffScrollMemory` restore during a thread deep-link

**Files:**
- Modify: `frontend/src/hooks/diffScrollMemory.ts`
- Test: `frontend/src/hooks/diffScrollMemory.test.ts` (create if absent)

**Why:** `useDiffScrollRestore` is a `useLayoutEffect` that unconditionally writes `body.scrollTop = saved` on the Files re-activation edge. Without suppression it stomps the thread-scroll target on the same paint. Gate the restore off when a thread deep-link is pending.

**Interfaces:**
- Produces: `useDiffScrollRestore(opts: { rootRef; refKey; subTab; active; suppress?: boolean })` — when `suppress` is true, the restore write is skipped.

- [ ] **Step 1: Write the failing test**

```ts
import { renderHook } from '@testing-library/react';
import { describe, expect, it, beforeEach } from 'vitest';
import { useDiffScrollCapture, useDiffScrollRestore } from './diffScrollMemory';

function makeBody(): HTMLElement {
  const root = document.createElement('div');
  const body = document.createElement('div');
  body.className = 'diff-pane-body';
  Object.defineProperty(body, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(body, 'clientHeight', { value: 200, configurable: true });
  root.appendChild(body);
  return root;
}

describe('useDiffScrollRestore suppress', () => {
  it('skips the restore write when suppress is true', () => {
    const root = makeBody();
    const body = root.querySelector<HTMLElement>('.diff-pane-body')!;
    // seed a saved offset via capture
    const capture = renderHook(() => useDiffScrollCapture({ current: body } as any, 'k', true));
    body.scrollTop = 300;
    body.dispatchEvent(new Event('scroll'));
    capture.unmount();

    body.scrollTop = 0;
    renderHook(() =>
      useDiffScrollRestore({ rootRef: { current: root } as any, refKey: 'k', subTab: 'files', active: true, suppress: true }),
    );
    expect(body.scrollTop).toBe(0); // suppressed
  });

  it('restores when suppress is false', () => {
    const root = makeBody();
    const body = root.querySelector<HTMLElement>('.diff-pane-body')!;
    const capture = renderHook(() => useDiffScrollCapture({ current: body } as any, 'k2', true));
    body.scrollTop = 250;
    body.dispatchEvent(new Event('scroll'));
    capture.unmount();

    body.scrollTop = 0;
    renderHook(() =>
      useDiffScrollRestore({ rootRef: { current: root } as any, refKey: 'k2', subTab: 'files', active: true, suppress: false }),
    );
    expect(body.scrollTop).toBe(250);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && ./node_modules/.bin/vitest run src/hooks/diffScrollMemory.test.ts --reporter=dot`
Expected: FAIL — `suppress` not honored (first test restores to 300).

- [ ] **Step 3: Implement** — add `suppress` to the opts type and the guard:

```ts
export function useDiffScrollRestore(opts: {
  rootRef: React.RefObject<HTMLElement | null>;
  refKey: string;
  subTab: string;
  active: boolean;
  suppress?: boolean;
}): void {
  const { rootRef, refKey, subTab, active, suppress } = opts;
  useLayoutEffect(() => {
    if (!active || subTab !== 'files') return;
    if (suppress) return; // an explicit thread deep-link owns the scroll position (#774)
    const root = rootRef.current;
    if (!root) return;
    const body = root.querySelector<HTMLElement>('.diff-pane-body');
    if (!body) return;
    const saved = store.get(refKey);
    if (saved != null && saved > 0) body.scrollTop = saved;
  }, [active, subTab, refKey, rootRef, suppress]);
}
```

Update the call site in `PrDetailView.tsx` (line ~391):

```tsx
useDiffScrollRestore({ rootRef: pageRef, refKey, subTab, active, suppress: pendingThreadId !== null });
```

- [ ] **Step 4: Run to verify it passes**

Run: same as Step 2. Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/diffScrollMemory.ts frontend/src/hooks/diffScrollMemory.test.ts frontend/src/components/PrDetail/PrDetailView.tsx
git commit -m "feat(#774): suppress diff-scroll restore while a thread deep-link is pending"
```

---

### Task 9: `scrollThreadIntoCenter` util

**Files:**
- Create: `frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.ts`
- Test: `frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.test.ts`

**Interfaces:**
- Produces: `scrollThreadIntoCenter(container: HTMLElement, target: HTMLElement): void` — centers `target` in `container` via `container.scrollTo`, honoring reduced motion. Mirrors `useChangeNavigation`'s rect-math (reference-frame-agnostic offset, clamped).

- [ ] **Step 1: Write the failing test** (per-element `scrollTo` stub — jsdom lacks it)

```ts
import { describe, expect, it, vi } from 'vitest';
import { scrollThreadIntoCenter } from './scrollThreadIntoCenter';

function fake(rect: Partial<DOMRect>, over: Partial<HTMLElement> = {}) {
  return { getBoundingClientRect: () => rect as DOMRect, ...over } as unknown as HTMLElement;
}

describe('scrollThreadIntoCenter', () => {
  it('centers the target and clamps to the scroll range', () => {
    const scrollTo = vi.fn();
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
      scrollHeight: 2000,
      clientHeight: 400,
      scrollTo,
    } as unknown as HTMLElement;
    const target = fake({ top: 1000, height: 40 });
    scrollThreadIntoCenter(container, target);
    // targetTop = 1000 - 0 + 0 = 1000; centered = 1000 - 200 + 20 = 820; clamp [0,1600]
    expect(scrollTo).toHaveBeenCalledWith({ top: 820, behavior: expect.any(String) });
  });

  it('clamps a near-bottom target to max scroll', () => {
    const scrollTo = vi.fn();
    const container = {
      getBoundingClientRect: () => ({ top: 0 }) as DOMRect,
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 400,
      scrollTo,
    } as unknown as HTMLElement;
    scrollThreadIntoCenter(container, fake({ top: 980, height: 40 }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 600, behavior: expect.any(String) }); // max = 1000-400
  });
});
```

- [ ] **Step 2: Run to verify it fails.** Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/FilesTab/scrollThreadIntoCenter.test.ts --reporter=dot` — FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
/**
 * Centers `target` within the scrollable `container` (the diff-pane body), mirroring
 * useChangeNavigation's reference-frame-agnostic offset math. Honors prefers-reduced-motion.
 * Never uses element.scrollIntoView (unused in this codebase, absent in jsdom). (#774)
 */
export function scrollThreadIntoCenter(container: HTMLElement, target: HTMLElement): void {
  const cRect = container.getBoundingClientRect();
  const tRect = target.getBoundingClientRect();
  const targetTop = tRect.top - cRect.top + container.scrollTop;
  const centered = targetTop - container.clientHeight / 2 + tRect.height / 2;
  const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
  const top = Math.min(maxTop, Math.max(0, centered));
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  container.scrollTo({ top, behavior: reduce ? 'auto' : 'smooth' });
}
```

- [ ] **Step 4: Run to verify it passes.** Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.ts frontend/src/components/PrDetail/FilesTab/scrollThreadIntoCenter.test.ts
git commit -m "feat(#774): add scrollThreadIntoCenter util (center-scroll, reduced-motion)"
```

---

### Task 10: FilesTab pending-thread effect (scroll / focus / flash / miss)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Modify: the global stylesheet defining `.comment-thread--resolved` (grep to locate) — add `.comment-thread--flash`.
- Test: `frontend/src/components/PrDetail/FilesTab/FilesTab.threadDeepLink.test.tsx`

**Interfaces:**
- Consumes: `pendingThreadId`, `clearPendingThreadId` from context; `scrollThreadIntoCenter`; `Snackbar`.
- Behavior: once the full-range diff has settled AND the target file is selected, query `[data-thread-id]` inside the diff region. Hit → center-scroll + `focus()` + flash + announce. Miss → Snackbar (`tone="warning"`) + announce. Clear `pendingThreadId` either way, never synchronously with `setSelectedPath`.

- [ ] **Step 1: Modify the existing pending-file effect** so a thread deep-link defers focus/announce.

In FilesTab's effect (2) hit-branch, gate the diff-region focus + announce on there being no pending thread:

```tsx
if (fileList.includes(pendingFilePath)) {
  setSelectedPath(pendingFilePath);
  if (pendingThreadId == null) {
    diffRegionRef.current?.focus();
    setLiveMessage(`Navigated to ${pendingFilePath} on the Files tab.`);
  }
  // thread deep-link: the pending-thread effect below owns focus + announce once the widget mounts.
} else {
  if (selectedPath === null || !fileList.includes(selectedPath)) setSelectedPath(fileList[0]);
  clearPendingThreadId(); // target file absent — no widget will mount; drop the thread intent too
}
clearPendingFilePath();
```

Add `pendingThreadId` and `clearPendingThreadId` to that effect's dependency array.

- [ ] **Step 2: Add the pending-thread effect** (after the pending-file effects). Add a `threadMiss` state + a `FLASH_MS` const and a `cssEscape` guard.

```tsx
const [threadMiss, setThreadMiss] = useState(false);
// ...
useEffect(() => {
  if (pendingThreadId === null) return;
  if (selectedPath === null || activeRange !== 'all' || diff.isLoading || diff.data?.range !== allRange) return;
  const region = diffRegionRef.current;
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(pendingThreadId) : pendingThreadId;
  const widget = region?.querySelector<HTMLElement>(`[data-thread-id="${escaped}"]`) ?? null;
  if (widget) {
    const body = region?.querySelector<HTMLElement>('.diff-pane-body');
    if (body) scrollThreadIntoCenter(body, widget);
    widget.focus();
    widget.classList.add('comment-thread--flash');
    window.setTimeout(() => widget.classList.remove('comment-thread--flash'), FLASH_MS);
    setLiveMessage(`Navigated to the comment thread on ${selectedPath}.`);
  } else {
    setThreadMiss(true);
    setLiveMessage('Comment thread not found in the current diff.');
  }
  clearPendingThreadId();
}, [pendingThreadId, selectedPath, activeRange, diff.isLoading, diff.data?.range, allRange, clearPendingThreadId]);
```

Render the miss Snackbar (near the existing live region; the sr-only announce is already carried by `liveMessage`, so the Snackbar itself carries no `aria-live` — matching `GitHubAuthBanner`):

```tsx
{threadMiss && (
  <Snackbar
    tone="warning"
    message="Comment thread not found in the current diff."
    onDismiss={() => setThreadMiss(false)}
  />
)}
```

Add the constant near the top of the module: `const FLASH_MS = 2000;` and import `scrollThreadIntoCenter` + `Snackbar`.

- [ ] **Step 3: Add the flash CSS.** Grep for `comment-thread--resolved` to find the global stylesheet, and add next to it:

```css
@keyframes comment-thread-flash {
  from {
    background-color: var(--accent-soft);
  }
  to {
    background-color: transparent;
  }
}
.comment-thread--flash {
  animation: comment-thread-flash 2s ease-out;
}
@media (prefers-reduced-motion: reduce) {
  .comment-thread--flash {
    animation: none;
  }
}
```

- [ ] **Step 4: Write the test** (`FilesTab.threadDeepLink.test.tsx`, mirroring `FilesTab.deepLink.test.tsx`'s module-level `currentDiff` mock + `rerender` to drive in-flight → settled). Provide the context via `PrDetailContextProvider` with `pendingFilePath` + `pendingThreadId` set, and a DiffPane that renders an `ExistingCommentWidget` with `data-thread-id`. Assert:

```tsx
// hit: widget receives focus + the flash class, clearPendingThreadId called
it('scrolls, focuses, and flashes the target thread once the diff settles', async () => {
  // ...render FilesTab under a provider with pendingFilePath='src/Calc.cs', pendingThreadId='seed-anchored'
  // seed currentDiff as in-flight, rerender to settled ('all' range, !isLoading, data.range===allRange)
  // stub the widget element's scrollTo via its container: assign (body as any).scrollTo = vi.fn()
  const widget = await screen.findByTestId(/* the ExistingCommentWidget root, data-thread-id */);
  expect(widget).toHaveClass('comment-thread--flash');
  expect(document.activeElement).toBe(widget);
  expect(clearPendingThreadId).toHaveBeenCalled();
});

// miss: no widget → snackbar + announce + clear
it('shows the not-found snackbar when the thread is absent from the diff', async () => {
  // pendingThreadId points at a thread id with no matching widget
  expect(await screen.findByText('Comment thread not found in the current diff.')).toBeInTheDocument();
  expect(screen.getByTestId('files-tab-live-region')).toHaveTextContent(/not found/i);
  expect(clearPendingThreadId).toHaveBeenCalled();
});

// plain file-only deep-link still focuses the diff region and does not touch thread state
it('leaves single-arg file navigation unchanged (diff region focused, no thread effect)', async () => {
  // pendingFilePath set, pendingThreadId null → diffRegion focused, announce "Navigated to ..."
});
```

Follow `FilesTab.deepLink.test.tsx` for the `useFileDiff` mock, the `currentDiff` mutation across `rerender`, and the `files-tab-live-region` / `files-tab-diff` testids. Stub `scrollTo` per-element (jsdom lacks it).

- [ ] **Step 5: Run to verify**

Run: `cd frontend && ./node_modules/.bin/vitest run src/components/PrDetail/FilesTab/FilesTab.threadDeepLink.test.tsx --reporter=dot`
Expected: PASS (3 tests). Then run the whole FilesTab suite to confirm no regression: `./node_modules/.bin/vitest run src/components/PrDetail/FilesTab __tests__/FilesTab --reporter=dot`.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.threadDeepLink.test.tsx <the global css file>
git commit -m "feat(#774): scroll/focus/flash a thread deep-link on the Files tab, snackbar on miss"
```

---

### Task 11: "View in diff" button on `ReviewThreadRow` (anchored only)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.module.css`
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx` (thread `onThreadNavigate` through `ReviewNode`)
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` (pass `onThreadNavigate` from `requestFileView`)

**Interfaces:**
- `ReviewThreadRow` gains `onViewInDiff?: (path: string, threadId: string) => void`. The button renders **only** for anchored threads (`lineNumber != null` and not file-level) and only when `onViewInDiff` is provided. `ActivityFeed` gains `onThreadNavigate?: (path: string, threadId: string) => void`, passed to each `ReviewThreadRow` via `ReviewNode`. `OverviewTab` passes `onThreadNavigate={requestFileView}` (2-arg form).

- [ ] **Step 1: Write the failing tests** (extend `ReviewThreadRow.test.tsx`)

```tsx
it('renders a View in diff button for anchored threads and invokes onViewInDiff', async () => {
  const user = userEvent.setup();
  const onViewInDiff = vi.fn();
  render(<ReviewThreadRow thread={base({})} onViewInDiff={onViewInDiff} />);
  await user.click(screen.getByRole('button', { name: /view in diff/i }));
  expect(onViewInDiff).toHaveBeenCalledWith('src/Calc.cs', 't1');
});

it('does not render View in diff for outdated or file-level threads', () => {
  const onViewInDiff = vi.fn();
  const { rerender } = render(<ReviewThreadRow thread={base({ lineNumber: null, isOutdated: true, subjectType: 'LINE' })} onViewInDiff={onViewInDiff} />);
  expect(screen.queryByRole('button', { name: /view in diff/i })).not.toBeInTheDocument();
  rerender(<ReviewThreadRow thread={base({ lineNumber: null, subjectType: 'FILE' })} onViewInDiff={onViewInDiff} />);
  expect(screen.queryByRole('button', { name: /view in diff/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify they fail** (`vitest run ...ReviewThreadRow.test.tsx --reporter=dot`).

- [ ] **Step 3: Implement.** Add the prop and the sibling button (after the disclosure button, inside `.rowLine`):

```tsx
export function ReviewThreadRow({
  thread,
  onViewInDiff,
}: {
  thread: ReviewThreadDto;
  onViewInDiff?: (path: string, threadId: string) => void;
}) {
  // ...
  {anchored && onViewInDiff && (
    <button
      type="button"
      className={styles.viewInDiff}
      onClick={() => onViewInDiff(thread.filePath, thread.threadId)}
    >
      View in diff
    </button>
  )}
```

Add `.viewInDiff` to the module CSS (small pill button mirroring `.toolbar button` in `ActivityFeed.module.css`):

```css
.viewInDiff {
  flex-shrink: 0;
  font-size: var(--text-xs);
  color: var(--accent);
  background: transparent;
  border: 1px solid var(--border-1);
  border-radius: 999px;
  padding: 2px 10px;
  cursor: pointer;
}
```

Thread `onThreadNavigate` through `ActivityFeed` → `ReviewNode` → `ReviewThreadRow`:

```tsx
// ActivityFeed props: add
onThreadNavigate?: (path: string, threadId: string) => void;
// ReviewNode: accept and forward it
function ReviewNode({ event, threads, onThreadNavigate }: {
  event: TimelineEvent; threads: ReviewThreadDto[];
  onThreadNavigate?: (path: string, threadId: string) => void;
}) {
  // ...
  <ReviewThreadRow key={t.threadId} thread={t} onViewInDiff={onThreadNavigate} />
}
// dispatch: pass onThreadNavigate into ReviewNode
```

In `OverviewTab.tsx`, pull `requestFileView` from context and pass it:

```tsx
const { /* ...existing..., */ requestFileView } = usePrDetailContext();
// ...
<ActivityFeed /* ... */ onThreadNavigate={requestFileView} />
```

- [ ] **Step 4: Run to verify.** `vitest run ...ReviewThreadRow.test.tsx ...ActivityFeed.test.tsx --reporter=dot` — PASS. `tsc -b` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.tsx frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.module.css frontend/src/components/PrDetail/OverviewTab/timeline/ReviewThreadRow.test.tsx frontend/src/components/PrDetail/OverviewTab/timeline/ActivityFeed.tsx frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx
git commit -m "feat(#774): wire View in diff from timeline thread rows to the Files tab"
```

---

### Task 12: Click-through e2e

**Files:**
- Modify: `frontend/e2e/pr-detail-timeline-threads.spec.ts`

- [ ] **Step 1: Add the click-through test**

```ts
test('#774 View in diff jumps to the Files tab and reveals the thread', async ({ page }) => {
  await seedReviewThreads(page);
  await setupAndOpenScenarioPr(page);
  await page.getByTestId('overview-tab').waitFor();

  // Only the anchored thread has a View in diff button.
  await page.getByRole('button', { name: /view in diff/i }).click();

  // Landed on the Files tab with the file selected and the thread widget present + focused.
  await expect(page.getByTestId('files-tab-diff')).toBeVisible();
  const widget = page.locator('[data-thread-id="seed-anchored"]');
  await expect(widget).toBeVisible();
  await expect(widget).toBeFocused();
  await expect(page.getByText('Guard against divide-by-zero?')).toBeVisible();
});
```

- [ ] **Step 2: Run.** `cd frontend && ./node_modules/.bin/playwright test pr-detail-timeline-threads --project=prod` — PASS.

- [ ] **Step 3: Commit**

```bash
git add frontend/e2e/pr-detail-timeline-threads.spec.ts
git commit -m "test(#774): e2e — timeline thread click-through lands on the Files tab"
```

**PR 2 gate:** full pre-push checklist verbatim. Post before/after screenshots (both themes) showing the timeline rows + the landed-on Files-tab thread (flash captured or described). **B1-gated — request owner review; do not self-merge.**

---

## Rollout / sequencing

- **PR 1 (residency/display)** is shippable on its own: it makes outdated threads visible in the timeline (their only home) and adds read-only accordions for all threads. No navigation.
- **PR 2 (click-through)** adds the "View in diff" affordance and the Files-tab landing. It depends on PR 1's `ReviewThreadRow`.
- Both are frontend-only in production; the sole backend change (Task 5) is an opt-in test hook with zero effect on existing specs or baselines.
- Keep the two PRs close together so anchored threads don't sit button-less for long — but each is coherent alone.
- **Slice 3 (re-anchoring outdated threads into the current diff) stays deferred.** If living with slice 2 surfaces demand, file a fresh issue then.

## Self-Review

- **Spec coverage:** D1 (Task 3 dispatch groups under review card), D2 (Task 2 collapsed-by-default), D3 (Task 2 read-only CommentCard reuse, no composer/resolve), D4 (Task 1 hook + Task 3 explicit-props), D6 (Task 11 button anchored-only), chip precedence + "was L…" (Task 2 + Global Constraints), click-through mechanics (Tasks 7–10), diffScrollMemory race (Task 8), miss path (Task 10), StaleDraftRow untouched (out of scope — noted). e2e + parity risk (Tasks 6, 12). All covered.
- **Placeholder scan:** every code step carries real code; the only "grep to locate" is the global `.comment-thread--resolved` stylesheet (a real file the implementer confirms), and one "confirm constructor arg order" note against the shipped `ReviewThreadDto` record (slice 1 is merged — verify positional args).
- **Type consistency:** `useThreadsByReview` returns `Map<number, ReviewThreadDto[]>` consumed by `ActivityFeed`'s `threadsByReview` prop (same type); `reviewDbId(id)` returns `number | null` matched against the map's `number` key; `requestFileView(path, threadId?)` signature is identical across context type, `PrDetailView`, `testUtils`, and `OverviewTab`'s `onThreadNavigate`; `ReviewThreadRow`'s `onViewInDiff(path, threadId)` matches `onThreadNavigate` matches `requestFileView`.
