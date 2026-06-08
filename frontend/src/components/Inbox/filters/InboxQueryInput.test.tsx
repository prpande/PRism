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
    // URL-shaped (has scheme + /pull/) so Enter attempts the open; the SERVER
    // authoritatively rejects it as not-a-pr-url.
    await user.type(screen.getByPlaceholderText(placeholder), 'https://github.com/foo/bar/pull/x');
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
