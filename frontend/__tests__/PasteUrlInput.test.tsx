import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PasteUrlInput } from '../src/components/Inbox/PasteUrlInput';

vi.mock('../src/api/inbox', () => ({
  inboxApi: {
    parsePrUrl: vi.fn(),
  },
}));

import { inboxApi } from '../src/api/inbox';

function renderInput() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<PasteUrlInput />} />
        <Route
          path="/pr/:owner/:repo/:number"
          element={<div data-testid="pr-detail">PR detail</div>}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('PasteUrlInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('navigates on Enter when URL parses successfully', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValue({
      ok: true,
      ref: { owner: 'foo', repo: 'bar', number: 42 },
      error: null,
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(/paste a pr url/i);
    await user.type(input, 'https://github.com/foo/bar/pull/42');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByTestId('pr-detail')).toBeInTheDocument());
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
      screen.getByPlaceholderText(/paste a pr url/i),
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
    await user.type(
      screen.getByPlaceholderText(/paste a pr url/i),
      'https://github.com/foo/bar/issues/1',
    );
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/doesn.t look like a PR link/i);
    });
  });

  it('clears error on next input change', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockResolvedValueOnce({
      ok: false,
      ref: null,
      error: 'malformed',
      configuredHost: null,
      urlHost: null,
    });

    renderInput();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText(/paste a pr url/i);
    await user.type(input, 'bad input');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    await user.type(input, 'x'); // any change
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows server-unreachable error on network failure', async () => {
    vi.mocked(inboxApi.parsePrUrl).mockRejectedValue(new Error('network'));

    renderInput();
    const user = userEvent.setup();
    await user.type(
      screen.getByPlaceholderText(/paste a pr url/i),
      'https://github.com/foo/bar/pull/1',
    );
    await user.keyboard('{Enter}');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/couldn.t reach the server/i);
    });
  });
});
