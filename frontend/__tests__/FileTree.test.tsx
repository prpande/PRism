import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileTree } from '../src/components/PrDetail/FilesTab/FileTree';
import type { FileChange, FileFocus } from '../src/api/types';

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
        aiPreview={false}
      />,
    );
    const selected = screen.getByText('a.ts').closest('[data-selected]');
    expect(selected?.getAttribute('data-selected')).toBe('true');
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
        aiPreview={false}
      />,
    );
    const checkbox = screen.getByRole('checkbox', { name: /viewed/i });
    expect(checkbox).toBeChecked();
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('a.ts');
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
        files={[file('src/a.ts')]}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
        focusEntries={null}
        aiPreview={false}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Toggle src' });
    const folder = toggle.querySelector('.file-tree-folder-icon');
    expect(folder).toBeInTheDocument();
    expect(folder?.tagName.toLowerCase()).toBe('svg');
    expect(folder).toHaveAttribute('aria-hidden', 'true');
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
      // NOT after the name like the trailing AI-focus sr-only span (regression guard)
      const srWord = container.querySelector('.file-status + .sr-only') as HTMLElement | null;
      expect(srWord).toHaveTextContent(word);
      expect(srWord?.nextElementSibling).toHaveClass('file-tree-file-name');
    },
  );
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
        aiPreview={false}
      />,
    );
    expect(container.querySelectorAll('.file-tree-ai')).toHaveLength(files.length);
    expect(container.querySelectorAll('[class*="fileTreeAiHigh"]')).toHaveLength(0);
    expect(container.querySelectorAll('[class*="fileTreeAiMed"]')).toHaveLength(0);
  });

  it('renders the high dot for level high', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'high' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    const highDots = container.querySelectorAll('[class*="fileTreeAiHigh"]');
    expect(highDots).toHaveLength(1);
    expect(highDots[0]).toHaveAttribute('title', 'AI focus: high');
  });

  it('renders the medium dot for level medium', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'medium' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    const medDots = container.querySelectorAll('[class*="fileTreeAiMed"]');
    expect(medDots).toHaveLength(1);
    expect(medDots[0]).toHaveAttribute('title', 'AI focus: medium');
  });

  it('does NOT render a dot for level low (handoff has no .ai-focus-low)', () => {
    const entries: FileFocus[] = [{ path: 'src/Calc.cs', level: 'low' }];
    const { container } = render(
      <FileTree
        files={files}
        selectedPath={null}
        onSelectFile={() => {}}
        viewedPaths={new Set()}
        onToggleViewed={() => {}}
        focusEntries={entries}
        aiPreview={true}
      />,
    );
    expect(
      container.querySelectorAll('[class*="fileTreeAiHigh"], [class*="fileTreeAiMed"]'),
    ).toHaveLength(0);
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
        aiPreview={false}
      />,
    );
    container.querySelectorAll('.file-tree-ai').forEach((node) => {
      expect(node).toHaveAttribute('aria-hidden', 'true');
    });
  });
});
