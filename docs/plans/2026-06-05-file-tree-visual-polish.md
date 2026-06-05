# File-tree visual polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the PR-detail Files tree read like an IDE explorer and fix two usability defects (illegible expand/collapse affordance; long directory names spilling past the tree's right edge and forcing a sideways scroll) — larger SVG chevron, accent folder icons, 12px indent, deletion strikethrough, viewed gray-out, directory-name truncation, and a screen-reader label for the status badge.

**Architecture:** Presentation-plus-a11y only. No change to tree-building, selection, keep-alive, or AI-focus logic. All work lives in three files: `FileTree.tsx` (markup + two small constants/maps), `FileTree.module.css` (chevron, folder, deleted, viewed, dir-name truncation), and `FilesTab.module.css` (the grid container that actually causes the checkbox overflow). Tests are unit (vitest DOM-contract) plus a B1 human visual assert for the rendered layout.

**Tech Stack:** React + TypeScript + Vite, CSS Modules, vitest + @testing-library/react (jsdom), Playwright (parity baselines).

**Spec:** `docs/specs/2026-06-05-file-tree-visual-polish-design.md`

**Tier/Risk:** T2, B1 (UI-visual) — a human visual assert in **both themes** is required before merge. Do not self-merge.

**Naming deviation (carried through the whole plan):** the spec sketches some CSS classes with kebab/double-dash literals (e.g. `.fileTreeFileName--deleted`). CSS-module keys are accessed in TS, so this plan uses **camelCase module class names** (`styles.fileTreeFileNameDeleted`, `styles.fileTreeFolderIcon`) paired with a **stable literal class** (`file-tree-file-name--deleted`, `file-tree-folder-icon`) exactly as the existing code already dual-classes every element (`file-tree-file-name ${styles.fileTreeFileName}`). Tests query the stable literal class so they survive CSS-module hashing.

**jsdom limits (why some items are visual-only):** vitest runs in jsdom with `css: true`, so module class names resolve and `getAttribute`/literal-class queries are reliable. But jsdom has **no layout engine** and **no `:has()` selector support**. Therefore: truncation/overflow (item 7 layout) and the `:has()`-driven viewed styling (item 6) cannot be asserted by computed style in vitest — they are covered by the **DOM contract** (class/attr presence) in vitest and proven by the **B1 visual assert**. This is a deliberate, spec-acknowledged split, not a coverage gap.

---

## File Structure

| File | Responsibility | Tasks |
|------|----------------|-------|
| `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` | Markup: SVG chevron, folder icon, deleted-name class, `STATUS_WORD` SR label + `aria-hidden` letter, `INDENT_PER_LEVEL`, `title` attrs | 1,2,3,4,5,7 |
| `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` | `.fileTreeChevron` (SVG box), `.fileTreeFolderIcon`, `.fileTreeDirHeader` hover+gap, `.fileTreeFileNameDeleted`, viewed `:has()` rule (drop strike), `.fileTreeDirName` truncation, `.fileTree` min-width/max-width | 2,3,5,6,7 |
| `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` | `.filesTabTree` grid item `min-width:0` (the load-bearing overflow fix) | 7 |
| `frontend/__tests__/FileTree.test.tsx` | New unit tests (append to existing file) | 1,2,3,4,5,7 |
| `frontend/e2e/__screenshots__/{linux,win32}/` | Parity baselines that will shift; refreshed in-PR | 9 |

**Task order rationale:** Task 1 (indentation) is isolated and lowest-risk. Tasks 2–5 add markup + classes each with a vitest contract. Task 6 is a CSS-only removal (visual-verified). Task 7 is the cross-file overflow fix. Task 8 runs the full gate. Task 9 is the B1 visual proof + baseline refresh.

---

## Pre-flight

- [ ] **Confirm the worktree and branch.** This work is on `fix/187-filetree-chevron-size` in worktree `D:/src/PRism-187-chevron`. The spec is already committed here. Do NOT create a new branch.

```bash
cd D:/src/PRism-187-chevron && git status -sb
```

Expected: on `fix/187-filetree-chevron-size`, clean except untracked tooling dirs.

---

### Task 1: Indentation — 12px per level, shared constant

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (add constant near `STATUS_LABELS`; use at `:182` and `:245`)
- Test: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 1: Write the failing test** (append inside the first `describe('FileTree', ...)` block)

```tsx
it('indents rows at 12px per depth level', () => {
  const { container } = render(
    <FileTree
      files={[file('src/a.ts')]}
      selectedPath={null}
      onSelectFile={vi.fn()}
      viewedPaths={new Set()}
      onToggleViewed={vi.fn()}
      focusEntries={null}
      aiPreview={false}
    />,
  );
  // 'src' is a directory at depth 0 → paddingLeft 0
  const dirHeader = screen.getByText('src').closest('.file-tree-dir-header') as HTMLElement;
  expect(dirHeader.style.paddingLeft).toBe('0px');
  // 'a.ts' is a file at depth 1 → (1 + 1) * 12 = 24px (would be 32px at the old 16 unit)
  const fileRow = container.querySelector('[data-path="src/a.ts"]') as HTMLElement;
  expect(fileRow.style.paddingLeft).toBe('24px');
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "indents rows at 12px"
```

Expected: FAIL — `a.ts` row paddingLeft is `32px` (old `(depth+1)*16`).

- [ ] **Step 3: Add the shared constant.** In `FileTree.tsx`, immediately after the `STATUS_LABELS` map (around line 22), add:

```tsx
const INDENT_PER_LEVEL = 12;
```

- [ ] **Step 4: Use it at both indentation sites.** Replace the file row style at `FileTree.tsx:182`:

```tsx
style={{ paddingLeft: `${(depth + 1) * INDENT_PER_LEVEL}px` }}
```

Replace the directory header style at `FileTree.tsx:245`:

```tsx
style={{ paddingLeft: `${depth * INDENT_PER_LEVEL}px` }}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "indents rows at 12px"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/__tests__/FileTree.test.tsx && git commit -m "feat(#187): 12px tree indentation via shared INDENT_PER_LEVEL"
```

---

### Task 2: Chevron — larger SVG, higher contrast

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (`:252-256`, the chevron span body)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (`.fileTreeChevron`)
- Test: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 1: Write the failing test** (append inside the first `describe('FileTree', ...)` block)

```tsx
it('renders the directory chevron as an SVG, not the ▸ glyph', () => {
  const { container } = render(
    <FileTree
      files={[file('src/a.ts')]}
      selectedPath={null}
      onSelectFile={vi.fn()}
      viewedPaths={new Set()}
      onToggleViewed={vi.fn()}
      focusEntries={null}
      aiPreview={false}
    />,
  );
  const chevron = container.querySelector('.file-tree-chevron svg');
  expect(chevron).toBeInTheDocument();
  expect(chevron).toHaveAttribute('aria-hidden', 'true');
  expect(container.textContent).not.toContain('▸');
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders the directory chevron as an SVG"
```

Expected: FAIL — no `svg` under `.file-tree-chevron`; `▸` still present.

- [ ] **Step 3: Replace the glyph with an inline SVG.** In `FileTree.tsx`, replace the chevron span's body (`:252-256`) — keep the `<span className=...file-tree-chevron...>` wrapper and its open-state class exactly as-is; only swap the `▸` text node for the SVG:

```tsx
          <span
            className={`file-tree-chevron${expanded ? ' file-tree-chevron--open' : ''} ${styles.fileTreeChevron}${expanded ? ` ${styles.fileTreeChevronOpen}` : ''}`}
          >
            <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M6 4l4 4-4 4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
```

- [ ] **Step 4: Update `.fileTreeChevron` CSS.** In `FileTree.module.css`, replace the `.fileTreeChevron` rule (`:166-172`). Drop the glyph-era `width: 1em` / `text-align: center`; make it a flex-none 15px box at higher contrast. Keep the rotate rule (`.fileTreeChevronOpen`) untouched:

```css
.fileTreeChevron {
  display: inline-flex;
  align-items: center;
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--text-2);
  transition: transform var(--t-fast);
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders the directory chevron as an SVG"
```

Expected: PASS.

- [ ] **Step 6: Run the existing collapse/expand test to confirm no regression**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "collapses and expands directories"
```

Expected: PASS (toggle still found by `aria-label`, rotation class unchanged).

- [ ] **Step 7: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/__tests__/FileTree.test.tsx && git commit -m "feat(#187): replace ▸ chevron with 15px SVG at --text-2"
```

---

### Task 3: Folder icon (accent) + directory-row hover/gap

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (add folder SVG as last child of the toggle button, after the chevron span — `:257`)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (`.fileTreeFolderIcon` new; `.fileTreeDirHeader` add `gap` + `:hover`)
- Test: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('renders an accent folder icon inside the directory toggle button', () => {
  const { container } = render(
    <FileTree
      files={[file('src/a.ts')]}
      selectedPath={null}
      onSelectFile={vi.fn()}
      viewedPaths={new Set()}
      onToggleViewed={vi.fn()}
      focusEntries={null}
      aiPreview={false}
    />,
  );
  const toggle = screen.getByRole('button', { name: /toggle src/i });
  const folder = toggle.querySelector('.file-tree-folder-icon');
  expect(folder).toBeInTheDocument();
  expect(folder?.tagName.toLowerCase()).toBe('svg');
  expect(folder).toHaveAttribute('aria-hidden', 'true');
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders an accent folder icon"
```

Expected: FAIL — no `.file-tree-folder-icon`.

- [ ] **Step 3: Add the folder SVG as the last child of the toggle button.** In `FileTree.tsx`, inside the `<button className=...file-tree-dir-toggle...>` (`:247-257`), add the folder SVG immediately **after** the closing `</span>` of the chevron and **before** the button's closing `</button>`:

```tsx
          <svg
            viewBox="0 0 16 16"
            width="16"
            height="16"
            aria-hidden="true"
            className={`file-tree-folder-icon ${styles.fileTreeFolderIcon}`}
          >
            <path
              d="M1.5 4.5a1 1 0 0 1 1-1H6l1.5 1.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"
              fill="currentColor"
            />
          </svg>
```

The directory name span (`:258`) stays a sibling **outside** the button — do not move it.

- [ ] **Step 4: Add the CSS.** In `FileTree.module.css`, add a new `.fileTreeFolderIcon` rule (place it after `.fileTreeChevronOpen`):

```css
.fileTreeFolderIcon {
  display: inline-flex;
  flex: none;
  color: var(--accent);
}
```

Then update `.fileTreeDirHeader` (`:150-154`) to add the gap, and add a hover rule mirroring file rows:

```css
.fileTreeDirHeader {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: 6px var(--s-3);
}
.fileTreeDirHeader:hover {
  background: var(--surface-3);
}
```

> **Two intentional gaps, both `var(--s-2)`.** `.fileTreeDirToggle` **already** has `gap: var(--s-2)` (`FileTree.module.css:158-159`) — that spaces the chevron from the folder icon *inside* the button. The new `.fileTreeDirHeader` gap spaces the button (which now ends in the folder icon) from the dir-name span *outside* it. Keep **both**; do not delete the toggle's gap as "redundant" or the chevron and folder icon collide.

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders an accent folder icon"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/__tests__/FileTree.test.tsx && git commit -m "feat(#187): accent folder icon + directory-row hover/gap"
```

---

### Task 4: Status badge — SR-only word, `aria-hidden` letter

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (add `STATUS_WORD` map near `STATUS_LABELS`; mark the `.file-status` span `aria-hidden`; add an `sr-only` word span **before** the name span — `:186-191`)
- Test: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
describe('FileTree — status accessible label (item 8)', () => {
  const cases: Array<[FileChange['status'], string, string]> = [
    ['added', 'A', 'Added'],
    ['modified', 'M', 'Modified'],
    ['deleted', 'D', 'Deleted'],
    ['renamed', 'R', 'Renamed'],
  ];
  it.each(cases)(
    'exposes the SR word for %s and hides the visible letter from AT',
    (status, letter, word) => {
      const { container } = render(
        <FileTree
          files={[file('x.ts', { status })]}
          selectedPath={null}
          onSelectFile={vi.fn()}
          viewedPaths={new Set()}
          onToggleViewed={vi.fn()}
          focusEntries={null}
          aiPreview={false}
        />,
      );
      // SR word is present and readable as a prefix
      expect(screen.getByText(word)).toBeInTheDocument();
      // the visible badge letter is hidden from the accessibility tree (no double-announce)
      const badge = container.querySelector('.file-status') as HTMLElement;
      expect(badge).toHaveTextContent(letter);
      expect(badge).toHaveAttribute('aria-hidden', 'true');
      // the SR word sits BETWEEN the hidden badge and the name → reads as a prefix,
      // NOT after the name like the trailing AI-focus sr-only span (regression guard
      // against placing it in the wrong DOM position)
      const srWord = container.querySelector('.file-status + .sr-only') as HTMLElement | null;
      expect(srWord).toHaveTextContent(word);
      expect(srWord?.nextElementSibling).toHaveClass('file-tree-file-name');
    },
  );
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "exposes the SR word"
```

Expected: FAIL — no SR word in the DOM; `.file-status` has no `aria-hidden`.

- [ ] **Step 3: Add the `STATUS_WORD` map.** In `FileTree.tsx`, after `STATUS_LABELS` (and the new `INDENT_PER_LEVEL`), add:

```tsx
const STATUS_WORD: Record<string, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
};
```

- [ ] **Step 4: Mark the letter `aria-hidden` and add the SR word before the name.** In `FileNodeComponent` (`:186-191`), change the status span to add `aria-hidden="true"`, and insert the SR-only word span immediately **before** the name span:

```tsx
      <span
        className={`file-status file-status--${node.file.status} ${styles.fileStatus} ${FILE_STATUS_MODULE[node.file.status]}`}
        aria-hidden="true"
      >
        {STATUS_LABELS[node.file.status] ?? '?'}
      </span>
      <span className="sr-only">{`${STATUS_WORD[node.file.status] ?? 'Unknown'} `}</span>
      <span className={`file-tree-file-name ${styles.fileTreeFileName}`}>{node.name}</span>
```

(Reading order for assistive tech: `[STATUS_WORD] [filename]` — e.g. "Deleted x.ts". The existing AI-focus `sr-only` span at `FileTree.tsx:205-207` keeps its **trailing** position by design — it follows its own visual column — so on a *focused* row AT reads "Deleted x.ts AI focus: high Viewed x.ts", which is correct. Do **not** move the AI-focus span; only the new status word goes *before* the name.)

- [ ] **Step 5: Run the new test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "exposes the SR word"
```

Expected: PASS (all 4 statuses).

- [ ] **Step 6: Run the existing status test to confirm no regression**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders file status icon for added files"
```

Expected: PASS — `getByText('A')` still uniquely matches the letter span (the SR word for `added` is `"Added"`, a different element).

- [ ] **Step 7: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/__tests__/FileTree.test.tsx && git commit -m "feat(#187): SR-only status word + aria-hidden badge letter"
```

---

### Task 5: Deleted files — strikethrough on the name

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (conditional deleted class on the file-name span — `:191`)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (new `.fileTreeFileNameDeleted`)
- Test: `frontend/__tests__/FileTree.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
it('marks a deleted file name with the deleted class; non-deleted files do not', () => {
  render(
    <FileTree
      files={[file('gone.ts', { status: 'deleted' }), file('keep.ts', { status: 'modified' })]}
      selectedPath={null}
      onSelectFile={vi.fn()}
      viewedPaths={new Set()}
      onToggleViewed={vi.fn()}
      focusEntries={null}
      aiPreview={false}
    />,
  );
  expect(screen.getByText('gone.ts')).toHaveClass('file-tree-file-name--deleted');
  expect(screen.getByText('keep.ts')).not.toHaveClass('file-tree-file-name--deleted');
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "marks a deleted file name"
```

Expected: FAIL — class not applied.

- [ ] **Step 3: Apply the conditional class.** In `FileNodeComponent`, replace the file-name span (now at `:191`, just after the SR word span added in Task 4) with a version that appends the deleted classes when `node.file.status === 'deleted'`:

```tsx
      <span
        className={`file-tree-file-name ${styles.fileTreeFileName}${
          node.file.status === 'deleted'
            ? ` file-tree-file-name--deleted ${styles.fileTreeFileNameDeleted}`
            : ''
        }`}
      >
        {node.name}
      </span>
```

> **Forward reference:** Task 7 Step 3 edits this *same* span again to add `title={node.name}` (the merged final form is shown there). That is additive, not a rollback — this task's commit stands; Task 7 layers the `title` on top. If you implement out of order, use Task 7 Step 3's version as the authoritative final markup for this span.

- [ ] **Step 4: Add the CSS.** In `FileTree.module.css`, after the `.fileTreeFileName` rule (`:123-129`), add:

```css
.fileTreeFileNameDeleted {
  text-decoration: line-through;
  text-decoration-color: var(--danger-fg);
  text-decoration-thickness: 1.5px;
  color: var(--text-2);
}
```

- [ ] **Step 5: Run the test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "marks a deleted file name"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/__tests__/FileTree.test.tsx && git commit -m "feat(#187): strikethrough deleted file names"
```

---

### Task 6: Viewed files — gray out, drop the strikethrough (CSS-only)

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (the viewed `:has()` rule, `:51-56`)

**Verification note:** the viewed treatment is driven by a CSS `:has()` selector with **no JS class on the element**, and jsdom does not support `:has()` in computed style. There is therefore **no DOM contract to unit-test** for this item. It is verified by (a) the existing "renders viewed checkbox and calls onToggleViewed" test still passing (behavior unchanged) and (b) the **B1 visual assert** (Task 9): a viewed file shows dim color + checked box and **no** strikethrough. This is the spec-acknowledged jsdom limit, not a skipped test.

- [ ] **Step 1: Remove the `text-decoration*` declarations.** In `FileTree.module.css`, edit the viewed rule (`:51-56`) to keep only the color dim:

```css
/* Viewed-state — dim only. Strikethrough is reserved for deletion (item 5/6).
   :has() sibling selector (D33). Baseline 2023; current Chrome/Safari/Firefox. */
.fileTreeFile:has(.fileTreeViewedCheckbox:checked) .fileTreeFileName {
  color: var(--text-3);
}
```

- [ ] **Step 2: Run the existing viewed test to confirm behavior is unchanged**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "renders viewed checkbox"
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FileTree.module.css && git commit -m "feat(#187): viewed files gray out, no strikethrough"
```

---

### Task 7: Two-layer scrolling tree + fixed checkbox column

> **⚠️ SUPERSEDED DURING IMPLEMENTATION (2026-06-05, user-directed).** The
> directory-name-truncation plan below was abandoned after live iteration. What
> shipped (and the user approved as "perfect, exactly what I expected") is a
> **two-layer scrolling tree**, implemented directly (not via the truncation steps):
>
> - `FileTree.tsx` rewritten to render a **flat ordered row list** with directory
>   expand/collapse state **lifted** to `FileTree` (keyed by the NUL-joined ancestor
>   chain). The same row list feeds both columns.
> - **Tree column** = one horizontal scroll container `.file-tree-scroll`
>   (`overflow-x: auto; overflow-y: hidden`) with inner `.file-tree-inner`
>   (`width: max-content; min-width: 100%`) → whole tree scrolls as one object, names
>   are reachable by scrolling (NOT truncated), indentation stays aligned.
> - **Checkbox column** = `.file-tree-check-col` rendered OUTSIDE the scroller, one
>   fixed-height slot per row → checkboxes are perfectly static horizontally
>   (verified constant x at scroll 0/mid/max; `position: sticky` was tried and
>   drifts ~13px, so rejected).
> - **No inner vertical scroll, no seam** (user follow-up): vertical scroll falls
>   through to the outer `.files-tab-tree` pane; the two columns are plain
>   content-height siblings (no JS sync, no border) → read as one surface.
> - Fixed `--tree-row-h: 32px` keeps the two columns row-aligned.
> - Verified live (prpande/PRism #192) + unit tests rewritten in
>   `FileTree.test.tsx` (whole-tree-in-one-scroller; checkbox-outside-scroller;
>   one-checkbox-per-file/slot-per-dir). Filed issue #197 for the page-scroll
>   consequence (pre-existing `.sr-only` containment leak).
>
> The steps and code blocks below reflect the abandoned truncation approach and are
> retained for history only.

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.module.css` (`.fileTreeDirName` truncation — **the load-bearing fix**; plus `.fileTree` min-width/max-width + `.fileTreeList` overflow-x — guards)
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.module.css` (`.filesTabTree` — add `min-width: 0`, a guard)
- Modify: `frontend/src/components/PrDetail/FilesTab/FileTree.tsx` (`title` attrs on file-name and dir-name spans)
- Test: `frontend/__tests__/FileTree.test.tsx`

**Empirically validated — the diagnosis was corrected against the running app (BFF PR #191, two viewport widths, tree at its 320px track):**
- **The file-row viewed checkbox is already pinned** — every file-row checkbox renders at the same x inside the tree's right edge (measured `cbRight 294 ≤ edge 320`, zero offenders), and long file names ellipsize. The existing `.fileTreeFileName` ellipsis (present since the original port) already does this. The "checkbox slides off screen" framing was an **assumption that did not reproduce** — so this task does **not** add a checkbox pin.
- **`.filesTabTree` does not overflow** (measured `scrollWidth == clientWidth == 319`), so its `min-width: 0` is a *guard*, not the fix.
- **Directory names are the real defect:** `.fileTreeDirName` has no truncation, so a long path (`ApiClients/Mindbody.Scheduling.ApiClient/Models`) renders to right-edge **344px**, 24px past the 320 edge, giving `.fileTree` 35px of horizontal overflow (`scrollWidth 344` vs `clientWidth 309`) and a sideways scrollbar. **Truncating `.fileTreeDirName` (Step 7) is the load-bearing fix.**

**What vitest can prove here:** only the **DOM contract** — `title` attributes present on both name spans, and the dir-name span carries its module class. The actual rendered behavior (directory name ellipsizes, tree stops scrolling sideways, file-row checkbox stays pinned) is **layout** with no jsdom support → proven by the B1 visual assert (Task 9), which must show a long **directory** name ending in "…" with no sideways scroll, distinguish **ellipsis** from **clip** (hard-cut name, no ellipsis = `overflow:hidden` masking a still-too-wide row), and **confirm the file-row checkbox is still pinned** (a regression guard on already-correct behavior).

**On the guard CSS (`.filesTabTree` / `.fileTree` `min-width:0`).** The spec's Testing section once listed "`.filesTabTree` carries `min-width:0`" as a vitest DOM contract. It is a CSS-module rule on a **non-inline** property; jsdom's `getComputedStyle` does not reliably reflect matched-stylesheet values for it even with `css: true` (it resolves *class names*, not a full cascade), so an assertion would be flaky. These are **robustness guards** (insurance for a very-narrow-tree future), verified by **code review of the CSS diff + B1**, not load-bearing — the load-bearing change is the directory-name truncation. Recorded in the trace table.

**On `.fileTreeSpacer` (the existing right-push span).** `FileNodeComponent` renders `<span className="...fileTreeSpacer" />` (`FileTree.tsx:192`) with `flex: none; margin-left: auto` (`FileTree.module.css:130-133`). Together with the file-name ellipsis it is what already pins the checkbox to the right edge today (measured). It is `flex:none`, consumes no flex space, and does not compete with the name's `flex:1` for shrink room. **Leave it as-is**; do not remove it and do not add a second right-push mechanism. The B1 set (Task 9) must include a *short*-name row (checkbox at edge via the spacer) and a *long deep-nested directory* name on a genuinely narrow track (directory name ellipsizes, no sideways scroll) to confirm both paths.

- [ ] **Step 1: Write the failing test**

```tsx
it('adds title tooltips to file and directory name spans', () => {
  render(
    <FileTree
      files={[file('src/really-long-file-name-that-would-overflow.ts')]}
      selectedPath={null}
      onSelectFile={vi.fn()}
      viewedPaths={new Set()}
      onToggleViewed={vi.fn()}
      focusEntries={null}
      aiPreview={false}
    />,
  );
  const dirName = screen.getByText('src');
  expect(dirName).toHaveAttribute('title', 'src');
  const fileName = screen.getByText('really-long-file-name-that-would-overflow.ts');
  expect(fileName).toHaveAttribute('title', 'really-long-file-name-that-would-overflow.ts');
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "adds title tooltips"
```

Expected: FAIL — no `title` attributes.

- [ ] **Step 3: Add `title` attrs in the markup.** File-name span (`FileNodeComponent`, the span edited in Task 5) — add `title={node.name}`:

```tsx
      <span
        title={node.name}
        className={`file-tree-file-name ${styles.fileTreeFileName}${
          node.file.status === 'deleted'
            ? ` file-tree-file-name--deleted ${styles.fileTreeFileNameDeleted}`
            : ''
        }`}
      >
        {node.name}
      </span>
```

Directory-name span (`DirectoryNodeComponent`, `:258`) — add `title={node.name}`:

```tsx
        <span className={`file-tree-dir-name ${styles.fileTreeDirName}`} title={node.name}>
          {node.name}
        </span>
```

- [ ] **Step 4: Run the test, verify it passes**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx -t "adds title tooltips"
```

Expected: PASS.

- [ ] **Step 5: Add the grid-item guard (robustness, not the fix).** In `FilesTab.module.css`, add `min-width: 0` to `.filesTabTree` (`:29-36`) — insurance for a very-narrow-tree future; `.filesTabTree` does not overflow today (measured). The load-bearing change is the directory-name truncation in Step 7:

```css
.filesTabTree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  background: var(--surface-1);
  border-right: 1px solid var(--border-1);
}
```

- [ ] **Step 6: Relax `.fileTree`'s inline-axis floor.** In `FileTree.module.css`, edit `.fileTree` (`:1-8`) — replace `min-width: 240px; max-width: 360px` with `min-width: 0` (let the grid track's own `minmax(240px, 320px)` own the minimum; drop the inert 360px max that exceeds the 320px track):

```css
.fileTree {
  display: flex;
  flex-direction: column;
  background: var(--surface-1);
  min-width: 0;
  overflow-y: auto;
}
```

- [ ] **Step 7: Truncate directory names (the load-bearing fix) + the belt-and-suspenders overflow guard.** In `FileTree.module.css`, replace `.fileTreeDirName` (`:176-178`) so long folder paths ellipsize like file names — this is the change that actually stops the sideways scroll (measured: `.fileTreeDirName` is the only inline-axis content exceeding the track):

```css
.fileTreeDirName {
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

And add `overflow-x: hidden` to `.fileTreeList` (`:21-24`) as a guard **after** the real fix (it only clips a still-too-wide row; it is not the fix):

```css
.fileTreeList {
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
}
```

- [ ] **Step 8: Re-run the title test + the full FileTree suite to confirm no regression**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run __tests__/FileTree.test.tsx
```

Expected: PASS (all FileTree tests).

- [ ] **Step 9: Commit**

```bash
cd D:/src/PRism-187-chevron && git add frontend/src/components/PrDetail/FilesTab/FilesTab.module.css frontend/src/components/PrDetail/FilesTab/FileTree.module.css frontend/src/components/PrDetail/FilesTab/FileTree.tsx frontend/__tests__/FileTree.test.tsx && git commit -m "fix(#187): truncate long directory names to stop sideways scroll"
```

---

### Task 8: Full gate — suite, prettier, lint, build

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend unit suite**

```bash
cd D:/src/PRism-187-chevron/frontend && npx vitest run
```

Expected: PASS, no new failures vs. the pre-task baseline.

- [ ] **Step 2: Prettier-format the touched files** (prettier `--check` gates CI; format before staging)

```bash
cd D:/src/PRism-187-chevron/frontend && npx prettier --write src/components/PrDetail/FilesTab/FileTree.tsx src/components/PrDetail/FilesTab/FileTree.module.css src/components/PrDetail/FilesTab/FilesTab.module.css __tests__/FileTree.test.tsx
```

- [ ] **Step 3: Lint**

```bash
cd D:/src/PRism-187-chevron/frontend && npm run lint
```

Expected: clean.

- [ ] **Step 4: Build**

```bash
cd D:/src/PRism-187-chevron/frontend && npm run build
```

Expected: succeeds.

- [ ] **Step 5: Commit any prettier changes**

```bash
cd D:/src/PRism-187-chevron && git add -A && git commit -m "style(#187): prettier-format file-tree polish" || echo "nothing to format"
```

---

### Task 9: B1 visual proof + parity-baseline refresh (GATE — no merge)

**Files:**
- Update: `frontend/e2e/__screenshots__/{linux,win32}/...` (parity baselines that shift)

This task produces the human-assert artifact and refreshes the Playwright baselines. **Do not merge after this task** — pause for the user's visual assert (B1).

- [ ] **Step 1: Sync main before any DoD push.** Per standing rule, fetch and merge latest `origin/main` into the branch before pushing/opening the PR:

```bash
cd D:/src/PRism-187-chevron && git fetch origin && git merge origin/main
```

Resolve any conflicts; re-run Task 8's suite + build if main moved.

- [ ] **Step 2: Launch the app in real mode** (per the launch-via-run.ps1 rule — Development + real PAT on `localhost:5180`):

```powershell
cd D:/src/PRism-187-chevron ; ./run.ps1 -Reset None --no-browser
```

- [ ] **Step 3: Open a real PR with a rich changed-file set.** Use the configured real PAT against the BFF repo (`mindbody/Mindbody.BizApp.Bff`, e.g. PR #191) so the tree shows added/modified/deleted files, nested directories, and long names.

- [ ] **Step 4: Capture the required screenshot set in BOTH themes.** For dark and light, capture the Files tree showing:
  - a folder **expanded** and a folder **collapsed** (chevron rotation + accent folder icon). **Per-theme legibility checkpoint:** confirm the accent folder icon is clearly distinguishable from the `--surface-1` background in *each* theme — not washed out in light (`--accent` is mid-lightness there), not muddy in dark. This is a pass/fail item, not a glance.
  - an **added**, a **modified**, and a **deleted** file (deleted = red `[D]` + strikethrough),
  - a **viewed** file (dim + checked box, **no** strike),
  - a file that is **both deleted and viewed** — confirm it renders dim (`--text-3`) **with** the red strike (the intended "deleted + already looked at" look; spec item 6 documents this cascade outcome and nothing else tests it). If no real row is naturally in this state, **synthesize it**: tick the viewed checkbox on a deleted file (viewed state is user-toggleable), so this row is always capturable regardless of the PR's data.
  - a **short**-name row — confirm the checkbox sits at the right edge via the `.fileTreeSpacer` (the short-name path),
  - a **long file-name** row in both a shallow and a deep-nested position — confirm the name ellipsizes with "…" and the checkbox stays at the right edge (a **regression guard** on already-correct behavior; file rows are *not* what this task fixes — the existing ellipsis already pins them),
  - **(the primary proof) a long deep-nested *directory* name** on a **genuinely narrow track** (drag the splitter / use a narrow window so the path actually exceeds the column) — the directory name ellipsizes with "…" and the tree does **NOT** scroll sideways; the cut must be an ellipsis, **NOT** a hard clip. This is the defect Task 7 actually fixes; a wide default window does not exercise it.

  The loading skeleton state is out of scope (pre-existing, unchanged).

- [ ] **Step 5: Host the PNGs on a throwaway review-assets branch and embed them in the PR** (per the visual-verification convention — `review-assets/pr-<N>`, raw URLs in the PR comment). SendUserFile is not viewable on its own.

- [ ] **Step 6: Refresh the Playwright parity baselines that shifted.** Run the parity spec in update mode and review the diffs (they should reflect exactly the intended chevron/folder/indent/strike/viewed changes — nothing else):

```bash
cd D:/src/PRism-187-chevron/frontend && npx playwright test e2e/parity-baselines.spec.ts --update-snapshots
```

Inspect `git diff --stat frontend/e2e/__screenshots__/` and spot-check a couple of updated PNGs before staging.

Two clarifications:
- **The parity baseline is the deterministic fixture tree, not the real PR.** `parity-baselines.spec.ts:206-212` snapshots `[data-testid="files-tab-tree"]` for fixture `acme/api/123` as `pr-detail-files-tree.png`. That fixture tree is what shifts here — it exercises the chevron/folder/indent/viewed changes but not necessarily a deleted file or a long name. The real-BFF screenshots from Steps 3–5 are the **separate** human-assert artifact that covers the deleted/long-name/both-themes cases; do not conflate the two.
- **`--update-snapshots` regenerates only the host-OS (win32) PNGs.** The `{linux}` baselines under `e2e/__screenshots__/linux/` are refreshed by CI (or accepted from the CI artifact), matching prior PR practice — do not hand-author them on Windows.

- [ ] **Step 7: Commit the refreshed baselines**

```bash
cd D:/src/PRism-187-chevron && git add frontend/e2e/__screenshots__ && git commit -m "test(#187): refresh parity baselines for file-tree polish"
```

- [ ] **Step 8: Hand off to pr-autopilot, then STOP at the B1 gate.** Open/drive the PR with `pr-autopilot`. When the loop reaches green-and-ready, **pause** and present the both-theme screenshots for the user's visual assert. Do **not** self-merge — B1 requires the human visual sign-off.

---

## Self-Review (run by the plan author, completed)

**Spec coverage:**

| Spec item | Task |
|-----------|------|
| 1. Chevron (SVG, --text-2) | 2 |
| 2. Folder icons (accent) + hover + gap + static glyph | 3 |
| 3. File rows unchanged / no icons | (no-op — verified by Task 8 suite) |
| 4. Indentation 12px + shared constant | 1 |
| 5. Deleted strikethrough | 5 |
| 6. Viewed gray-out, drop strike | 6 |
| 7. Directory-name truncation (load-bearing) + title attrs; `.filesTabTree`/`.fileTree` min-width:0 + overflow-x guards | 7 |
| 8. Status SR-only word + aria-hidden letter | 4 |
| Accessibility section | 2 (contrast), 4 (1.4.1 carrier) |
| Testing — vitest contracts | 1,2,3,4,5,7 |
| Testing — viewed (no DOM contract) | 6 (visual) — *spec asked for a class/style contract; jsdom has no `:has()` computed-style, deferred to visual per § jsdom limits* |
| Testing — layout truncation + `.filesTabTree min-width:0` | 7 + 9 (visual) — *spec listed a vitest `min-width:0` contract; that non-inline CSS-module prop isn't reliably reflected by jsdom `getComputedStyle`, so verified by code review + B1 per Task 7* |
| Testing — B1 both-theme visual | 9 |
| Baseline refresh | 9 |

No spec item is unaddressed. Three testing items have no new vitest assertion, each for a stated reason, not hidden: item 3 is an explicit no-op (verified by the suite not regressing); item 6's viewed styling is a `:has()` rule with no jsdom computed-style support (visual); and the spec's `.filesTabTree min-width:0` vitest ask is a non-inline CSS-module property jsdom's `getComputedStyle` won't reliably reflect, so it is verified by code review + B1 (Task 7's note explains the divergence). The reading-order, prefix-position, deleted-class, title-attr, chevron-SVG, folder-icon, and indentation contracts **are** unit-asserted.

**Placeholder scan:** none — every code/CSS step shows the literal content.

**Type/name consistency:** `INDENT_PER_LEVEL` (Task 1) used at both sites; `STATUS_WORD` (Task 4) keyed by the same `FileChangeStatus` union as `STATUS_LABELS`; `styles.fileTreeFolderIcon` / `.file-tree-folder-icon` (Task 3) and `styles.fileTreeFileNameDeleted` / `.file-tree-file-name--deleted` (Task 5) are each referenced consistently in markup, CSS, and tests. The Task-5 file-name span and the Task-7 `title` edit target the **same** span — Task 7 Step 3 shows the merged final form to avoid drift.

---

## Execution Handoff

Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task with a two-stage review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.

Either way: this is **B1** — stop at Task 9's gate for the human visual assert in both themes; do not self-merge.
