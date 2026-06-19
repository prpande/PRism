import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { HotspotsTab } from './HotspotsTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { FileFocusState } from '../../../hooks/useFileFocusResult';

function renderTab(
  fileFocus: Omit<FileFocusState, 'retry'> & { retry?: () => void },
  overrides: { requestFileView?: () => void; onSelectSubTab?: () => void } = {},
) {
  const requestFileView = overrides.requestFileView ?? vi.fn();
  const onSelectSubTab = overrides.onSelectSubTab ?? vi.fn();
  const value = {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prDetail: {} as never,
    draftSession: {} as never,
    readOnly: false,
    subscribed: true,
    baseShaChanged: false,
    onSelectSubTab,
    fileFocus: { retry: vi.fn(), ...fileFocus },
    pendingFilePath: null,
    requestFileView,
    clearPendingFilePath: vi.fn(),
  };
  return render(
    <PrDetailContextProvider value={value as never}>
      <HotspotsTab />
    </PrDetailContextProvider>,
  );
}

describe('HotspotsTab', () => {
  it('lists High then Medium in one container, hides Low rows, shows a Low footer', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'm.cs', level: 'medium', rationale: 'Localized change\n- detail' },
        { path: 'h.cs', level: 'high', rationale: 'Core logic\n- detail' },
        { path: 'c.cs', level: 'low', rationale: 'Formatting only' },
      ],
    });
    // Headlines are the synopsis (first line), not the path.
    expect(screen.getByText('Core logic')).toBeInTheDocument();
    expect(screen.getByText('Localized change')).toBeInTheDocument();
    // High comes before Medium in DOM order.
    const headlines = screen.getAllByText(/Core logic|Localized change/);
    expect(headlines[0]).toHaveTextContent('Core logic');
    // Low file is not a row; the footer summarises it.
    expect(screen.queryByText('Formatting only')).not.toBeInTheDocument();
    expect(screen.getByText(/1 low-priority file/i)).toBeInTheDocument();
  });

  it('sorts rows within a level by path ascending (deterministic order)', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'z.cs', level: 'high', rationale: 'Z synopsis\n- d' },
        { path: 'a.cs', level: 'high', rationale: 'A synopsis\n- d' },
      ],
    });
    const toggles = screen.getAllByRole('button', { name: /Toggle .* rationale/i });
    expect(toggles[0]).toHaveAccessibleName(/Toggle a\.cs rationale/i);
    expect(toggles[1]).toHaveAccessibleName(/Toggle z\.cs rationale/i);
  });

  it('expands to render the rationale body as markdown; synopsis is not duplicated', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: 'Core logic\n- first\n- second' }],
    });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs rationale/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(within(panel!).getAllByRole('listitem')).toHaveLength(2); // - first / - second
    // synopsis headline is NOT repeated inside the panel
    expect(within(panel!).queryByText('Core logic')).toBeNull();
  });

  it('keyboard Enter on the toggle expands the row', async () => {
    const user = userEvent.setup();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'S\n- b' }] });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs rationale/i });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('the Diff pill calls requestFileView without toggling the row', () => {
    const requestFileView = vi.fn();
    renderTab(
      { status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'S\n- b' }] },
      { requestFileView },
    );
    fireEvent.click(screen.getByRole('button', { name: /open a\.cs in diff/i }));
    expect(requestFileView).toHaveBeenCalledWith('a.cs');
    expect(screen.getByRole('button', { name: /toggle a\.cs rationale/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('a synopsis-only row renders no toggle (not expandable) but still has a Diff pill', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: 'Just a synopsis' }],
    });
    expect(
      screen.queryByRole('button', { name: /toggle a\.cs rationale/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('Just a synopsis')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open a\.cs in diff/i })).toBeInTheDocument();
  });

  it('a backfill row uses the path as its headline (path stays primary)', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'src/Backfilled.cs', level: 'medium', rationale: 'Not individually ranked.' },
      ],
    });
    expect(screen.getByText('src/Backfilled.cs')).toBeInTheDocument();
    expect(screen.queryByText('Not individually ranked.')).not.toBeInTheDocument();
    // not expandable
    expect(
      screen.queryByRole('button', { name: /toggle src\/Backfilled\.cs rationale/i }),
    ).not.toBeInTheDocument();
  });

  it('the Low footer excludes low-by-rule files and switches to the Files tab', () => {
    const onSelectSubTab = vi.fn();
    renderTab(
      {
        status: 'ok',
        entries: [
          { path: 'h.cs', level: 'high', rationale: 'Core\n- d' },
          { path: 'r.cs', level: 'low', rationale: 'No changes to review in this file.' }, // low-by-rule
          { path: 'f.cs', level: 'low', rationale: 'Formatting' }, // model-scored low
        ],
      },
      { onSelectSubTab },
    );
    // count = 1 (only the model-scored low; low-by-rule excluded)
    const footer = screen.getByRole('button', { name: /1 low-priority file/i });
    fireEvent.click(footer);
    expect(onSelectSubTab).toHaveBeenCalledWith('files');
  });

  it('expanded panel renders no live <script> and no javascript: link (XSS)', () => {
    renderTab({
      status: 'ok',
      entries: [
        {
          path: 'a.cs',
          level: 'high',
          rationale: 'Synopsis\n<script>alert(1)</script>\n\n[click](javascript:alert(1))',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /toggle a\.cs rationale/i }));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  it('loading shows skeleton', () => {
    renderTab({ status: 'loading', entries: [] });
    expect(screen.getByTestId('hotspots-skeleton')).toBeInTheDocument();
  });

  it('renders skeleton rows shaped like the live hotspot rows while loading', () => {
    renderTab({ status: 'loading', entries: [] });
    const rows = within(screen.getByTestId('hotspots-skeleton')).getAllByTestId(
      'hotspots-skeleton-row',
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(within(rows[0]).getByTestId('hotspots-skeleton-glyph')).toBeInTheDocument();
    expect(within(rows[0]).getByTestId('hotspots-skeleton-headline')).toBeInTheDocument();
    expect(within(rows[0]).getByTestId('hotspots-skeleton-path')).toBeInTheDocument();
  });

  it('exposes a persistent role=status announcer that is NOT inside the aria-busy skeleton', () => {
    renderTab({ status: 'loading', entries: [] });
    expect(screen.getByRole('status')).toHaveTextContent(/analyzing ai hotspots/i);
    // the announcer must be a sibling of, not a descendant of, the aria-busy skeleton
    expect(within(screen.getByTestId('hotspots-skeleton')).queryByRole('status')).toBeNull();
  });

  it('announces the resolved outcome via the same persistent status region', () => {
    renderTab({ status: 'empty', entries: [] });
    expect(screen.getByRole('status')).toHaveTextContent(/no files need special attention/i);
  });

  it('empty (all-low) shows the positive message, no card, no footer, no retry', () => {
    renderTab({ status: 'empty', entries: [] });
    expect(screen.getByText(/nothing needs special attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/low-priority file/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('all entries Low shows the positive message (no rows, no footer)', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'c.cs', level: 'low', rationale: 'Formatting' }],
    });
    expect(screen.getByText(/nothing needs special attention/i)).toBeInTheDocument();
    expect(screen.queryByText(/low-priority file/i)).not.toBeInTheDocument();
  });

  it('no-changes shows the distinct empty-diff message', () => {
    renderTab({ status: 'no-changes', entries: [] });
    expect(screen.getByText(/no file changes to review/i)).toBeInTheDocument();
  });

  it('not-subscribed shows its own copy', () => {
    renderTab({ status: 'not-subscribed', entries: [] });
    expect(screen.getByText(/isn't active for this pr/i)).toBeInTheDocument();
  });

  it('error shows a distinct message + a Retry button that calls retry', () => {
    const retry = vi.fn();
    renderTab({ status: 'error', entries: [], retry });
    expect(screen.getByText(/couldn't load ai focus/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('fallback shows the single dedicated state, never rows, no retry', () => {
    renderTab({
      status: 'fallback',
      entries: [{ path: 'a.cs', level: 'medium', rationale: 'x' }],
    });
    expect(screen.getByText(/couldn't rank this pr automatically/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /toggle a\.cs rationale/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
