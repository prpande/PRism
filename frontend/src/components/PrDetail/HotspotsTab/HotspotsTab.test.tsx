import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

  it('renders rationale as plain text (no HTML injection)', () => {
    renderTab({
      status: 'ok',
      entries: [{ path: 'a.cs', level: 'high', rationale: '<script>alert(1)</script>' }],
    });
    // text node, escaped — the literal string is present, no <script> element created.
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });

  it('clicking a row calls requestFileView with the path', () => {
    const req = vi.fn();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'x' }] }, req);
    fireEvent.click(screen.getByRole('button', { name: /a\.cs/ }));
    expect(req).toHaveBeenCalledWith('a.cs');
  });

  it('row activates on Enter and Space', () => {
    const req = vi.fn();
    renderTab({ status: 'ok', entries: [{ path: 'a.cs', level: 'high', rationale: 'x' }] }, req);
    const row = screen.getByRole('button', { name: /a\.cs/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(req).toHaveBeenCalledTimes(2);
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
