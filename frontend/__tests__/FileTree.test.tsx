import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FileTree } from '../src/components/PrDetail/FilesTab/FileTree';
import type { FileChange } from '../src/api/types';

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
      />,
    );
    expect(screen.getByText(/1\/3 viewed/i)).toBeInTheDocument();
  });

  it('renders file status icon for added files', () => {
    render(
      <FileTree
        files={[file('new.ts', { status: 'added' })]}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
      />,
    );
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders empty state when files is empty', () => {
    render(
      <FileTree
        files={[]}
        selectedPath={null}
        onSelectFile={vi.fn()}
        viewedPaths={new Set()}
        onToggleViewed={vi.fn()}
      />,
    );
    expect(screen.getByText(/no files/i)).toBeInTheDocument();
  });
});
