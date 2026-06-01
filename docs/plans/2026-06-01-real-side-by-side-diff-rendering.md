# Real two-pane side-by-side diff rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. After Task 10, use `pr-autopilot` per memory `feedback_use_pr_autopilot.md` (PR push + comment loop + final report), then perform standard worktree cleanup per global CLAUDE.md.

**Goal:** Make `<DiffPane>`'s `'side-by-side'` mode actually render two content panes (today's class-only stub does nothing) at hunk-only scope; add a discoverable toolbar toggle alongside the existing `d` shortcut.

**Architecture:** Single `<DiffPane>` component, single `<table>` whose column count flips between 3 (unified, unchanged) and 4 (split, new) via a per-render `colSpan` constant. A new `SplitDiffLineRow` sibling component renders the per-row cell shape for split mode; the existing-comment-widget row, inline-composer-slot row, and AI annotation row stay in `DiffPane` so future diff-pane changes are written once. CSS rules under `:global(.diff-pane--split ...)` finally make the previously no-op className load-bearing.

**Tech Stack:** React 19.2.5 + TypeScript + CSS modules + Vitest + Playwright. No backend changes.

**Spec:** `docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md`
**Sidecar:** `docs/specs/2026-06-01-real-side-by-side-diff-rendering-deferrals.md`

**Verified facts (2026-06-01):**
- `parseHunkLines` at DiffPane.tsx:71-87 strips `+`/`-`/` ` sigils via `raw.slice(1)` — so `line.content` passed to `<WordDiffOverlay>` is sigil-free in both unified mode (today) and split mode (this slice).
- `MarkdownFileView.tsx` is defined but never imported in production; out of scope.
- The Playwright `pr-detail-files-diff.png` baseline lives at `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png` (per `playwright.config.ts`'s overridden `pathTemplate`), NOT in a Playwright-default `*-snapshots/` directory.
- The `--diff-add-bg` / `--diff-rem-bg` tokens at `tokens.css:784-789` are the actual CSS variables (the original spec drafted `--diff-insert-bg` / `--diff-delete-bg`; that error was corrected in the spec and is now used correctly here).

---

## Task 1: Mode-aware colSpan + literal replacement + dead-comment removal

**Spec:** § 4.1 (column-count constant), § 6.1 (literal replacement at :353 + :385, dead-comment removal)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx:105` (constant), `:191` (after `isSplit`), `:243` (AI annotation row), `:325-328` (dead comment), `:353` (comment-widget row literal), `:385` (composer-slot row literal)
- Test: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Write the failing test**

Append after the existing 9 tests in `frontend/__tests__/DiffPane.test.tsx`:

```typescript
  it('uses colSpan=4 for full-width rows in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const widgetRows = screen
      .getAllByTestId('comment-widget')
      .map((widget) => widget.closest('tr'))
      .filter((tr): tr is HTMLTableRowElement => tr !== null);
    expect(widgetRows.length).toBeGreaterThanOrEqual(1);
    widgetRows.forEach((row) => {
      const cell = row.querySelector('td');
      expect(cell?.getAttribute('colSpan') ?? cell?.getAttribute('colspan')).toBe('4');
    });
  });

  it('uses colSpan=3 for full-width rows in unified mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const widgetRows = screen
      .getAllByTestId('comment-widget')
      .map((widget) => widget.closest('tr'))
      .filter((tr): tr is HTMLTableRowElement => tr !== null);
    expect(widgetRows.length).toBeGreaterThanOrEqual(1);
    widgetRows.forEach((row) => {
      const cell = row.querySelector('td');
      expect(cell?.getAttribute('colSpan') ?? cell?.getAttribute('colspan')).toBe('3');
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: the `colSpan=4 for full-width rows in split mode` case FAILS with `expected '3' to be '4'` (today's literal is `3` regardless of mode); `colSpan=3 for full-width rows in unified mode` PASSES.

- [ ] **Step 3: Implement mode-aware colSpan + extract helper + remove dead comment**

Open `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`. Make the following edits:

(a) Delete the line at :105:
```typescript
const DIFF_TABLE_COLSPAN = 3; // gutter-old / gutter-new / content — verified at DiffPane.tsx:279-297
```

(b) Inside `DiffPane`, immediately after `const isSplit = diffMode === 'side-by-side';` (around line 191), add:
```typescript
const colSpan = isSplit ? 4 : 3;
```

(c) Replace the body of the inline IIFE at lines 211-253 (the `<tbody>{(() => { ... })()}</tbody>` block) with a call to a new helper. Define the helper inside `DiffPane`'s function body just before the return statement:

```typescript
function renderDiffRows(): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];
    const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
    const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
    const pair = findAdjacentPair(allLines, idx);

    rows.push(
      <DiffLineRow
        key={idx}
        line={line}
        pair={pair}
        threadsAtLine={threadsAtLine}
        filePath={selectedPath!}
        colSpan={colSpan}
        onLineClick={onLineClick}
        renderComposerForLine={renderComposerForLine}
        replyContext={replyContext}
      />,
    );

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      const annotations = annotationsForFile?.get(hunkCounter);
      if (annotations) {
        for (let aidx = 0; aidx < annotations.length; aidx++) {
          rows.push(
            <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
              <td colSpan={colSpan}>
                <AiHunkAnnotation annotation={annotations[aidx]} />
              </td>
            </tr>,
          );
        }
      }
    }
  }
  return rows;
}
```

Replace the IIFE in the return JSX (`<tbody>{(() => { ... })()}</tbody>`) with `<tbody>{renderDiffRows()}</tbody>`.

(d) Thread `colSpan` through `DiffLineRow`. Add it to `DiffLineRowProps`:

```typescript
interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  filePath: string;
  colSpan: number;
  onLineClick?: (anchor: InlineAnchor) => void;
  renderComposerForLine?: (filePath: string, lineNumber: number) => React.ReactNode;
  replyContext?: ExistingCommentWidgetReplyContext;
}
```

Destructure `colSpan` in `DiffLineRow` and replace the `<td colSpan={3}>` at line 353 with `<td colSpan={colSpan}>`. In `ComposerSlot` add `colSpan: number` to its props and replace the `<td colSpan={3}>` at line 385 with `<td colSpan={colSpan}>`. Pass `colSpan={colSpan}` from `DiffLineRow` to `<ComposerSlot>`.

(e) Remove the dead-ternary comment at :325-328 entirely (the block starting `// PoC scope: split-vs-unified mode currently renders the same two-gutter` through the `// (e.g., side-by-side old/new content columns). Collapsed the dead ternary` lines — the seam it describes is now wired).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: all 11 tests PASS (9 existing + 2 new colSpan tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.test.tsx
git commit -m "refactor(diff): thread mode-aware colSpan through DiffPane

Replace DIFF_TABLE_COLSPAN constant with per-render value derived
from isSplit. Update existing-comment-widget row, composer-slot row,
and AI annotation row to use the mode-aware colSpan. Extract
renderDiffRows() helper. Remove dead-ternary comment now that the
modeClass seam is about to become load-bearing.

Unified mode behavior unchanged; split mode still renders the same
visual until SplitDiffLineRow lands in subsequent tasks."
```

---

## Task 2: SplitDiffLineRow scaffold + `header` + `context` kinds + AI annotation regression guard

**Spec:** § 4.1 (architecture), § 5.2 (split iteration), § 6.2 (SplitDiffLineRow component), § 8.2 (AI annotation rows)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (add `SplitDiffLineRow`, branch `renderDiffRows`)
- Test: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append three tests:

```typescript
  it('renders hunk-header as a single colSpan=4 row in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const hunkHeaderRows = diffPane.querySelectorAll('tr.diff-line--hunk-header');
    expect(hunkHeaderRows.length).toBeGreaterThanOrEqual(1);
    hunkHeaderRows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      expect(cells.length).toBe(1);
      const cell = cells[0];
      expect(cell.getAttribute('colSpan') ?? cell.getAttribute('colspan')).toBe('4');
      expect(cell.textContent).toMatch(/@@/);
    });
  });

  it('renders context line with both gutters and same content on both sides in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const contextRows = diffPane.querySelectorAll('tr.diff-line--context');
    expect(contextRows.length).toBeGreaterThanOrEqual(1);
    const firstContext = contextRows[0];
    const cells = firstContext.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toMatch(/\d+/); // old line number
    expect(cells[2].textContent).toMatch(/\d+/); // new line number
    expect(cells[1].textContent).toBe(cells[3].textContent); // same content both sides
    expect(cells[1].textContent).not.toBe('');
  });

  it('renders AI annotation row with colSpan=4 in split mode', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiHunkAnnotations).mockReturnValue([
      {
        path: 'src/main.ts',
        hunkIndex: 0,
        body: 'Consider naming this clearer.',
        tone: 'calm',
      },
    ]);
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const annotationCell = screen.getByTestId('ai-hunk-annotation').closest('td');
    expect(annotationCell).not.toBeNull();
    expect(annotationCell?.getAttribute('colSpan') ?? annotationCell?.getAttribute('colspan')).toBe('4');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx -t "hunk-header as a single colSpan" && cd frontend && npx vitest run __tests__/DiffPane.test.tsx -t "context line with both gutters"`
Expected: the first two FAIL (no SplitDiffLineRow exists yet, so the rows render via today's stubbed split = unified shape — `tr.diff-line--hunk-header` exists but has 3 cells, not 1 with colSpan=4; `tr.diff-line--context` has 3 cells, not 4). The third test (AI annotation colSpan=4) will FAIL until the renderSplitRows branch is added in Step 3.

- [ ] **Step 3: Implement SplitDiffLineRow with `header` + `context` kinds and branch renderDiffRows**

Open `DiffPane.tsx`. Make these edits:

(a) After `DiffLineRow`'s definition near the end of the file, add the `SplitDiffLineRow` component:

```typescript
type SplitRowKind = 'header' | 'paired' | 'context' | 'solo-delete' | 'solo-insert';

interface SplitDiffLineRowProps {
  kind: SplitRowKind;
  oldLineNum?: number | null;
  newLineNum?: number | null;
  oldText?: string;
  newText?: string;
  content?: string;
  filePath: string;
  onLineClick?: (anchor: InlineAnchor) => void;
}

function SplitDiffLineRow({
  kind,
  oldLineNum,
  newLineNum,
  content,
  filePath,
  onLineClick,
}: SplitDiffLineRowProps) {
  if (kind === 'header') {
    return (
      <tr className="diff-line diff-line--hunk-header">
        <td colSpan={4}>
          <span className={`diff-hunk-header ${styles.diffHunkHeader}`}>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'context') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--context">
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
      </tr>
    );
  }

  // Modification kinds added in Task 3.
  return null;
}
```

Note the `data-side="old"` / `data-side="new"` attributes on the two `.diffContent` cells — Task 5's CSS targets them via attribute selectors instead of `:first-of-type` / `:last-of-type` (robust against future column additions).

(b) Branch `renderDiffRows()` from Task 1. Replace it with a dispatcher and add a `renderSplitRows()` sibling:

```typescript
function renderDiffRows(): React.ReactNode[] {
  if (isSplit) return renderSplitRows();
  return renderUnifiedRows();
}

function renderUnifiedRows(): React.ReactNode[] {
  // The body of Task 1's renderDiffRows() moves here verbatim — same iteration,
  // same DiffLineRow emission, same AI annotation emission. Unchanged.
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];
    const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
    const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
    const pair = findAdjacentPair(allLines, idx);

    rows.push(
      <DiffLineRow
        key={idx}
        line={line}
        pair={pair}
        threadsAtLine={threadsAtLine}
        filePath={selectedPath!}
        colSpan={colSpan}
        onLineClick={onLineClick}
        renderComposerForLine={renderComposerForLine}
        replyContext={replyContext}
      />,
    );

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      const annotations = annotationsForFile?.get(hunkCounter);
      if (annotations) {
        for (let aidx = 0; aidx < annotations.length; aidx++) {
          rows.push(
            <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
              <td colSpan={colSpan}>
                <AiHunkAnnotation annotation={annotations[aidx]} />
              </td>
            </tr>,
          );
        }
      }
    }
  }
  return rows;
}

function renderSplitRows(): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;
  for (let idx = 0; idx < allLines.length; idx++) {
    const line = allLines[idx];

    if (line.type === 'hunk-header') {
      hunkCounter += 1;
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="header"
          content={line.content}
          filePath={selectedPath!}
        />,
      );
      const annotations = annotationsForFile?.get(hunkCounter);
      if (annotations) {
        for (let aidx = 0; aidx < annotations.length; aidx++) {
          rows.push(
            <tr key={`ann-${idx}-${aidx}`} className={styles.aiHunkRow}>
              <td colSpan={colSpan}>
                <AiHunkAnnotation annotation={annotations[aidx]} />
              </td>
            </tr>,
          );
        }
      }
      continue;
    }

    if (line.type === 'context') {
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="context"
          oldLineNum={line.oldLineNum}
          newLineNum={line.newLineNum}
          content={line.content}
          filePath={selectedPath!}
          onLineClick={onLineClick}
        />,
      );
      continue;
    }

    // delete/insert kinds added in Task 3 — for now they fall through silently
    // (no row emitted). The only pre-existing DiffPane.test.tsx test that uses
    // diffMode="side-by-side" today asserts the wrapper className (line 189);
    // no current test asserts content for split-mode insert/delete lines, so
    // this temporary gap is invisible to the suite.
  }
  return rows;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: all 14 tests PASS (9 existing + 2 from Task 1 + 3 new in Task 2).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.test.tsx
git commit -m "feat(diff): SplitDiffLineRow scaffold + header + context kinds

Adds the SplitDiffLineRow sibling component to DiffLineRow and forks
renderDiffRows into mode-dispatcher + renderUnifiedRows (today's body)
+ renderSplitRows (new). Implements the header and context kinds.

Modification kinds (paired / solo-delete / solo-insert) land in
Task 3 — until then split-mode insert/delete lines emit no row.
No existing test exercises content of insert/delete lines in split
mode, so the suite stays green.

AI annotation rows render in both modes via the mode-aware colSpan
constant from Task 1; the regression guard test pins colSpan=4 in
split mode."
```

---

## Task 3: SplitDiffLineRow modification kinds (`solo-delete` + `solo-insert` + `paired`) + click-affordance behavioral test

**Spec:** § 5.2 (split iteration insert/delete branches), § 5.3 (pairing algorithm), § 6.2 (SplitDiffLineRow paired/solo cells, WordDiffOverlay reuse, hover-class commitment), § 9.1 test #7 (click affordance → InlineAnchor)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Test: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
  it('renders solo-delete row with right cells aria-hidden and row aria-label', () => {
    const soloDeleteHunk = `@@ -1,2 +1,1 @@
-line removed
 line kept
`;
    const soloFile: FileChange = {
      path: 'src/solo.ts',
      status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 1, body: soloDeleteHunk }],
    };
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/solo.ts"
        file={soloFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const deleteRows = diffPane.querySelectorAll('tr.diff-line--delete');
    expect(deleteRows.length).toBe(1);
    expect(deleteRows[0].getAttribute('aria-label')).toBe('Removed line 1');
    const cells = deleteRows[0].querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toBe('1');
    expect(cells[1].textContent).toContain('line removed');
    expect(cells[2].getAttribute('aria-hidden')).toBe('true');
    expect(cells[2].className).toContain('diffCellEmpty');
    expect(cells[3].getAttribute('aria-hidden')).toBe('true');
    expect(cells[3].className).toContain('diffCellEmpty');
    expect(deleteRows[0].querySelectorAll('.diff-comment-affordance').length).toBe(0);
  });

  it('renders solo-insert row with left cells aria-hidden, affordance on right, row aria-label', () => {
    const soloInsertHunk = `@@ -1,1 +1,2 @@
 line kept
+line added
`;
    const soloFile: FileChange = {
      path: 'src/solo.ts',
      status: 'modified',
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, body: soloInsertHunk }],
    };
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/solo.ts"
        file={soloFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={() => {}}
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const insertRows = diffPane.querySelectorAll('tr.diff-line--insert');
    expect(insertRows.length).toBe(1);
    expect(insertRows[0].getAttribute('aria-label')).toBe('Added line 2');
    const cells = insertRows[0].querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].getAttribute('aria-hidden')).toBe('true');
    expect(cells[0].className).toContain('diffCellEmpty');
    expect(cells[1].getAttribute('aria-hidden')).toBe('true');
    expect(cells[1].className).toContain('diffCellEmpty');
    expect(cells[2].textContent).toContain('2');
    expect(cells[3].textContent).toContain('line added');
    expect(insertRows[0].querySelectorAll('.diff-comment-affordance').length).toBe(1);
  });

  it('renders paired modification as a single row with WordDiffOverlay on both sides in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={() => {}}
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const pairedRows = diffPane.querySelectorAll('tr.diff-line--paired');
    expect(pairedRows.length).toBe(1);
    const pairedRow = pairedRows[0];
    const cells = pairedRow.querySelectorAll('td');
    expect(cells.length).toBe(4);
    expect(cells[0].textContent).toMatch(/\d+/);
    expect(cells[2].textContent).toMatch(/\d+/);
    const overlays = pairedRow.querySelectorAll('[data-testid="word-diff-overlay"]');
    expect(overlays.length).toBe(2);
    expect(pairedRow.querySelectorAll('.diff-comment-affordance').length).toBe(1);
  });

  it('clicking the affordance on a paired row produces an InlineAnchor with the right-side newLineNum', () => {
    const onLineClick = vi.fn();
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
        onLineClick={onLineClick}
      />,
    );
    const pairedRow = screen.getByTestId('diff-pane').querySelector('tr.diff-line--paired')!;
    const affordance = pairedRow.querySelector('button.diff-comment-affordance') as HTMLButtonElement;
    affordance.click();
    expect(onLineClick).toHaveBeenCalledTimes(1);
    const anchor = onLineClick.mock.calls[0][0];
    expect(anchor.side).toBe('right');
    // sampleFile's paired row is `-line two` followed by `+line two modified`,
    // and parseHunkLines assigns newLineNum=2 to the insert.
    expect(anchor.lineNumber).toBe(2);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: the 4 new tests FAIL — no `tr.diff-line--delete`, `tr.diff-line--insert`, or `tr.diff-line--paired` is emitted in split mode yet (Task 2 left insert/delete fall-through).

- [ ] **Step 3: Implement the three modification kinds + click-affordance + boundary pairing**

Open `DiffPane.tsx`. Extend `SplitDiffLineRow` with three more kind branches:

```typescript
  if (kind === 'solo-delete') {
    return (
      <tr
        className="diff-line diff-line--delete"
        aria-label={`Removed line ${oldLineNum ?? '?'}`}
      >
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="new"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
      </tr>
    );
  }

  if (kind === 'solo-insert') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: content ?? '',
      });
    };
    return (
      <tr
        className="diff-line diff-line--insert"
        aria-label={`Added line ${newLineNum ?? '?'}`}
      >
        <td
          aria-hidden="true"
          className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld} ${styles.diffCellEmpty}`}
        ></td>
        <td
          aria-hidden="true"
          data-side="old"
          className={`diff-content ${styles.diffContent} ${styles.diffCellEmpty}`}
        ></td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <span>{content}</span>
        </td>
      </tr>
    );
  }

  if (kind === 'paired') {
    const handleClick = () => {
      if (!onLineClick || newLineNum == null) return;
      onLineClick({
        filePath,
        lineNumber: newLineNum,
        side: 'right',
        anchoredSha: '',
        anchoredLineContent: newText ?? '',
      });
    };
    return (
      <tr className="diff-line diff-line--paired">
        <td className={`diff-gutter diff-gutter--old ${styles.diffGutter} ${styles.diffGutterOld}`}>
          {oldLineNum ?? ''}
        </td>
        <td data-side="old" className={`diff-content ${styles.diffContent}`}>
          <WordDiffOverlay oldText={oldText ?? ''} newText={newText ?? ''} type="delete" />
        </td>
        <td className={`diff-gutter diff-gutter--new ${styles.diffGutter} ${styles.diffGutterNew}`}>
          {newLineNum != null && onLineClick ? (
            <button
              type="button"
              className={`diff-comment-affordance ${styles.diffCommentAffordance}`}
              aria-label={`Add comment on line ${newLineNum}`}
              onClick={handleClick}
            >
              {newLineNum}
            </button>
          ) : (
            (newLineNum ?? '')
          )}
        </td>
        <td data-side="new" className={`diff-content ${styles.diffContent}`}>
          <WordDiffOverlay oldText={oldText ?? ''} newText={newText ?? ''} type="insert" />
        </td>
      </tr>
    );
  }
```

Replace the placeholder-comment in `renderSplitRows()` (the "delete/insert kinds added in Task 3" block) with the boundary-pair iteration:

```typescript
    if (line.type === 'delete') {
      const next = allLines[idx + 1];
      if (next?.type === 'insert') {
        rows.push(
          <SplitDiffLineRow
            key={idx}
            kind="paired"
            oldLineNum={line.oldLineNum}
            newLineNum={next.newLineNum}
            oldText={line.content}
            newText={next.content}
            filePath={selectedPath!}
            onLineClick={onLineClick}
          />,
        );
        idx += 1; // consume the paired insert; the for-loop's ++ advances past it
        continue;
      }
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="solo-delete"
          oldLineNum={line.oldLineNum}
          content={line.content}
          filePath={selectedPath!}
        />,
      );
      continue;
    }

    if (line.type === 'insert') {
      rows.push(
        <SplitDiffLineRow
          key={idx}
          kind="solo-insert"
          newLineNum={line.newLineNum}
          content={line.content}
          filePath={selectedPath!}
          onLineClick={onLineClick}
        />,
      );
      continue;
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: all 18 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.test.tsx
git commit -m "feat(diff): SplitDiffLineRow modification kinds (solo + paired) + click affordance test

Implements solo-delete, solo-insert, and paired SplitDiffLineRow
kinds. Empty cells use aria-hidden=true + the styles.diffCellEmpty
class; the <tr> itself carries an aria-label ('Removed line N' /
'Added line N') so screen-reader users get a row-level summary
without having to traverse the aria-hidden cells.

Paired kind detects boundary delete+insert pairs (matches existing
findAdjacentPair algorithm) and renders both WordDiffOverlay
instances on the same <tr>. Comment affordance on the right gutter
fires onLineClick with the insert's newLineNum (spec § 9.1 test #7
captured here).

Multi-line modification block alignment stays deferred per DSx3."
```

---

## Task 4: Wire existing-comment-widget rows + composer-slot rows under split-mode rows

**Spec:** § 8.3 (existing comment widget rows in split mode), § 8.4 (inline composer slot)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx`
- Test: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Write the failing test**

Append:

```typescript
  it('attaches comment widget to paired row in split mode (anchored to next.newLineNum)', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[sampleThread]}
        prUrl=""
      />,
    );
    const widget = screen.getByTestId('comment-widget');
    const widgetRow = widget.closest('tr');
    expect(widgetRow).not.toBeNull();
    const prevRow = widgetRow?.previousElementSibling;
    expect(prevRow?.className).toContain('diff-line--paired');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx -t "comment widget to paired row"`
Expected: FAIL — no widget row emitted in split mode yet (Task 3 only emits the modification rows themselves).

- [ ] **Step 3: Implement widget + composer slot emission in split iteration**

Open `DiffPane.tsx`. Define a helper inside `renderSplitRows()` at the top of its body:

```typescript
function renderSplitRows(): React.ReactNode[] {
  const rows: React.ReactNode[] = [];
  let hunkCounter = -1;

  function emitWidgetAndComposerRows(idx: number, anchorLineNum: number | null): void {
    if (anchorLineNum == null) return;
    const threads = threadsByLine.get(anchorLineNum);
    if (threads && threads.length > 0) {
      rows.push(
        <tr key={`widget-${idx}`} className={`diff-comment-row ${styles.diffCommentRow}`}>
          <td colSpan={colSpan}>
            <ExistingCommentWidget threads={threads} replyContext={replyContext} />
          </td>
        </tr>,
      );
    }
    if (renderComposerForLine) {
      const node = renderComposerForLine(selectedPath!, anchorLineNum);
      if (node) {
        rows.push(
          <tr key={`composer-${idx}`} className={`diff-composer-row ${styles.diffComposerRow}`}>
            <td colSpan={colSpan}>{node}</td>
          </tr>,
        );
      }
    }
  }

  // ... existing for-loop body ...
}
```

Then call `emitWidgetAndComposerRows(idx, anchorLineNum)` after each emission that has a right-side anchor:

- After the paired modification row: `emitWidgetAndComposerRows(idx, next.newLineNum)` (before the `idx += 1`)
- After the context row: `emitWidgetAndComposerRows(idx, line.newLineNum)`
- After the solo-insert row: `emitWidgetAndComposerRows(idx, line.newLineNum)`
- NOT after solo-delete or hunk-header (no right-side line).

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: all 19 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/__tests__/DiffPane.test.tsx
git commit -m "feat(diff): existing-comment-widget + composer-slot rows under split mode rows

After each paired / context / solo-insert row in split mode, emit
the existing-comment-widget row (if threadsByLine has entries for
the right-side line number) and the composer-slot row (if
renderComposerForLine returns non-null). Both use the mode-aware
colSpan=4. Solo-delete and hunk-header rows do NOT emit widget or
composer rows — they have no right-side line number to anchor to,
consistent with today's unified-mode behavior."
```

---

## Task 5: CSS module rules for split mode + colgroup

**Spec:** § 4.1 (colgroup), § 4.3 (single-table trade-off), § 6.3 (CSS rules: separator, empty-cell tint, row-tint isolation, long-line policy)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx` (add `<colgroup>` in split mode + the `.diffCellEmpty` placeholder rule already added in Task 3 — extend it here)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css`
- Test: `frontend/__tests__/DiffPane.test.tsx`

- [ ] **Step 1: Write the failing tests**

Append:

```typescript
  it('emits a colgroup with 4 col elements in split mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const colgroup = diffPane.querySelector('colgroup');
    expect(colgroup).not.toBeNull();
    expect(colgroup?.querySelectorAll('col').length).toBe(4);
  });

  it('does not emit a colgroup in unified mode', () => {
    render(
      <DiffPane
        prRef={samplePrRef}
        selectedPath="src/main.ts"
        file={sampleFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        prUrl=""
      />,
    );
    const diffPane = screen.getByTestId('diff-pane');
    const colgroup = diffPane.querySelector('colgroup');
    expect(colgroup).toBeNull();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx -t "colgroup"`
Expected: both FAIL — no `<colgroup>` is emitted today.

- [ ] **Step 3: Implement CSS rules + colgroup injection + data-side tint targeting**

Add to `frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css` (replacing the placeholder `.diffCellEmpty` rule introduced in Task 3):

```css
/* Slice 1 — split-mode rules. The previously-no-op `.diff-pane--split`
   className from DiffPane.tsx:192 is finally load-bearing. See spec § 6.3
   at docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md.

   Single-combined `:global(...)` form (rather than nested `:global()`)
   matches the existing codebase convention and keeps specificity at
   one class selector per global-class, two with the descendant. */

:global(.diff-pane--split) .diffTable {
  table-layout: fixed;
}

/* Vertical pane separator between old-content and new-gutter.
   Mirrors handoff design/handoff/screens.css:674 (.diff-half + .diff-half). */
:global(.diff-pane--split) .diffGutterNew {
  border-left: 1px solid var(--border-1);
}

/* Empty halves of solo-delete and solo-insert rows. Neutral background so
   the row tint below doesn't bleed across the pane separator. */
.diffCellEmpty {
  background: var(--surface-1);
}

/* Row tint isolation in split mode.

   tokens.css:784-789 sets `.diff-line--insert { background: var(--diff-add-bg) }`
   on the row. In unified mode that's correct (single-content layout).
   In split mode the row spans both panes, so a row-level tint would
   color the empty right cells too — wrong visual signal. Override the
   row tint to transparent in split mode and apply the tint to the
   populated content cell only, targeted by data-side attribute (robust
   against future column additions vs :first-of-type/:last-of-type). */

:global(.diff-pane--split .diff-line--insert) {
  background: transparent;
}
:global(.diff-pane--split .diff-line--insert) .diffContent {
  background: var(--diff-add-bg);
}

:global(.diff-pane--split .diff-line--delete) {
  background: transparent;
}
:global(.diff-pane--split .diff-line--delete) .diffContent {
  background: var(--diff-rem-bg);
}

:global(.diff-pane--split .diff-line--paired) {
  background: transparent;
}
:global(.diff-pane--split .diff-line--paired) .diffContent[data-side='old'] {
  background: var(--diff-rem-bg);
}
:global(.diff-pane--split .diff-line--paired) .diffContent[data-side='new'] {
  background: var(--diff-add-bg);
}
```

In `DiffPane.tsx`, replace `<table className={...}>` with the colgroup-injecting variant:

```typescript
<table className={`diff-table ${styles.diffTable}`}>
  {isSplit && (
    <colgroup>
      <col style={{ width: '3em' }} />
      <col />
      <col style={{ width: '3em' }} />
      <col />
    </colgroup>
  )}
  <tbody>{renderDiffRows()}</tbody>
</table>
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd frontend && npx vitest run __tests__/DiffPane.test.tsx`
Expected: all 21 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/DiffPane.module.css frontend/__tests__/DiffPane.test.tsx
git commit -m "feat(diff): split-mode CSS rules + colgroup + data-side tint targeting

Wire up the previously-no-op .diff-pane--split className. Rules:
- table-layout: fixed for predictable column widths
- vertical pane separator (border-left on .diffGutterNew)
- empty cells neutralized to var(--surface-1)
- row tint isolation: split mode applies tint to .diffContent cells
  only via data-side attribute selectors (NOT :first-of-type, which
  would silently break under future column additions)

Table emits a <colgroup> with 4 <col> elements when split, sized
[3em, auto, 3em, auto].

Long-line policy stays: white-space: pre + overflow: visible inherited
from the existing .diffContent rule; the table widens and the body's
overflow-auto handles horizontal scroll. Empty-side scroll trade-off
documented in spec § 4.3 and sidecar DSx4."
```

---

## Task 6: FilesTab toolbar toggle button

**Spec:** § 7 (toolbar button), § 7.1 (default rationale — non-blocking)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`
- Test: `frontend/__tests__/FilesTab.test.tsx`

- [ ] **Step 1: Write the failing test**

`FilesTab.test.tsx` already has a `renderFilesTab(prDetail = minimalPrDetail)` helper at line 101 + a `diffOrDraft(diffMock)` fetch wrapper at line 27 + `sampleDiff` / `minimalPrDetail` fixtures + `jsonResponse` helper. Append these tests inside the existing `describe('FilesTab', ...)` block:

```typescript
  it('renders a diff-mode toggle button in the toolbar with stateful label and aria-pressed', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const toggleButton = await screen.findByRole('button', { name: /side-by-side|unified/i });
    expect(toggleButton).toBeInTheDocument();
    expect(toggleButton.getAttribute('aria-pressed')).toBe('true'); // default is 'side-by-side'
    expect(toggleButton.textContent).toMatch(/side-by-side/i);
  });

  it('toggles diff mode when clicked', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const toggleButton = await screen.findByRole('button', { name: /side-by-side|unified/i });
    fireEvent.click(toggleButton);
    expect(toggleButton.getAttribute('aria-pressed')).toBe('false');
    expect(toggleButton.textContent).toMatch(/unified/i);
  });

  it('disables the toggle button below 900px viewport and aria-pressed reflects forced effective mode', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    // Wait for the button to query the resized viewport state — getByRole on a
    // disabled button works in @testing-library because disabled buttons stay
    // in the role tree (only hidden=true removes them).
    const toggleButton = (await screen.findByRole('button', {
      name: /side-by-side|unified/i,
    })) as HTMLButtonElement;
    expect(toggleButton.disabled).toBe(true);
    // Effective mode forced to 'unified' by the viewport gate; aria-pressed
    // and label both reflect THAT (not the stored diffMode).
    expect(toggleButton.getAttribute('aria-pressed')).toBe('false');
    expect(toggleButton.textContent).toMatch(/unified/i);
    // Restore for subsequent tests in this file.
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1200 });
    window.dispatchEvent(new Event('resize'));
  });
```

(`fireEvent`, `screen`, `waitFor` are already imported; `findByRole` is a `screen` method.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd frontend && npx vitest run __tests__/FilesTab.test.tsx -t "diff-mode toggle"`
Expected: all 3 FAIL — no button with that role/name exists today.

- [ ] **Step 3: Implement toolbar button**

Open `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx`. Inside the `files-tab-toolbar` div (around lines 343-357), add the button after the existing iteration/commit-picker block:

```typescript
        <button
          type="button"
          className={`toggle-btn ${styles.diffModeToggle}`}
          aria-pressed={effectiveDiffMode === 'side-by-side'}
          disabled={viewportWidth < 900}
          onClick={handleToggleDiffMode}
        >
          {effectiveDiffMode === 'side-by-side' ? 'Side-by-side' : 'Unified'}
        </button>
```

Note that `aria-pressed` and the label BOTH derive from `effectiveDiffMode` — they stay coherent across the viewport gate. Using the HTML `disabled` attribute (rather than `aria-disabled`) avoids the silent-onClick keyboard accessibility gap: a disabled button cannot be activated by keyboard, so there's no expectation of feedback that goes unmet.

Add to `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css`:

```css
.diffModeToggle {
  margin-left: auto;
  flex-shrink: 0;
}
```

`margin-left: auto` pushes the button to the right of the flex toolbar; `flex-shrink: 0` keeps it from being squashed when wrapping.

- [ ] **Step 4: Run tests to verify all pass**

Run: `cd frontend && npx vitest run __tests__/FilesTab.test.tsx`
Expected: all FilesTab tests pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.module.css frontend/__tests__/FilesTab.test.tsx
git commit -m "feat(files-tab): diff-mode toolbar toggle button

Adds the toolbar <button> that was missing from the Files tab.
Renders 'Side-by-side' or 'Unified' depending on effective mode
(stays coherent with the viewport gate at <900px); aria-pressed
reflects effective mode too. HTML disabled when viewport <900,
which removes the button from keyboard interaction entirely
(better than aria-disabled here — a viewport-gated button has no
useful action when the gate is active).

Click triggers handleToggleDiffMode — the same handler the 'd'
keyboard shortcut already uses.

Resolves spec § 7 'toolbar button' requirement (the brainstorm's
grep during ce-doc-review confirmed no button existed in production)."
```

---

## Task 7: Playwright e2e — split-mode DOM topology + viewport gate

**Spec:** § 9.2 (Playwright DOM-topology assertions)

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`

- [ ] **Step 1: Write the new tests**

Open `frontend/e2e/parity-baselines.spec.ts`. After the `pr-detail-files-diff` test at line 188, append:

```typescript
  test('split mode renders word-diff overlays on the same <tr>; unified renders on different <tr>s', async ({ page }) => {
    await page.setViewportSize(VIEWPORT);
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diff = page.locator('[data-testid="files-tab-diff"]');
    await diff.waitFor();

    // Default mode is 'side-by-side'. Verify two word-diff-overlay elements on the same <tr>.
    const splitOverlayRows = await diff
      .locator('tr')
      .filter({ has: page.locator('[data-testid="word-diff-overlay"]') })
      .all();
    expect(splitOverlayRows.length).toBeGreaterThan(0);
    for (const row of splitOverlayRows) {
      const overlaysInRow = await row.locator('[data-testid="word-diff-overlay"]').count();
      expect(overlaysInRow).toBe(2);
    }

    // Toggle to unified via the toolbar button.
    await page.getByRole('button', { name: /side-by-side|unified/i }).click();
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="diff-pane"].diff-pane--unified'),
    );

    // In unified mode, the two overlay elements per modification live on DIFFERENT <tr>s.
    const unifiedOverlayRows = await diff
      .locator('tr')
      .filter({ has: page.locator('[data-testid="word-diff-overlay"]') })
      .all();
    expect(unifiedOverlayRows.length).toBeGreaterThan(0);
    for (const row of unifiedOverlayRows) {
      const overlaysInRow = await row.locator('[data-testid="word-diff-overlay"]').count();
      expect(overlaysInRow).toBe(1);
    }
  });

  test('viewport <900px forces unified className regardless of stored diffMode', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 });
    await setupAndOpenHandoffParityFixture(page);
    await page.goto('/pr/acme/api/123/files');
    await page.locator('[data-testid="files-tab-tree-row"][data-path="src/Calc.cs"]').click();
    const diffPane = page.locator('[data-testid="diff-pane"]');
    await diffPane.waitFor();
    await expect(diffPane).toHaveClass(/diff-pane--unified/);
  });
```

- [ ] **Step 2: Run tests against the current build**

Run: `cd frontend && npx playwright test --project=prod e2e/parity-baselines.spec.ts -g "split mode renders word-diff" --reporter=list`

Expected: at this point in the plan the production code already supports split mode (Tasks 1-6), so this should largely pass. If any assertion fails, the most likely cause is the toolbar button accessible-name regex (adjust if Task 6 produced different label casing). The visual baseline test `pr-detail-files-diff` is expected to FAIL because the screenshot no longer matches — that's Task 8.

- [ ] **Step 3: No production code changes**

The test is written in this task to land alongside the other Playwright tests. If it passes immediately, treat it as a regression-guard pin. No implementation step.

- [ ] **Step 4: Run full Playwright prod-project suite**

Run: `cd frontend && npx playwright test --project=prod`
Expected: all prod-project tests PASS except `pr-detail-files-diff` (baseline mismatch — Task 8 recaptures).

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts
git commit -m "test(e2e): split-mode DOM topology + viewport gate Playwright

Two new tests in parity-baselines.spec.ts:
- split mode renders 2 word-diff-overlay elements on the same <tr>
  per modification; pressing the toolbar toggle switches to unified
  where the 2 overlays land on different <tr>s
- viewport <900px forces 'diff-pane--unified' className regardless
  of stored diffMode

The pr-detail-files-diff visual baseline test still fails because
the screenshot no longer matches — Task 8 recaptures it."
```

---

## Task 8: Recapture `pr-detail-files-diff.png` parity baseline

**Spec:** § 9.3 (baseline change rationale; baseline is at `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png` per `playwright.config.ts` `pathTemplate` override)

**Files:**
- Regenerate: `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png` (29 KB existing file)

- [ ] **Step 1: Run baseline update against the new renderer**

Run: `cd frontend && npx playwright test --project=prod -g "pr-detail-files-diff" --update-snapshots`
Expected: the previously-failing test now PASSES because the new baseline reflects true two-pane rendering.

- [ ] **Step 2: Inspect the new baseline visually**

Open `frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png` and verify:
- Two-pane layout with left + right content columns visible
- Old line numbers on far-left, new line numbers in the middle gutter
- Vertical separator visible between the two panes
- Word-diff highlighting on modification rows (red on left, green on right)
- Solo-delete / solo-insert rows (if any) show one populated side + one neutral empty side

If anything looks wrong (overlap, missing separator, wrong colors), stop and revisit Task 5 (CSS) or earlier before continuing.

- [ ] **Step 3: Re-run full prod-project suite to confirm green**

Run: `cd frontend && npx playwright test --project=prod`
Expected: all prod-project tests PASS, including `pr-detail-files-diff`.

- [ ] **Step 4: (no separate test step — covered by step 3)**

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/__screenshots__/win32/pr-detail-files-diff.png
git commit -m "test(e2e): recapture pr-detail-files-diff parity baseline

The stub side-by-side renderer's baseline (29 KB, captured PR #90)
is replaced by the new two-pane rendering. This is an intentional
visual change of the stub baseline — the stub is replaced with true
two-pane rendering, not a fidelity loss (slice 1 spec § 9.3)."
```

---

## Task 9: Update `docs/backlog/05-P4-polish.md` P4-B8 entry

**Spec:** § 2 (acknowledged scope shift from P4-B8 backlog wording)

**Files:**
- Modify: `docs/backlog/05-P4-polish.md:96-98`

- [ ] **Step 1: Edit the backlog entry**

Open `docs/backlog/05-P4-polish.md`. Find the P4-B8 entry around line 96:

```markdown
### P4-B8: Per-file expand-context-to-full-file
- **Effort**: S
- **Description.** Show full file content with the diff highlighted, on demand. PoC explicitly excluded; revisit if reviewers complain.
```

Replace with:

```markdown
### P4-B8: Per-file expand-context-to-full-file
- **Effort**: S (slice 2 of 2; slice 1 was the renderer prerequisite)
- **Status**: Slice 1 shipped 2026-06-01 — true two-pane side-by-side rendering (`docs/specs/2026-06-01-real-side-by-side-diff-rendering-design.md`). Slice 2 — whole-file context expansion on top of the two-pane renderer — awaits its own brainstorm.
- **Description.** Show full file content with the diff highlighted, on demand. PoC explicitly excluded; revisit if reviewers complain.
```

- [ ] **Step 2: Verify with a grep**

Run: `cd D:/src/PRism/.claude/worktrees/real-side-by-side-diff-spec && grep -n "P4-B8" docs/backlog/05-P4-polish.md`
Expected: line numbers of the updated entry; the entry includes the new `**Status**` bullet.

- [ ] **Step 3: Commit**

```bash
git add docs/backlog/05-P4-polish.md
git commit -m "docs(backlog): note P4-B8 slice 1 shipped, slice 2 still pending

The 2026-06-01 brainstorm split the original P4-B8 'Per-file
expand-context-to-full-file' into two slices: slice 1 (renderer
prerequisite — this PR) and slice 2 (whole-file context, the actual
P4-B8 deliverable). The slice 2 brainstorm hasn't started yet."
```

---

## Task 10: Pre-push checklist

**Spec:** § 12 AC #12

**Files:** None modified — verification only.

- [ ] **Step 1: Run frontend lint (eslint + prettier --check)**

Run: `cd frontend && npm run lint`
Expected: clean exit (0). If prettier complains about unformatted new files: `cd frontend && npx prettier --write src/components/PrDetail/FilesTab/DiffPane/DiffPane.tsx src/components/PrDetail/FilesTab/FilesTab.tsx` then stage + commit the format fix (memory `feedback_prettier_check_in_ci`).

- [ ] **Step 2: Run frontend build**

Run: `cd frontend && npm run build`
Expected: clean exit (0). Pre-existing chunk-size warning acceptable (not a regression).

- [ ] **Step 3: Run frontend unit tests (vitest)**

Run: `cd frontend && npm test`
Expected: all tests pass. New tests added in this slice: 11 new DiffPane.test.tsx cases (Tasks 1+2+3+4+5) + 3 new FilesTab.test.tsx cases (Task 6) = 14 new vitest cases.

- [ ] **Step 4: Run backend build + tests**

Run: `cd .. && dotnet build --configuration Release && dotnet test --no-build --configuration Release`
Expected: clean build, all tests pass. No backend changes; regression guard only.

- [ ] **Step 5: Run Playwright e2e (prod project)**

Run: `cd frontend && npx playwright test --project=prod`
Expected: all prod-project tests pass, including the two new tests from Task 7 and the recaptured baseline from Task 8.

If any step fails: do NOT push. Fix the underlying issue (re-run the affected earlier task as needed), then retry from step 1.

If all green, no commit needed — this task is verification only. Proceed to invoke `pr-autopilot` per memory `feedback_use_pr_autopilot`.

---

## Spec coverage summary

Every spec § 4-12 requirement maps to a task above. The mapping is annotated per-task via the **Spec:** lines. The two spec items NOT mapped to code tasks are intentional:

- **§ 7.1 Default rationale** — written-out decision in the spec; no code to ship.
- **§ 12 AC #13 (usability gate: lead engineer uses split for 3 consecutive PRs without revert)** — owner discipline post-merge, not implementable in this PR.

The spec test cases enumerated in § 9.1 are covered as follows:

| Spec § 9.1 case | Task |
|---|---|
| #1 Split paired modification 4 cells + 2 overlays | Task 3 |
| #2 Split solo delete (right cells aria-hidden) | Task 3 |
| #3 Split solo insert (left cells aria-hidden + affordance) | Task 3 |
| #4 Split context both gutters + same content | Task 2 |
| #5 Split hunk-header colSpan=4 | Task 2 |
| #6 Comment affordance presence/absence per kind | Tasks 2 + 3 |
| #7 Comment affordance anchor lineNumber | Task 3 (click behavioral assertion) |
| #8 Existing comment widget colSpan=4 + anchored to right-side | Task 4 |
| #9 AI annotation row colSpan=4 | Task 2 (regression guard) |
