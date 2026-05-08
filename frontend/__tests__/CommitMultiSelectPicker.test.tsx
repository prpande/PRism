import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CommitMultiSelectPicker } from '../src/components/PrDetail/FilesTab/CommitMultiSelectPicker';
import type { CommitDto } from '../src/api/types';

function commit(sha: string, message = `Commit ${sha}`): CommitDto {
  return {
    sha,
    message,
    committedDate: '2026-05-01T00:00:00Z',
    additions: 10,
    deletions: 5,
  };
}

describe('CommitMultiSelectPicker', () => {
  it('renders trigger with commit count', () => {
    render(
      <CommitMultiSelectPicker
        commits={[commit('a'), commit('b'), commit('c')]}
        selectedShas={null}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Showing changes from all 3 commits/i)).toBeInTheDocument();
  });

  it('opens dropdown on trigger click', () => {
    render(
      <CommitMultiSelectPicker
        commits={[commit('a'), commit('b')]}
        selectedShas={null}
        onSelectionChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('selecting commits calls onSelectionChange with SHA array', () => {
    const onSelectionChange = vi.fn();
    render(
      <CommitMultiSelectPicker
        commits={[commit('a', 'First'), commit('b', 'Second')]}
        selectedShas={null}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    const options = screen.getAllByRole('option');
    // options[0] is "Show all", options[1..] are commits
    fireEvent.click(options[1]);
    expect(onSelectionChange).toHaveBeenCalledWith([expect.any(String)]);
    expect(onSelectionChange.mock.calls[0][0]).toHaveLength(1);
  });

  it('deselecting all commits reverts to "Show all"', () => {
    const onSelectionChange = vi.fn();
    render(
      <CommitMultiSelectPicker
        commits={[commit('a')]}
        selectedShas={['a']}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    // Click "Show all" option
    const showAll = screen.getByText(/show all/i).closest('[role="option"]')!;
    fireEvent.click(showAll);
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('keyboard: Escape closes dropdown', () => {
    render(
      <CommitMultiSelectPicker
        commits={[commit('a')]}
        selectedShas={null}
        onSelectionChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows "N of M" in trigger when commits are selected', () => {
    render(
      <CommitMultiSelectPicker
        commits={[commit('a'), commit('b'), commit('c')]}
        selectedShas={['a', 'b']}
        onSelectionChange={vi.fn()}
      />,
    );
    expect(screen.getByText(/Showing changes from 2 of 3 commits/i)).toBeInTheDocument();
  });
});
