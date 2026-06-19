import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileTree } from './FileTree';
import type { FileChange, FileFocus, FileFocusStatus } from '../../../api/types';

function file(path: string, overrides: Partial<FileChange> = {}): FileChange {
  return { path, status: 'modified', hunks: [], ...overrides };
}

describe('FileTree', () => {
  it('renders file nodes from FileChange array', () => {
    render(
      <FileTree
        files={[file('README.md'), file('src/main.ts')]}
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
        files={[file('src/components/Header/Header.tsx')]}
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
        files={[file('a.ts'), file('b.ts')]}
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
        files={[file('a.ts')]}
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
        files={[file('a.ts')]}
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
        files={[file('src/index.ts'), file('lib/index.ts')]}
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
        files={[file('seen.ts', { status: 'modified' })]}
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
    render(
      <FileTree
        files={[file('src/a.ts'), file('src/b.ts')]}
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
    const toggle = screen.getByRole('button', { name: /toggle src/i });
    fireEvent.click(toggle);
    expect(screen.queryByText('a.ts')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText('a.ts')).toBeInTheDocument();
  });

  it('shows viewed count in header', () => {
    render(
      <FileTree
        files={[file('a.ts'), file('b.ts'), file('c.ts')]}
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
        files={[file('new.ts', { status: 'added' })]}
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
        files={[]}
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
        files={[file('src/a.ts')]}
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
        files={[file('src/a.ts')]}
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
    render(
      <FileTree
        files={[file('src/a.ts')]}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        focusStatus="no-changes"
        aiPreview={false}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Toggle src' });
    const folder = toggle.querySelector('.file-tree-folder-icon');
    expect(folder).toBeInTheDocument();
    expect(folder?.tagName.toLowerCase()).toBe('svg');
    expect(folder).toHaveAttribute('aria-hidden', 'true');
  });

  it('marks a deleted file name with the deleted class; non-deleted files do not', () => {
    render(
      <FileTree
        files={[file('gone.ts', { status: 'deleted' }), file('keep.ts', { status: 'modified' })]}
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
        files={[file('src/really-long-file-name-that-would-overflow.ts')]}
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
          files={[file('x.ts', { status })]}
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
        files={[file('src/a-really-long-file-name.ts')]}
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
        files={[file('a-really-long-file-name.ts')]}
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
        files={[file('src/a.ts'), file('src/b.ts')]}
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
        files={files}
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
        files={files}
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
        files={files}
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
        files={files}
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
        files={files}
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
        files={[F(longPath)]}
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
        files={[F('a.ts')]}
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
        files={[F('src/a.ts'), F('src/b.ts')]}
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
const fixtureFiles: FileChange[] = [
  { path: 'src/a.ts', status: 'modified', hunks: [] },
];
function renderTree(overrides: { aiPreview: boolean; focusStatus: FileFocusStatus }) {
  return render(
    <FileTree
      files={fixtureFiles}
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
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('working');
  });

  it('keeps a persistent idle marker once focus has run (ok)', () => {
    renderTree({ aiPreview: true, focusStatus: 'ok' });
    expect(screen.getByTestId('file-tree-ai-progress').getAttribute('data-ai-state')).toBe('idle');
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
});
