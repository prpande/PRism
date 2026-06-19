import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SortKey } from '../../../api/types';
import { InboxPane } from './InboxPane';

// Mutable mock state so each test can supply its own `set` + `defaultSort` via
// renderInboxPane(...) while the module-level vi.mock stays a single fixed factory.
const set = vi.fn().mockResolvedValue(undefined);
let defaultSort: SortKey = 'updated';
let sectionOrder: string = 'authored-by-me,review-requested,awaiting-author,mentioned';
let showActivityRail: boolean = false;
let groupByRepo: boolean = true;
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
        showActivityRail,
        groupByRepo,
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
    showActivityRail?: boolean;
    groupByRepo?: boolean;
  } = {},
) {
  if (opts.set) {
    set.mockImplementation(opts.set as Parameters<typeof set.mockImplementation>[0]);
  }
  defaultSort = opts.defaultSort ?? 'updated';
  sectionOrder = opts.sectionOrder ?? 'authored-by-me,review-requested,awaiting-author,mentioned';
  showActivityRail = opts.showActivityRail ?? false;
  groupByRepo = opts.groupByRepo ?? true;
  return render(<InboxPane />);
}

beforeEach(() => {
  set.mockReset();
  set.mockResolvedValue(undefined);
  defaultSort = 'updated';
  sectionOrder = 'authored-by-me,review-requested,awaiting-author,mentioned';
  showActivityRail = false;
  groupByRepo = true;
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

  it('renders five section rows + activity-rail + group-by-repo toggles (7 switches), without ci-failing and with the re-review label', () => {
    renderInboxPane();
    // 5 section toggles + "Show activity rail" (#137) + "Group by repository" (#219).
    expect(screen.getAllByRole('switch')).toHaveLength(7);
    expect(screen.queryByText('CI failing on my PRs')).toBeNull();
    expect(screen.getByText('Needs re-review')).toBeInTheDocument();
  });

  it('renders a default-sort select and persists a change', async () => {
    renderInboxPane({ defaultSort: 'updated' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Default sort' }));
    await userEvent.click(screen.getByRole('option', { name: 'Recently pushed' }));
    expect(set).toHaveBeenCalledWith('inbox.defaultSort', 'pushed');
  });

  it('Show activity rail toggle reflects and writes inbox.showActivityRail', async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    renderInboxPane({ showActivityRail: false, set: setSpy });

    const toggle = screen.getByRole('switch', { name: /show activity rail/i });
    expect(toggle).not.toBeChecked();

    await userEvent.click(toggle);
    expect(setSpy).toHaveBeenCalledWith('inbox.showActivityRail', true);
  });

  it('trailing toggles render visible text labels, not just aria-labels (#219)', () => {
    renderInboxPane();
    // The 5 section rows have visible labels; the activity-rail + group-by-repo
    // rows must too (owner B1 decision). aria-label alone is not rendered text,
    // so getByText only finds them once a visible <label> exists.
    expect(screen.getByText('Show activity rail')).toBeInTheDocument();
    expect(screen.getByText('Group by repository')).toBeInTheDocument();
  });

  it('Group by repository toggle reflects and writes inbox.groupByRepo (#219)', async () => {
    const setSpy = vi.fn().mockResolvedValue(undefined);
    renderInboxPane({ groupByRepo: true, set: setSpy });

    const toggle = screen.getByRole('switch', { name: /group by repository/i });
    expect(toggle).toBeChecked();

    await userEvent.click(toggle);
    expect(setSpy).toHaveBeenCalledWith('inbox.groupByRepo', false);
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
    expect(screen.getByRole('button', { name: 'Move Authored by me up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Mentioned down' })).toBeDisabled();
  });

  it('writes the swapped permutation on Move down', async () => {
    renderInboxPane();
    // Default order is authored-by-me, review-requested, awaiting-author, mentioned;
    // moving review-requested (row 2) down swaps it with awaiting-author (row 3).
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(set).toHaveBeenCalledWith(
        'inbox.sectionOrder',
        'authored-by-me,awaiting-author,review-requested,mentioned',
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
    // A non-boundary button that is otherwise enabled, so its disabled state proves
    // the in-flight guard fired (not a first/last-row boundary disable).
    const other = screen.getByRole('button', { name: 'Move Mentioned up' });
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
      expect(screen.getByRole('button', { name: 'Move Mentioned up' })).toBeEnabled(),
    );
    // A failed (rolled-back) move must NOT announce a position change to AT users.
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('announces the move via a polite live region for screen readers', async () => {
    renderInboxPane();
    await userEvent.click(screen.getByRole('button', { name: 'Move Review requested down' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        'Review requested moved to position 3 of 4',
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
        'authored-by-me,review-requested,awaiting-author,mentioned',
      ),
    );
  });
});
