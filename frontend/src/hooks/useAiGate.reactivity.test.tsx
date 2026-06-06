// #221 — AI preview toggle reactivity. Integration test over the REAL
// PreferencesProvider + useCapabilities + useAiGate (only apiClient is mocked),
// so it exercises the actual cross-consumer propagation the bug broke.
//
// The first test is the regression net: it runs UNCHANGED on main (where
// useCapabilities does its own per-instance /api/capabilities fetch → a second
// consumer stays stale → RED) and on head (where useCapabilities derives from the
// shared preference → GREEN). The remaining tests pin the head behavior.
import { render, screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { AiCapabilities, PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiPreview: false }));
const calls = vi.hoisted(() => ({ get: [] as string[] }));

vi.mock('../api/client', () => {
  const caps = (on: boolean): AiCapabilities => ({
    summary: on,
    fileFocus: on,
    hunkAnnotations: on,
    preSubmitValidators: on,
    composerAssist: on,
    draftSuggestions: on,
    draftReconciliation: on,
    inboxEnrichment: on,
    inboxRanking: on,
  });
  const prefs = (): PreferencesResponse => ({
    ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: state.aiPreview },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async (path: string) => {
        calls.get.push(path);
        if (path === '/api/preferences') return prefs();
        if (path === '/api/capabilities') return { ai: caps(state.aiPreview) };
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === '/api/preferences') {
          if ('aiPreview' in body) state.aiPreview = body.aiPreview as boolean;
          return prefs();
        }
        throw new Error(`unexpected POST ${path}`);
      }),
    },
  };
});

import { apiClient } from '../api/client';
import { usePreferences } from './usePreferences';
import { useCapabilities } from './useCapabilities';
import { useAiGate } from './useAiGate';
import { PreferencesProvider } from '../contexts/PreferencesContext';

function Toggler() {
  const { set } = usePreferences();
  return <button onClick={() => void set('aiPreview', true)}>toggle</button>;
}
function Consumer() {
  const on = useAiGate('summary');
  return <span data-testid="consumer">{on ? 'on' : 'off'}</span>;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <PreferencesProvider>{children}</PreferencesProvider>
);

beforeEach(() => {
  state.aiPreview = false;
  calls.get.length = 0;
  vi.mocked(apiClient.get).mockClear();
});

describe('#221 AI preview toggle reactivity', () => {
  it('propagates an aiPreview toggle to an already-mounted second consumer immediately', async () => {
    render(
      <PreferencesProvider>
        <Toggler />
        <Consumer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('off'));

    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));

    // No focus/remount event — the consumer must reflect the toggle on its own.
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('on'));
  });

  it('does not issue a frontend GET /api/capabilities (capabilities are derived)', async () => {
    render(
      <PreferencesProvider>
        <Toggler />
        <Consumer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('on'));

    expect(calls.get).not.toContain('/api/capabilities');
  });

  it('derives AllOn/AllOff/null from the shared aiPreview preference', async () => {
    state.aiPreview = true;
    const { result } = renderHook(() => useCapabilities(), { wrapper });
    expect(result.current.capabilities).toBeNull(); // before preferences load
    await waitFor(() => expect(result.current.capabilities?.summary).toBe(true));
    expect(result.current.capabilities).toMatchObject({ summary: true, inboxRanking: true });
  });
});
