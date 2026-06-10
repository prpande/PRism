import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { GitHubAuthBanner } from './GitHubAuthBanner';

const navigate = vi.fn();
let mockPath = '/';
let mockInvalid = true;
let mockHealthy = true;

vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: mockPath }),
}));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    authState: { hasToken: true, host: 'github.com', hostMismatch: null, githubCredentialInvalid: mockInvalid },
    error: null,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../hooks/useStreamHealth', () => ({ useStreamHealth: () => ({ healthy: mockHealthy, retry: vi.fn() }) }));

const reconnectButton = () => screen.queryByRole('button', { name: /reconnect/i });

describe('GitHubAuthBanner', () => {
  beforeEach(() => { navigate.mockClear(); mockPath = '/'; mockInvalid = true; mockHealthy = true; });

  it('shows the visible bar when invalid + authed + healthy + not on /setup', () => {
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss/i })).toBeNull(); // non-dismissible
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect');
  });

  it('hides the visible bar on /setup but the live region still reflects the invalid credential', () => {
    mockPath = '/setup';
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect');
  });

  it('hides the visible bar while the SSE stream is unhealthy', () => {
    mockHealthy = false;
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('GitHub access token invalid — reconnect');
  });

  it('clears the live region and shows no banner when the credential is valid', () => {
    mockInvalid = false;
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    expect(reconnectButton()).toBeNull();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('Reconnect navigates to /setup?replace=1', async () => {
    render(<MemoryRouter><GitHubAuthBanner /></MemoryRouter>);
    await userEvent.click(reconnectButton()!);
    expect(navigate).toHaveBeenCalledWith('/setup?replace=1');
  });
});
