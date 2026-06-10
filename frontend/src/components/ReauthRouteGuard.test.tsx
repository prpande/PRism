import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { ReauthRouteGuard } from './ReauthRouteGuard';

// vi.hoisted so the hoisted vi.mock factory can read these mutable containers
// without a TDZ error (repo pattern: frontend/__tests__/PrHeader.test.tsx).
const { navigate, state } = vi.hoisted(() => ({
  navigate: vi.fn(),
  state: { path: '/setup' },
}));
vi.mock('react-router-dom', async (orig) => ({
  ...(await orig<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useLocation: () => ({ pathname: state.path }),
}));

function renderAt(path: string, invalid: boolean) {
  state.path = path;
  return render(<ReauthRouteGuard credentialInvalid={invalid} />);
}

describe('ReauthRouteGuard', () => {
  it('holds the user on /setup once entered under an invalid credential', () => {
    navigate.mockClear();
    const { rerender } = renderAt('/setup', true);
    state.path = '/';
    rerender(<ReauthRouteGuard credentialInvalid={true} />);
    expect(navigate).toHaveBeenCalledWith('/setup?replace=1', { replace: true });
  });

  it('does not redirect when credential is valid', () => {
    navigate.mockClear();
    const { rerender } = renderAt('/setup', false);
    state.path = '/';
    rerender(<ReauthRouteGuard credentialInvalid={false} />);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does not trap a user who never entered /setup', () => {
    navigate.mockClear();
    renderAt('/', true);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('releases the user when the credential becomes valid (no bounce)', () => {
    navigate.mockClear();
    const { rerender } = renderAt('/setup', true);
    state.path = '/';
    rerender(<ReauthRouteGuard credentialInvalid={false} />);
    expect(navigate).not.toHaveBeenCalled();
  });
});
