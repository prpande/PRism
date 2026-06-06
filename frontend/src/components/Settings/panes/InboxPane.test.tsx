import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { InboxPane } from './InboxPane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {},
      inbox: { sections: { 'review-requested': true, 'awaiting-author': false, 'authored-by-me': true, mentioned: true, 'ci-failing': false, 'recently-closed': true } },
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
    expect(screen.getByRole('switch', { name: 'Awaiting author' })).not.toBeChecked();
  });

  it('writes the dotted-path preference key on toggle', async () => {
    render(<InboxPane />);
    await userEvent.click(screen.getByRole('switch', { name: 'Awaiting author' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('inbox.sections.awaiting-author', true));
  });
});
