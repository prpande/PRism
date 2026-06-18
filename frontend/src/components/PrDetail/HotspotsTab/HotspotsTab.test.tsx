import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { HotspotsTab } from './HotspotsTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { FileFocusState } from '../../../hooks/useFileFocusResult';

function renderTab(
  fileFocus: Omit<FileFocusState, 'retry'> & { retry?: () => void },
  requestFileView = vi.fn(),
) {
  const value = {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prDetail: {} as never,
    draftSession: {} as never,
    readOnly: false,
    subscribed: true,
    baseShaChanged: false,
    onSelectSubTab: vi.fn(),
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
  it('groups High then Medium, omits empty group headings, hides low', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'a.cs', level: 'high', rationale: 'core' },
        { path: 'b.cs', level: 'medium', rationale: 'localized' },
        { path: 'c.cs', level: 'low', rationale: 'format' },
      ],
    });
    expect(screen.getByRole('heading', { name: /high/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /medium/i })).toBeInTheDocument();
    expect(screen.getByText('core')).toBeInTheDocument();
    expect(screen.queryByText('c.cs')).not.toBeInTheDocument(); // low hidden
  });

  it('only-high PR shows no Medium heading', () => {
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'x' }] });
    expect(screen.queryByRole('heading', { name: /medium/i })).not.toBeInTheDocument();
  });

  it('defaults to all-collapsed: shows stripped previews, no rendered markdown panel', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: '- **core** logic\n- second' }],
    });
    // collapsed preview = first stripped line
    expect(screen.getByText('core logic')).toBeInTheDocument();
    // the second bullet only exists in the expanded markdown — absent while collapsed
    expect(screen.queryByText('second')).not.toBeInTheDocument();
    // the panel is not rendered at all while collapsed (its aria-controls target is absent)
    const toggle = screen.getByRole('button', { name: /toggle a\.cs/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeNull();
  });

  it('expanding a row renders the rationale as markdown', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: '- first\n- second' }],
    });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs/i });
    fireEvent.click(toggle);
    // Scope the listitem count to the panel: the accordion rows are real <li>s
    // now (no role="presentation"), so a global getAllByRole would also count them.
    const panel = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(panel).not.toBeNull();
    expect(within(panel!).getAllByRole('listitem')).toHaveLength(2);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('is multi-open: two rows can be expanded at once', () => {
    renderTab({
      status: 'ok',
      entries: [
        { path: 'a.cs', level: 'high', rationale: 'ra' },
        { path: 'b.cs', level: 'medium', rationale: 'rb' },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /toggle a\.cs/i }));
    fireEvent.click(screen.getByRole('button', { name: /toggle b\.cs/i }));
    expect(screen.getByRole('button', { name: /toggle a\.cs/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /toggle b\.cs/i })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keyboard Enter on the toggle expands the row (spec: keyboard toggle)', async () => {
    const user = userEvent.setup();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'r' }] });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs/i });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('the open-in-diff control calls requestFileView without toggling the row', () => {
    const req = vi.fn();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'x' }] }, req);
    fireEvent.click(screen.getByRole('button', { name: /open a\.cs in diff/i }));
    expect(req).toHaveBeenCalledWith('a.cs');
    // header toggle stayed collapsed
    expect(screen.getByRole('button', { name: /toggle a\.cs/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('the header toggle is wired to its panel via aria-controls', () => {
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'r' }] });
    const toggle = screen.getByRole('button', { name: /toggle a\.cs/i });
    fireEvent.click(toggle);
    const panelId = toggle.getAttribute('aria-controls');
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).not.toBeNull();
  });

  it('expanded panel renders no live <script> and no javascript: link (XSS)', () => {
    renderTab({
      status: 'ok',
      entries: [
        {
          path: 'a.cs',
          level: 'high',
          rationale: '<script>alert(1)</script>\n\n[click](javascript:alert(1))',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: /toggle a\.cs/i }));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('a[href*="javascript:"]')).toBeNull();
  });

  it('loading shows skeleton', () => {
    renderTab({ status: 'loading', entries: [] });
    expect(screen.getByTestId('hotspots-skeleton')).toBeInTheDocument();
  });

  it('empty (all-low) shows the positive message and NO retry', () => {
    renderTab({ status: 'empty', entries: [] });
    expect(screen.getByText(/nothing needs special attention/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('no-changes shows the distinct empty-diff message', () => {
    renderTab({ status: 'no-changes', entries: [] });
    expect(screen.getByText(/no file changes to review/i)).toBeInTheDocument();
  });

  it('not-subscribed shows its own copy', () => {
    renderTab({ status: 'not-subscribed', entries: [] });
    expect(screen.getByText(/isn’t active for this pr/i)).toBeInTheDocument();
  });

  it('error shows a distinct message + a Retry button that calls retry', () => {
    const retry = vi.fn();
    renderTab({ status: 'error', entries: [], retry });
    expect(screen.getByText(/couldn’t load ai focus/i)).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: /retry/i });
    fireEvent.click(retryBtn);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('fallback shows the single dedicated state, never medium rows, no retry', () => {
    renderTab({
      status: 'fallback',
      entries: [
        { path: 'a.cs', level: 'medium', rationale: 'x' },
        { path: 'b.cs', level: 'medium', rationale: 'y' },
      ],
    });
    expect(screen.getByText(/couldn’t rank this pr automatically/i)).toBeInTheDocument();
    expect(screen.queryByText('a.cs')).not.toBeInTheDocument(); // no rows
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
