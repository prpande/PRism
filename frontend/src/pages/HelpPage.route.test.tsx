import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const authState = vi.hoisted(() => ({
  value: { hasToken: false, host: 'https://github.com' } as Record<string, unknown>,
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ authState: authState.value, error: null, refetch: vi.fn() }),
}));
// Neutralize network-touching dependencies the App tree mounts.
vi.mock('../api/client', () => ({
  apiClient: { get: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) },
  ApiError: class extends Error {},
}));

import { App } from '../App';

class FakeEventSource {
  close() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage = null;
  onerror = null;
}

function renderAppAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe('/help route', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('renders the Help page for a first-run (no token) user', () => {
    authState.value = { hasToken: false, host: 'https://github.com' };
    renderAppAt('/help');
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });

  it('renders the Help page for an authed user', () => {
    authState.value = { hasToken: true, host: 'https://github.com' };
    renderAppAt('/help');
    expect(screen.getByTestId('help-page')).toBeInTheDocument();
  });
});
