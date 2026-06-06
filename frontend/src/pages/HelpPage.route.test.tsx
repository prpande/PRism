import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

const authState = vi.hoisted(() => ({
  value: { hasToken: false, host: 'https://github.com' } as Record<string, unknown>,
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ authState: authState.value, error: null, refetch: vi.fn() }),
}));
// Neutralize the network-touching providers the App tree mounts, mirroring the
// established pattern in __tests__/app.test.tsx. usePreferences must be mocked
// (not just apiClient) — AppearanceSync reads preferences.ui.theme inside an
// effect, and a bare apiClient.get → {} resolves to a shape with no `ui`,
// crashing in a dangling post-assertion microtask.
vi.mock('../hooks/usePreferences', () => ({
  usePreferences: vi.fn(() => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() })),
}));
vi.mock('../hooks/useEventSource', () => ({
  EventStreamProvider: ({ children }: { children: ReactNode }) => children,
  useEventSource: vi.fn(() => null),
}));
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
