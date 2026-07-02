// #328 — newly-gained dismissal behavior (useDismissableMenu adoption).
// The pre-existing behaviors (Escape-close etc.) stay pinned by
// CommitMultiSelectPicker.test.tsx, which is intentionally unmodified.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('CommitMultiSelectPicker — outside-click dismissal (#328)', () => {
  it('closes the dropdown on a click outside the picker', async () => {
    render(
      <div>
        <CommitMultiSelectPicker
          commits={[commit('a'), commit('b')]}
          selectedShas={null}
          onSelectionChange={vi.fn()}
        />
        <button data-testid="outside">outside</button>
      </div>,
    );
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not close when clicking inside the open listbox', async () => {
    render(
      <CommitMultiSelectPicker
        commits={[commit('a'), commit('b')]}
        selectedShas={null}
        onSelectionChange={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getAllByRole('option')[1]);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });
});
