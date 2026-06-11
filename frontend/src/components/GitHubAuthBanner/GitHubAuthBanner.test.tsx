import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GitHubAuthBanner } from './GitHubAuthBanner';

// vi.hoisted so the hoisted vi.mock factories can read these mutable containers
// without a TDZ error (repo pattern: frontend/__tests__/PrHeader.test.tsx).
const { navigate, state } = vi.hoisted(() => ({
  navigate: vi.fn(),
  state: { path: '/', invalid: true, healthy: true },
}));

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: state.path }),
}));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    authState: {
      hasToken: true,
      host: 'github.com',
      hostMismatch: null,
      githubCredentialInvalid: state.invalid,
    },
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../hooks/useStreamHealth', () => ({
  useStreamHealth: () => ({ healthy: state.healthy, retry: vi.fn() }),
}));

const authButton = () => screen.queryByRole('button', { name: /re-authorize/i });

describe('GitHubAuthBanner', () => {
  beforeEach(() => {
    navigate.mockClear();
    state.path = '/';
    state.invalid = true;
    state.healthy = true;
  });

  it('shows the visible bar when invalid + authed + healthy + not on /setup', () => {
    render(
      <MemoryRouter>
        <GitHubAuthBanner />
      </MemoryRouter>,
    );
    expect(authButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull(); // non-dismissible
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your GitHub access token is no longer valid',
    );
  });

  it('hides the visible bar on /setup but the live region still reflects the invalid credential', () => {
    state.path = '/setup';
    render(
      <MemoryRouter>
        <GitHubAuthBanner />
      </MemoryRouter>,
    );
    expect(authButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your GitHub access token is no longer valid',
    );
  });

  it('hides the visible bar while the SSE stream is unhealthy', () => {
    state.healthy = false;
    render(
      <MemoryRouter>
        <GitHubAuthBanner />
      </MemoryRouter>,
    );
    expect(authButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your GitHub access token is no longer valid',
    );
  });

  it('clears the live region and shows no banner when the credential is valid', () => {
    state.invalid = false;
    render(
      <MemoryRouter>
        <GitHubAuthBanner />
      </MemoryRouter>,
    );
    expect(authButton()).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('Reconnect navigates to /setup?replace=1', async () => {
    render(
      <MemoryRouter>
        <GitHubAuthBanner />
      </MemoryRouter>,
    );
    await userEvent.click(authButton()!);
    expect(navigate).toHaveBeenCalledWith('/setup?replace=1');
  });
});
