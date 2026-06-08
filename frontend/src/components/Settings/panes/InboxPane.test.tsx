import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SortKey } from '../../../api/types';
import { InboxPane } from './InboxPane';

// Mutable mock state so each test can supply its own `set` + `defaultSort` via
// renderInboxPane(...) while the module-level vi.mock stays a single fixed factory.
const set = vi.fn().mockResolvedValue(undefined);
let defaultSort: SortKey = 'updated';
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
        defaultSort,
      },
      github: {},
    },
    set,
  }),
}));

function renderInboxPane(opts: { set?: typeof set; defaultSort?: SortKey } = {}) {
  if (opts.set) {
    set.mockImplementation(opts.set);
  }
  defaultSort = opts.defaultSort ?? 'updated';
  return render(<InboxPane />);
}

beforeEach(() => {
  set.mockReset();
  set.mockResolvedValue(undefined);
  defaultSort = 'updated';
});

describe('InboxPane', () => {
  it('renders a switch per section reflecting its state', () => {
    renderInboxPane();
    expect(screen.getByRole('switch', { name: 'Review requested' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Needs re-review' })).not.toBeChecked();
  });

  it('writes the dotted-path preference key on toggle', async () => {
    renderInboxPane();
    await userEvent.click(screen.getByRole('switch', { name: 'Needs re-review' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('inbox.sections.awaiting-author', true));
  });

  it('renders five section rows without ci-failing and with the re-review label', () => {
    renderInboxPane();
    expect(screen.getAllByRole('switch')).toHaveLength(5);
    expect(screen.queryByText('CI failing on my PRs')).toBeNull();
    expect(screen.getByText('Needs re-review')).toBeInTheDocument();
  });

  it('renders a default-sort select and persists a change', () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    renderInboxPane({ set: setSpy, defaultSort: 'updated' });
    const select = screen.getByLabelText('Default sort');
    fireEvent.change(select, { target: { value: 'pushed' } });
    expect(setSpy).toHaveBeenCalledWith('inbox.defaultSort', 'pushed');
  });
});
