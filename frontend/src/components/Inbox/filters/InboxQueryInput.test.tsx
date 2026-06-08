import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { InboxQueryInput } from './InboxQueryInput';
import { OpenTabsProvider, useOpenTabs } from '../../../contexts/OpenTabsContext';

vi.mock('../../../api/inbox', () => ({
  inboxApi: {
    parsePrUrl: vi.fn(),
  },
}));

import { inboxApi } from '../../../api/inbox';

// Controlled wrapper: the real consumer (FilterBar/useInboxFilters) owns the
// query state, so the test mirrors that — InboxQueryInput is a controlled input.
function Harness() {
  const [value, setValue] = useState('');
  return <InboxQueryInput value={value} onChange={setValue} />;
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="path">{loc.pathname}</div>;
}

function TabsProbe() {
  const { openTabs } = useOpenTabs();
  return <div data-testid="tab-count">{openTabs.length}</div>;
}

function renderInput() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <OpenTabsProvider>
        <TabsProbe />
        <LocationProbe />
        <Routes>
          <Route path="/" element={<Harness />} />
          <Route
            path="/pr/:owner/:repo/:number"
            element={<div data-testid="pr-detail">PR detail</div>}
          />
        </Routes>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

const placeholder = /filter inbox, or paste a pr url/i;

describe('InboxQueryInput — open behavior (ported from PasteUrlInput)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates AND adds a tab on Enter when a URL parses successfully', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: true,
      ref: { owner: 'foo', repo: 'bar', number: 42 },
      error: null,
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/foo/bar/pull/42');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByTestId('pr-detail')).toBeInTheDocument();
      expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
      expect(screen.getByTestId('path')).toHaveTextContent('/pr/foo/bar/42');
    });
  });

  it('opens a pasted PR URL without pressing Enter', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: true,
      ref: { owner: 'acme', repo: 'api', number: 7 },
      error: null,
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.click(input);
    await user.paste('https://github.com/acme/api/pull/7');

    await waitFor(() => {
      expect(screen.getByTestId('path')).toHaveTextContent('/pr/acme/api/7');
      expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
    });
  });

  it('shows host-mismatch error inline', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: false,
      ref: null,
      error: 'host-mismatch',
      configuredHost: 'https://github.com',
      urlHost: 'ghe.acme.com',
    });

    renderInput();
    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(placeholder),
      'https://ghe.acme.com/foo/bar/pull/9',
    );
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/configured for https:\/\/github\.com/i);
    });
  });

  it('shows not-a-pr-url error inline', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: false,
      ref: null,
      error: 'not-a-pr-url',
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    // URL-shaped (scheme + owner/repo/pull/{number}) so Enter attempts the open; the
    // SERVER authoritatively rejects it as not-a-pr-url (e.g. wrong host/repo shape).
    await user.type(screen.getByPlaceholderText(placeholder), 'https://github.com/foo/bar/pull/9');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/doesn.t look like a PR link/i);
    });
  });

  it('shows server-unreachable error on network failure', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockRejectedValue(new Error('network'));

    renderInput();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(placeholder), 'https://github.com/foo/bar/pull/1');
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t reach the server/i);
    });
  });

  it('does not flicker the error pill on a host-mismatch paste', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: false,
      ref: null,
      error: 'host-mismatch',
      configuredHost: 'https://github.com',
      urlHost: 'ghe.acme.com',
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.click(input);
    await user.paste('https://ghe.acme.com/foo/bar/pull/9');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/configured for https:\/\/github\.com/i);
    });
  });
});

describe('InboxQueryInput — merged filter/open behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('typing a plain term updates the value and never calls parsePrUrl', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'retry');
    expect(input).toHaveValue('retry');
    // No "↵ Open PR" hint for a plain term.
    expect(screen.queryByText(/open pr/i)).not.toBeInTheDocument();
    // Enter on a plain term is a no-op (already filtering live) — no parse call.
    await user.keyboard('{Enter}');
    expect(inboxApi.parsePrUrl).not.toHaveBeenCalled();
  });

  it('shows the "↵ Open PR" hint only when the value is a PR URL', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'acme/bff');
    expect(screen.queryByText(/open pr/i)).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'https://github.com/foo/bar/pull/42');
    expect(screen.getByText(/open pr/i)).toBeInTheDocument();
  });

  it('double-Enter on a valid URL navigates / adds a tab exactly ONCE', async () => {
    // Resolve slowly enough that the second Enter fires while the first open() is
    // still in flight — the in-flight guard must drop the re-entry.
    let resolveParse!: (v: {
      ok: boolean;
      ref: { owner: string; repo: string; number: number };
      error: null;
      configuredHost: null;
      urlHost: null;
    }) => void;
    vi.mocked(inboxApi.parsePrUrl).mockImplementation(
      () =>
        new Promise((res) => {
          resolveParse = res;
        }),
    );

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/foo/bar/pull/42');
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    // Release the single in-flight parse.
    resolveParse({
      ok: true,
      ref: { owner: 'foo', repo: 'bar', number: 42 },
      error: null,
      configuredHost: null,
      urlHost: null,
    });

    await waitFor(() => {
      expect(screen.getByTestId('pr-detail')).toBeInTheDocument();
    });
    // Exactly one parse, one tab, one navigation — not two.
    expect(inboxApi.parsePrUrl).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('tab-count')).toHaveTextContent('1');
  });

  it('shows a muted "Not a PR link" hint for a non-PR URL', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/o/r/issues/9');
    expect(screen.getByText(/not a pr link/i)).toBeInTheDocument();
    expect(screen.queryByText(/↵ open pr/i)).not.toBeInTheDocument();
  });

  it('shows "↵ Open PR" for a PR URL (not the non-PR hint)', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/o/r/pull/42');
    expect(screen.getByText(/↵ open pr/i)).toBeInTheDocument();
    expect(screen.queryByText(/not a pr link/i)).not.toBeInTheDocument();
  });

  it('associates the error pill with the input via aria-describedby', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: false,
      ref: null,
      error: 'not-a-pr-url',
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/foo/bar/pull/9');
    await user.keyboard('{Enter}');

    const alert = await screen.findByRole('alert');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(alert).toHaveAttribute('id', describedBy);
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it('clears the error when the user edits the input', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: false,
      ref: null,
      error: 'not-a-pr-url',
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'https://github.com/foo/bar/pull/9');
    await user.keyboard('{Enter}');
    await screen.findByRole('alert');

    await user.type(input, 'x');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('Escape clears the input', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'retry');
    expect(input).toHaveValue('retry');
    await user.keyboard('{Escape}');
    expect(input).toHaveValue('');
  });

  it('the ✕ clear button empties the input', async () => {
    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(placeholder);
    await user.type(input, 'retry');
    await user.click(screen.getByRole('button', { name: /clear/i }));
    expect(input).toHaveValue('');
  });
});
