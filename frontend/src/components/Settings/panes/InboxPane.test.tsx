import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SortKey } from '../../../api/types';
import { InboxPane } from './InboxPane';

// Mutable mock state so each test can supply its own `set` + `defaultSort` via
// renderInboxPane(...) while the module-level vi.mock stays a single fixed factory.
const set = vi.fn().mockResolvedValue(undefined);
let defaultSort: SortKey = 'updated';
let sectionOrder: string = 'review-requested,awaiting-author,authored-by-me,mentioned';
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
        sectionOrder,
      },
      github: {},
    },
    set,
  }),
}));

function renderInboxPane(
  opts: {
    set?: (...args: unknown[]) => unknown;
    defaultSort?: SortKey;
    sectionOrder?: string;
  } = {},
) {
  if (opts.set) {
    set.mockImplementation(opts.set as Parameters<typeof set.mockImplementation>[0]);
  }
  defaultSort = opts.defaultSort ?? 'updated';
  sectionOrder = opts.sectionOrder ?? 'review-requested,awaiting-author,authored-by-me,mentioned';
  return render(<InboxPane />);
}

beforeEach(() => {
  set.mockReset();
  set.mockResolvedValue(undefined);
  defaultSort = 'updated';
  sectionOrder = 'review-requested,awaiting-author,authored-by-me,mentioned';
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
    renderInboxPane({ defaultSort: 'updated' });
    const select = screen.getByLabelText('Default sort');
    fireEvent.change(select, { target: { value: 'pushed' } });
    expect(set).toHaveBeenCalledWith('inbox.defaultSort', 'pushed');
  });
});

describe('InboxPane reorder', () => {
  it('renders move buttons for the four work sections and none for recently-closed', () => {
    renderInboxPane();
    expect(screen.getByRole('button', { name: 'Move Review requested up' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move Mentioned down' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move Recently closed/ })).toBeNull();
  });

  it('disables up on the first row and down on the last work row', () => {
    renderInboxPane();
    expect(screen.getByRole('button', { name: 'Move Review requested up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Mentioned down' })).toBeDisabled();
  });

  it('writes the swapped permutation on Move down', async () => {
    renderInboxPane();
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        'inbox.sectionOrder',
        'awaiting-author,review-requested,authored-by-me,mentioned',
      ),
    );
  });

  it('disables reorder controls while a move POST is in flight (no lost second click)', async () => {
    let resolve!: (v: unknown) => void;
    renderInboxPane({
      set: () =>
        new Promise((r) => {
          resolve = r;
        }),
    });
    const down = screen.getByRole('button', { name: 'Move Review requested down' });
    await userEvent.click(down);
    const other = screen.getByRole('button', { name: 'Move Authored by me up' });
    expect(other).toBeDisabled();
    // Settle the POST and confirm controls recover (also flushes the state update
    // inside act so no dangling-update warning leaks).
    resolve(undefined);
    await waitFor(() => expect(other).toBeEnabled());
  });

  it('re-enables reorder controls after a FAILED move POST (no permanent lock)', async () => {
    // If the POST rejects, the in-flight guard must still release via .finally —
    // otherwise a single failed move would lock the reorder UI forever.
    renderInboxPane({ set: () => Promise.reject(new Error('boom')) });
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Authored by me up' })).toBeEnabled(),
    );
  });

  it('announces the move via a polite live region for screen readers', async () => {
    renderInboxPane();
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Review requested moved to position 2 of 4',
      ),
    );
  });

  it('disables Restore default order when already at the canonical default', () => {
    renderInboxPane();
    expect(screen.getByRole('button', { name: 'Restore default order' })).toBeDisabled();
  });

  it('enables and uses Restore default order when reordered', async () => {
    renderInboxPane({ sectionOrder: 'mentioned,authored-by-me,review-requested,awaiting-author' });
    const restore = screen.getByRole('button', { name: 'Restore default order' });
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        'inbox.sectionOrder',
        'review-requested,awaiting-author,authored-by-me,mentioned',
      ),
    );
  });
});
