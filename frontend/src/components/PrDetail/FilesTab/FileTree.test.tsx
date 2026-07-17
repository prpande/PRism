import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileTree } from './FileTree';
import { AI_TREE_ANALYZED_LABEL } from '../../Ai/aiStrings';
import { treeProps } from '../../../../__tests__/helpers/fileTree';
import type { FileChange, FileFocus, FileFocusStatus } from '../../../api/types';
import type { CommentIndicatorState, CommentCounts } from './commentIndicatorState';

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, status: 'modified', hunks: [], ...overrides };
}

describe('FileTree', () => {
  it('renders file nodes from FileChange array', () => {
    render(
      <FileTree
        {...treeProps([file('README.md'), file('src/main.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(screen.getByText('main.ts')).toBeInTheDocument();
  });

  it('renders smart-compacted directory labels', () => {
    render(
      <FileTree
        {...treeProps([file('src/components/Header/Header.tsx')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText('src/components/Header')).toBeInTheDocument();
    expect(screen.getByText('Header.tsx')).toBeInTheDocument();
  });

  it('highlights the selected file', () => {
    render(
      <FileTree
        {...treeProps([file('a.ts'), file('b.ts')])}
        selectedPath="a.ts"
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const selected = screen.getByText('a.ts').closest('[data-selected]');
    expect(selected?.getAttribute('data-selected')).toBe('true');
    // selection is exposed to assistive tech on the treeitem, not just via data-*
    expect(selected?.getAttribute('aria-selected')).toBe('true');
  });

  it('calls onSelectFile when a file row is clicked', () => {
    const onSelect = vi.fn();
    render(
      <FileTree
        {...treeProps([file('a.ts')])}
        selectedPath={null}
        onSelectFile={onSelect}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    fireEvent.click(screen.getByText('a.ts'));
    expect(onSelect).toHaveBeenCalledWith('a.ts');
  });

  it('renders viewed checkbox and calls onToggleViewed', () => {
    const onToggle = vi.fn();
    render(
      <FileTree
        {...treeProps([file('a.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set(['a.ts'])}
        onToggleViewed={onToggle}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: /viewed/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('a.ts');
  });

  it('labels each viewed checkbox by full path so same-named files are distinct', () => {
    render(
      <FileTree
        {...treeProps([file('src/index.ts'), file('lib/index.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    // two files share the basename index.ts; the checkbox labels must disambiguate
    // by full path so screen-reader users can tell the two controls apart
    expect(screen.getByRole('checkbox', { name: 'Viewed src/index.ts' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Viewed lib/index.ts' })).toBeInTheDocument();
  });

  it('marks a viewed file row with the gray-out class and never line-through', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('seen.ts', { status: 'modified' })])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set(['seen.ts'])}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    // item 6: viewed = dim only (via the row class, since the checkbox now lives in a
    // separate column so the old :has(checkbox) selector no longer applies); the
    // strikethrough class is reserved for deletion and must NOT appear here.
    const row = container.querySelector('[data-path="seen.ts"]') as HTMLElement;
    expect(row).toHaveClass('file-tree-file--viewed');
    expect(container.querySelector('.file-tree-file-name--deleted')).toBeNull();
  });

  it('collapses and expands directories', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a.ts'), file('src/b.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText('a.ts')).toBeInTheDocument();
    // #200 — the chevron is a pointer-only decoration (aria-hidden, tabIndex -1),
    // so it is unreachable by accessible role; query by class.
    const toggle = container.querySelector('.file-tree-dir-toggle') as HTMLElement;
    fireEvent.click(toggle);
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('shows viewed count in header', () => {
    render(
      <FileTree
        {...treeProps([file('a.ts'), file('b.ts'), file('c.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set(['a.ts'])}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText(/1\/3 viewed/i)).toBeInTheDocument();
  });

  it('renders file status icon for added files', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('new.ts', { status: 'added' })])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const badge = container.querySelector('.file-status') as HTMLElement;
    expect(badge).toHaveTextContent('A');
    expect(badge).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders empty state when files is empty', () => {
    render(
      <FileTree
        {...treeProps([])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText(/no files/i)).toBeInTheDocument();
  });

  it('indents rows at 12px per depth level', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
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

  it('renders the directory chevron as an SVG, not the ▸ glyph', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const chevron = container.querySelector('.file-tree-chevron svg');
    expect(chevron).not.toBeNull();
    expect(chevron).toBeInTheDocument();
    expect(chevron).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).not.toContain('▸');
  });

  it('renders an accent folder icon inside the directory toggle button', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const toggle = container.querySelector('.file-tree-dir-toggle') as HTMLElement;
    const folder = toggle.querySelector('.file-tree-folder-icon');
    expect(folder).toBeInTheDocument();
    expect(folder?.tagName.toLowerCase()).toBe('svg');
    expect(folder).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks a deleted file name with the deleted class; non-deleted files do not', () => {
    render(
      <FileTree
        {...treeProps([
          file('gone.ts', { status: 'deleted' }),
          file('keep.ts', { status: 'modified' }),
        ])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(screen.getByText('gone.ts')).toHaveClass('file-tree-file-name--deleted');
    expect(screen.getByText('keep.ts')).not.toHaveClass('file-tree-file-name--deleted');
  });

  it('adds title tooltips to file and directory name spans', () => {
    render(
      <FileTree
        {...treeProps([file('src/really-long-file-name-that-would-overflow.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const dirName = screen.getByText('src');
    expect(dirName).toHaveAttribute('title', 'src');
    const fileName = screen.getByText('really-long-file-name-that-would-overflow.ts');
    expect(fileName).toHaveAttribute('title', 'really-long-file-name-that-would-overflow.ts');
  });
});

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
          {...treeProps([file('x.ts', { status })])}
          selectedPath={null}
          onSelectFile={vi.fn()}
          viewedPaths={new Set()}
          onToggleViewed={vi.fn()}
          focusEntries={null}
          focusStatus="no-changes"
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
      // NOT after the name like the trailing AI-focus sr-only span (regression guard).
      // The name span is the word's immediate next sibling — reading order
      // (word → name) is preserved.
      const srWord = container.querySelector('.file-status + .sr-only') as HTMLElement | null;
      expect(srWord).toHaveTextContent(word);
      const nameEl = srWord?.nextElementSibling as HTMLElement | null;
      expect(nameEl).toHaveClass('file-tree-file-name');
    },
  );
});

describe('FileTree — whole-tree horizontal scroll + fixed checkbox column (item 7)', () => {
  it('puts the whole tree (names + rows) inside ONE horizontal scroll container', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a-really-long-file-name.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const scroller = container.querySelector('.file-tree-scroll') as HTMLElement;
    expect(scroller).not.toBeNull();
    // both the directory header and the file row (with its name) scroll together
    expect(scroller.querySelector('.file-tree-dir-header')).not.toBeNull();
    const row = scroller.querySelector(
      '[data-path="src/a-really-long-file-name.ts"]',
    ) as HTMLElement;
    expect(row).not.toBeNull();
    expect(row.querySelector('.file-tree-file-name')).toHaveTextContent(
      'a-really-long-file-name.ts',
    );
  });

  it('renders the viewed checkbox in a separate column OUTSIDE the scroll container', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('a-really-long-file-name.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const scroller = container.querySelector('.file-tree-scroll') as HTMLElement;
    const checkCol = container.querySelector('.file-tree-check-col') as HTMLElement;
    expect(checkCol).not.toBeNull();
    const checkbox = container.querySelector('.file-tree-viewed-checkbox') as HTMLElement;
    expect(checkbox).not.toBeNull();
    // the checkbox lives in the fixed column, NOT inside the horizontal scroller, so
    // it cannot move horizontally regardless of how far the tree is scrolled
    expect(checkCol.contains(checkbox)).toBe(true);
    expect(scroller.contains(checkbox)).toBe(false);
  });

  it('aligns the checkbox column to the rows: one checkbox per file, a slot per dir', () => {
    const { container } = render(
      <FileTree
        {...treeProps([file('src/a.ts'), file('src/b.ts')])}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const checkCol = container.querySelector('.file-tree-check-col') as HTMLElement;
    // 'src' dir + a.ts + b.ts = 3 rows ⇒ 3 slots, 2 of which hold a checkbox
    expect(checkCol.children).toHaveLength(3);
    expect(checkCol.querySelectorAll('.file-tree-viewed-checkbox')).toHaveLength(2);
  });
});

const F = (path: string, status: FileChange['status'] = 'modified'): FileChange => ({
  path,
  status,
  hunks: [],
});

describe('FileTree — AI focus dot (D32a)', () => {
  const files = [F('src/Calc.cs'), F('src/Calc.Tests.cs')];

  it('renders no dot when aiPreview is off, but the column slot is collapsed', () => {
    const { container } = render(
      <FileTree
        {...treeProps(files)}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(container.querySelectorAll('.file-tree-ai')).toHaveLength(files.length);
    expect(container.querySelectorAll('[class*="fileTreeAiHigh"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="fileTreeAiMed"]')).toHaveLength(0);
  });

  it('renders the high dot for level high', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'high', rationale: 'core logic' }];
    const { container } = render(
      <FileTree
        {...treeProps(files)}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    const highDots = container.querySelectorAll('[class*="fileTreeAiHigh"]');
    expect(highDots).toHaveLength(1);
    expect(highDots[0]).toHaveAttribute('title', 'AI focus: high');
    // the row also carries a trailing sr-only "AI focus: high" span so the signal
    // reaches assistive tech (the dot itself is aria-hidden via the .file-tree-ai slot)
    const srSpans = Array.from(container.querySelectorAll('.sr-only')).filter((n) =>
      /AI focus: high/.test(n.textContent ?? ''),
    );
    expect(srSpans).toHaveLength(1);
  });

  it('renders the medium dot for level medium', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'medium', rationale: 'tests' }];
    const { container } = render(
      <FileTree
        {...treeProps(files)}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    const medDots = container.querySelectorAll('[class*="fileTreeAiMed"]');
    expect(medDots).toHaveLength(1);
    expect(medDots[0]).toHaveAttribute('title', 'AI focus: medium');
    const srSpans = Array.from(container.querySelectorAll('.sr-only')).filter((n) =>
      /AI focus: medium/.test(n.textContent ?? ''),
    );
    expect(srSpans).toHaveLength(1);
  });

  it('does NOT render a dot for level low (handoff has no .ai-focus-low)', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'low', rationale: 'formatting' }];
    const { container } = render(
      <FileTree
        {...treeProps(files)}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    expect(
      container.querySelectorAll('[class*="fileTreeAiHigh"], [class*="fileTreeAiMed"]'),
    ).toHaveLength(0);
    // low carries no sr-only AI-focus span either (no spoken focus signal for low)
    const srSpans = Array.from(container.querySelectorAll('.sr-only')).filter((n) =>
      /AI focus:/.test(n.textContent ?? ''),
    );
    expect(srSpans).toHaveLength(0);
  });

  it('outer .file-tree-ai slot carries aria-hidden=true so AT ignores the column', () => {
    const { container } = render(
      <FileTree
        {...treeProps(files)}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    container.querySelectorAll('.file-tree-ai').forEach((node) => {
      expect(node).toHaveAttribute('aria-hidden', 'true');
    });
  });
});

describe('FileTree — AI dot fixed column (#492)', () => {
  // A long path so the row would overflow the scroller; the dot must not ride off
  // with it. The path also builds dir rows, exercising the empty dir-slot path.
  const longPath = 'src/components/AVeryLongComponentDirectory/AVeryLongFileName.tsx';

  it('renders the AI dot in .file-tree-ai-col, OUTSIDE the horizontal scroller', () => {
    // Regression for #492: on V2 the dot is the last child of the row inside
    // .file-tree-scroll, so a long filename scrolls it off-screen. It must live in a
    // fixed column outside the scroller, like the viewed checkbox.
    const entries: FileFocus[] = [{ path: longPath, level: 'high', rationale: 'core logic' }];
    const { container } = render(
      <FileTree
        {...treeProps([F(longPath)])}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    const scroller = container.querySelector('.file-tree-scroll') as HTMLElement;
    const aiCol = container.querySelector('.file-tree-ai-col') as HTMLElement;
    expect(aiCol).not.toBeNull();
    const dot = container.querySelector('[class*="fileTreeAiHigh"]') as HTMLElement;
    expect(dot).not.toBeNull();
    // dot is in the fixed AI column, NOT inside the horizontal scroller, so it stays
    // visible regardless of how far a long filename scrolls the tree
    expect(aiCol.contains(dot)).toBe(true);
    expect(scroller.contains(dot)).toBe(false);
  });

  it('places the AI column to the LEFT of the viewed-checkbox column', () => {
    const { container } = render(
      <FileTree
        {...treeProps([F('a.ts')])}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={[{ path: 'a.ts', level: 'high', rationale: 'core' }]}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    const aiCol = container.querySelector('.file-tree-ai-col') as HTMLElement;
    const checkCol = container.querySelector('.file-tree-check-col') as HTMLElement;
    expect(aiCol).not.toBeNull();
    expect(checkCol).not.toBeNull();
    // AI column precedes the checkbox column in document order → it renders to its left
    const order = aiCol.compareDocumentPosition(checkCol);
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('aligns the AI column to the rows: a .file-tree-ai per file, an empty slot per dir', () => {
    const { container } = render(
      <FileTree
        {...treeProps([F('src/a.ts'), F('src/b.ts')])}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={[{ path: 'src/a.ts', level: 'high', rationale: 'core' }]}
        focusStatus="no-changes"
        aiPreview={true}
      />,
    );
    const aiCol = container.querySelector('.file-tree-ai-col') as HTMLElement;
    // 'src' dir + a.ts + b.ts = 3 rows ⇒ 3 slots, one per row
    expect(aiCol.children).toHaveLength(3);
    // exactly one .file-tree-ai per FILE row; the dir slot carries none, so the
    // count===files invariant (and its aria-hidden guard) holds unchanged
    expect(aiCol.querySelectorAll('.file-tree-ai')).toHaveLength(2);
  });
});

// Helper for Task 5 header-marker tests.
const fixtureFiles: FileChange[] = [{ path: 'src/a.ts', status: 'modified', hunks: [] }];
function renderTree(overrides: {
  aiPreview: boolean;
  focusStatus: FileFocusStatus;
  annotationsLoading?: boolean;
}) {
  return render(
    <FileTree
      {...treeProps(fixtureFiles)}
      selectedPath={null}
      onSelectFile={() => {}}
      viewedPaths={new Set()}
      onToggleViewed={() => {}}
      focusEntries={null}
      {...overrides}
    />,
  );
}

describe('FileTree — header AI marker (Task 5 / #508)', () => {
  it('shows a working header marker while focus is loading', () => {
    renderTree({ aiPreview: true, focusStatus: 'loading' });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe(
      'working',
    );
  });

  it('keeps a persistent idle marker once focus has run (ok)', () => {
    renderTree({ aiPreview: true, focusStatus: 'ok' });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
  });

  // #508 (B1): the one header marker spans BOTH AI passes. Focus can resolve while the
  // PR-wide hunk-annotation fetch is still loading — the marker stays "working" then,
  // instead of dropping to idle and leaving no cue for the in-flight annotations.
  it('stays working after focus resolves while annotations are still loading', () => {
    renderTree({ aiPreview: true, focusStatus: 'ok', annotationsLoading: true });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe(
      'working',
    );
  });

  it('keeps a persistent idle marker on empty (AI ran, nothing flagged)', () => {
    renderTree({ aiPreview: true, focusStatus: 'empty' });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
  });

  it('keeps a persistent idle marker on fallback (all-medium run)', () => {
    renderTree({ aiPreview: true, focusStatus: 'fallback' });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
  });

  it('renders no header marker when AI is off (preview false)', () => {
    renderTree({ aiPreview: false, focusStatus: 'no-changes' });
    expect(screen.queryByTestId('file-tree-ai-progress')).not.toBeInTheDocument();
  });

  it('renders no header marker when not subscribed', () => {
    renderTree({ aiPreview: true, focusStatus: 'not-subscribed' });
    expect(screen.queryByTestId('file-tree-ai-progress')).not.toBeInTheDocument();
  });

  it('renders no header marker on error', () => {
    renderTree({ aiPreview: true, focusStatus: 'error' });
    expect(screen.queryByTestId('file-tree-ai-progress')).not.toBeInTheDocument();
  });

  // The idle marker is a decorative glyph with no `title` (working-only) and no per-row
  // focus signal on an empty result, so it carries an sr-only label for assistive tech.
  it('gives the idle marker an sr-only label', () => {
    renderTree({ aiPreview: true, focusStatus: 'empty' });
    const progress = screen.getByTestId('file-tree-ai-progress');
    expect(within(progress).getByText(AI_TREE_ANALYZED_LABEL)).toBeInTheDocument();
  });

  it('omits the analyzed sr-only label while working (the title tooltip covers it)', () => {
    renderTree({ aiPreview: true, focusStatus: 'loading' });
    const progress = screen.getByTestId('file-tree-ai-progress');
    expect(within(progress).queryByText(AI_TREE_ANALYZED_LABEL)).not.toBeInTheDocument();
  });
});

function renderWithComments(
  files: FileChange[],
  commentStateByPath: Map<string, CommentIndicatorState> | null,
  commentCountsByPath: Map<string, CommentCounts> | null = null,
) {
  return render(
    <FileTree
      {...treeProps(files)}
      selectedPath={null}
      onSelectFile={() => {}}
      viewedPaths={new Set()}
      onToggleViewed={() => {}}
      focusEntries={null}
      focusStatus="no-changes"
      aiPreview={false}
      commentStateByPath={commentStateByPath}
      commentCountsByPath={commentCountsByPath}
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
    // #513 — the resolved row (and only it) carries the green success tick
    expect(byPath('b.ts').querySelector('[data-resolved-tick]')).not.toBeNull();
    expect(byPath('a.ts').querySelector('[data-resolved-tick]')).toBeNull();
    // #513 — the unresolved row (and only it) renders the solid/filled bubble
    expect(byPath('a.ts').querySelector('[data-comment-fill]')).not.toBeNull();
    expect(byPath('b.ts').querySelector('[data-comment-fill]')).toBeNull();
  });

  it('puts a thread-count tooltip on the comment slot; none for a threadless file', () => {
    const state = new Map<string, CommentIndicatorState>([
      ['a.ts', 'unresolved'],
      ['b.ts', 'resolved'],
    ]);
    const counts = new Map<string, CommentCounts>([
      ['a.ts', { open: 2, resolved: 1 }],
      ['b.ts', { open: 0, resolved: 3 }],
    ]);
    const { container } = renderWithComments([f('a.ts'), f('b.ts'), f('c.ts')], state, counts);
    const byPath = (p: string) =>
      container.querySelector(`[data-row-path="${p}"][data-comment-state]`)!;
    expect(byPath('a.ts').getAttribute('title')).toBe('2 unresolved · 1 resolved');
    expect(byPath('b.ts').getAttribute('title')).toBe('3 resolved');
    expect(byPath('c.ts').getAttribute('title')).toBeNull(); // no threads → no tooltip
  });

  it('keeps the four columns row-aligned: one comment slot per file, dirs get a bare slot', () => {
    const { container } = renderWithComments([f('dir/a.ts'), f('dir/b.ts')], new Map());
    // 2 file comment slots (data-comment-state) + 1 dir bare slot in the comment column
    const col = container.querySelector('.file-tree-comment-col')!;
    expect(col.querySelectorAll('[data-comment-state]').length).toBe(2); // one per file row
    expect(col.querySelectorAll('[data-row-key]').length).toBe(1); // the parent dir's bare slot
    expect(col.children.length).toBe(3); // dir + 2 files, row-aligned with the other columns
  });

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
});

describe('FileTree full-row highlight (#513)', () => {
  const f = (path: string): FileChange => ({ path, status: 'modified', hunks: [] });

  function renderTree(selectedPath: string | null) {
    return render(
      <FileTree
        {...treeProps([f('a.ts'), f('b.ts')])}
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
    expect(
      slots(container, 'b.ts').some((el) => el.getAttribute('data-row-selected') === 'true'),
    ).toBe(false);
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
      slots(container, 'b.ts').filter((el) => el.getAttribute('data-row-hovered') === 'true')
        .length,
    ).toBe(4);
    fireEvent.mouseLeave(body);
    expect(
      slots(container, 'b.ts').some((el) => el.getAttribute('data-row-hovered') === 'true'),
    ).toBe(false);
  });

  it('selected wins: hovering the selected row keeps selected and adds hover flag without dropping selected', () => {
    const { container } = renderTree('a.ts');
    const nameCell = slots(container, 'a.ts').find(
      (el) => el.getAttribute('data-testid') === 'files-tab-tree-row',
    )!;
    fireEvent.mouseOver(nameCell);
    const sel = slots(container, 'a.ts');
    expect(sel.every((el) => el.getAttribute('data-row-selected') === 'true')).toBe(true);
    // Assert the hover flag also coexists on the row; CSS precedence (selected after
    // hover) relies on both flags being present at once, not just selected surviving.
    expect(sel.every((el) => el.getAttribute('data-row-hovered') === 'true')).toBe(true);
  });

  it('directory rows hover across their empty gutter slots and never enter selected', () => {
    const { container } = render(
      <FileTree
        {...treeProps([f('dir/a.ts')])}
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

// #200 — WAI-ARIA tree keyboard model on the flat row list. Visual row order for KB_FILES:
//   src (dir, d0) → inner (dir, d1) → deep.ts (d2) → top.ts (d1) → a.ts (d0) → z.ts (d0)
describe('FileTree keyboard navigation (#200)', () => {
  const KB_FILES = [
    { path: 'a.ts', status: 'modified' as const, hunks: [] },
    { path: 'src/inner/deep.ts', status: 'modified' as const, hunks: [] },
    { path: 'src/top.ts', status: 'modified' as const, hunks: [] },
    { path: 'z.ts', status: 'modified' as const, hunks: [] },
  ];

  function renderKbTree(
    over: { selectedPath?: string | null; onSelectFile?: (p: string) => void } = {},
  ) {
    return render(
      <FileTree
        {...treeProps(KB_FILES)}
        selectedPath={over.selectedPath ?? null}
        onSelectFile={over.onSelectFile ?? vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
  }

  const row = (name: string) => screen.getByText(name).closest('[role="treeitem"]') as HTMLElement;
  // Native .focus() (what a real click/tab produces) fires focusin synchronously, but
  // the roving-stop setState it triggers flushes on React's schedule; act() forces the
  // re-render browsers guarantee between discrete events, so the next keyDown sees the
  // synced stop.
  const focusEl = (el: HTMLElement) => act(() => el.focus());
  const stops = (container: HTMLElement) =>
    container.querySelectorAll('[role="treeitem"][tabindex="0"]').length;

  it('directory rows carry the roving tabIndex (single tab stop, first row default)', () => {
    const { container } = renderKbTree();
    expect(row('src').getAttribute('tabindex')).toBe('0'); // no selection → first row
    expect(row('inner').getAttribute('tabindex')).toBe('-1');
    expect(row('a.ts').getAttribute('tabindex')).toBe('-1');
    expect(stops(container)).toBe(1);
  });

  it('the selected file is the roving stop when nothing was keyboard-focused yet', () => {
    const { container } = renderKbTree({ selectedPath: 'a.ts' });
    expect(row('a.ts').getAttribute('tabindex')).toBe('0');
    expect(stops(container)).toBe(1);
  });

  it('ArrowDown/ArrowUp traverse dirs and files in visual order without wrapping', () => {
    renderKbTree();
    const order = ['src', 'inner', 'deep.ts', 'top.ts', 'a.ts', 'z.ts'];
    focusEl(row('src'));
    for (const name of order.slice(1)) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
      expect(document.activeElement).toBe(row(name));
    }
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' }); // at the end
    expect(document.activeElement).toBe(row('z.ts')); // no wrap
    for (const name of order.slice(0, -1).reverse()) {
      fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
      expect(document.activeElement).toBe(row(name));
    }
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' }); // at the start
    expect(document.activeElement).toBe(row('src')); // no wrap
  });

  it('ArrowRight expands a collapsed dir, then moves into it; no-op on files', () => {
    renderKbTree();
    focusEl(row('src'));
    fireEvent.keyDown(row('src'), { key: 'ArrowLeft' }); // collapse src
    expect(screen.queryByText('inner')).not.toBeInTheDocument();
    fireEvent.keyDown(row('src'), { key: 'ArrowRight' }); // expand again
    expect(screen.getByText('inner')).toBeInTheDocument();
    expect(document.activeElement).toBe(row('src')); // expand does not move focus
    fireEvent.keyDown(row('src'), { key: 'ArrowRight' }); // already expanded → first child
    expect(document.activeElement).toBe(row('inner'));
    focusEl(row('a.ts'));
    fireEvent.keyDown(row('a.ts'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(row('a.ts')); // no-op on a file
  });

  it('ArrowLeft collapses an expanded dir, else jumps to the parent row', () => {
    renderKbTree();
    focusEl(row('deep.ts'));
    fireEvent.keyDown(row('deep.ts'), { key: 'ArrowLeft' }); // file → parent dir
    expect(document.activeElement).toBe(row('inner'));
    fireEvent.keyDown(row('inner'), { key: 'ArrowLeft' }); // expanded dir → collapse
    expect(screen.queryByText('deep.ts')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(row('inner'));
    fireEvent.keyDown(row('inner'), { key: 'ArrowLeft' }); // collapsed dir → parent
    expect(document.activeElement).toBe(row('src'));
    focusEl(row('a.ts'));
    fireEvent.keyDown(row('a.ts'), { key: 'ArrowLeft' }); // depth-0 file → no-op
    expect(document.activeElement).toBe(row('a.ts'));
  });

  it('Home and End jump to the first and last visible rows', () => {
    renderKbTree();
    focusEl(row('deep.ts'));
    fireEvent.keyDown(row('deep.ts'), { key: 'Home' });
    expect(document.activeElement).toBe(row('src'));
    fireEvent.keyDown(row('src'), { key: 'End' });
    expect(document.activeElement).toBe(row('z.ts'));
  });

  it('Enter and Space activate: file selects, dir toggles; handled keys prevent default', () => {
    const onSelect = vi.fn();
    renderKbTree({ onSelectFile: onSelect });
    focusEl(row('a.ts'));
    expect(fireEvent.keyDown(row('a.ts'), { key: 'Enter' })).toBe(false); // defaultPrevented
    expect(onSelect).toHaveBeenCalledWith('a.ts');
    fireEvent.keyDown(row('a.ts'), { key: ' ' });
    expect(onSelect).toHaveBeenCalledTimes(2);
    focusEl(row('src'));
    fireEvent.keyDown(row('src'), { key: 'Enter' }); // dir → collapse
    expect(screen.queryByText('inner')).not.toBeInTheDocument();
    // unhandled keys pass through (default NOT prevented)
    expect(fireEvent.keyDown(row('src'), { key: 'a' })).toBe(true);
  });

  it('the chevron button is a pointer-only decoration; the dir row announces its name', () => {
    renderKbTree();
    const src = row('src');
    const chevron = src.querySelector('button')!;
    expect(chevron.getAttribute('tabindex')).toBe('-1');
    expect(chevron.getAttribute('aria-hidden')).toBe('true');
    expect(src.getAttribute('aria-label')).toBe('src'); // no "Toggle src src" concatenation
    expect(src.getAttribute('aria-expanded')).toBe('true');
  });

  it('mouse focus syncs the roving stop: arrows continue from the clicked row', () => {
    renderKbTree();
    focusEl(row('a.ts')); // native focus (what a real click produces) → onFocus sync
    fireEvent.keyDown(row('a.ts'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('z.ts'));
    // chevron click focuses the BUTTON; focusin bubbles to the row and syncs the key
    const chevron = row('src').querySelector('button')!;
    focusEl(chevron);
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(row('inner'));
  });

  it('keeps exactly one roving stop after the focused subtree collapses away', () => {
    const { container } = renderKbTree();
    focusEl(row('deep.ts'));
    fireEvent.mouseOver(row('src')); // ensure chevron interactable
    fireEvent.click(row('src').querySelector('button')!); // collapse src by mouse
    expect(screen.queryByText('deep.ts')).not.toBeInTheDocument();
    expect(stops(container)).toBe(1); // fallback keeps a single tab stop
  });

  it('a background rows refresh does not steal focus (no pending key, no focus call)', () => {
    const { rerender } = renderKbTree();
    focusEl(row('src'));
    (document.activeElement as HTMLElement).blur(); // user is elsewhere (body)
    rerender(
      <FileTree
        {...treeProps(KB_FILES.map((f) => ({ ...f })))}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    expect(document.activeElement).toBe(document.body); // refetch never yanks focus
  });
});
