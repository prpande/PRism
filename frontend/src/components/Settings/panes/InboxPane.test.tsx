import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxPane } from './InboxPane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {},
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': false,
          'authored-by-me': true,
          mentioned: true,
          'recently-closed': true,
        },
      },
      github: {},
    },
    set,
  }),
}));
beforeEach(() => set.mockClear());

describe('InboxPane', () => {
  it('renders a switch per section reflecting its state', () => {
    render(<InboxPane />);
    expect(screen.getByRole('switch', { name: 'Review requested' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Needs re-review' })).not.toBeChecked();
  });

  it('writes the dotted-path preference key on toggle', async () => {
    render(<InboxPane />);
    await userEvent.click(screen.getByRole('switch', { name: 'Needs re-review' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('inbox.sections.awaiting-author', true));
  });

  it('renders five section rows without ci-failing and with the re-review label', () => {
    render(<InboxPane />);
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    expect(screen.queryByText('CI failing on my PRs')).toBeNull();
    expect(screen.getByText('Needs re-review')).toBeInTheDocument();
  });
});
