import { renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { describe, it, expect } from 'vitest';
import { useEffectiveLocation, isSettingsPath } from './useEffectiveLocation';

function wrapper(initialEntries: Parameters<typeof MemoryRouter>[0]['initialEntries']) {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={initialEntries}>{children}</MemoryRouter>
  );
}

describe('isSettingsPath', () => {
  it('matches /settings and /settings/*', () => {
    expect(isSettingsPath('/settings')).toBe(true);
    expect(isSettingsPath('/settings/appearance')).toBe(true);
    expect(isSettingsPath('/')).toBe(false);
    expect(isSettingsPath('/pr/o/r/1')).toBe(false);
  });
});

describe('useEffectiveLocation', () => {
  it('returns the live location when not on a settings path', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper(['/pr/o/r/1']),
    });
    expect(result.current.pathname).toBe('/pr/o/r/1');
  });

  it('returns backgroundLocation when present (modal open over a PR)', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper([
        { pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
      ]),
    });
    expect(result.current.pathname).toBe('/pr/o/r/1');
  });

  it('synthesizes the inbox background on a cold settings deep-link', () => {
    const { result } = renderHook(() => useEffectiveLocation(), {
      wrapper: wrapper(['/settings/github-connection']),
    });
    expect(result.current.pathname).toBe('/');
  });
});
