// #221 / PR3a — AI mode reactivity. Integration test over the REAL
// PreferencesProvider + useCapabilities + useAiGate (only apiClient is mocked),
// so it exercises the actual cross-consumer propagation.
import { render, screen, waitFor, renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import type { AiCapabilities, AiMode, PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiMode: 'off' as AiMode }));
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
    ui: {
      theme: 'dark',
      accent: 'indigo',
      density: 'comfortable',
      contentScale: 'm',
      aiMode: state.aiMode,
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
      summaryMaxChars: 1000,
    },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async (path: string) => {
        calls.get.push(path);
        if (path === '/api/preferences') return prefs();
        if (path === '/api/capabilities') return { ai: caps(state.aiMode === 'preview') };
        throw new Error(`unexpected GET ${path}`);
      }),
      post: vi.fn(async (path: string, body: Record<string, unknown>) => {
        if (path === '/api/preferences') {
          if ('ui.ai.mode' in body) state.aiMode = body['ui.ai.mode'] as AiMode;
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
  return <button onClick={() => void set('ui.ai.mode', 'preview')}>toggle</button>;
}
function Consumer() {
  const on = useAiGate('summary');
  return <span data-testid="consumer">{on ? 'on' : 'off'}</span>;
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <PreferencesProvider>{children}</PreferencesProvider>
);

beforeEach(() => {
  state.aiMode = 'off';
  calls.get.length = 0;
  vi.mocked(apiClient.get).mockClear();
});

describe('PR3a AI mode reactivity', () => {
  it('propagates a mode change to an already-mounted second consumer immediately', async () => {
    render(
      <PreferencesProvider>
        <Toggler />
        <Consumer />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('consumer')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
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

  it('derives AllOn/AllOff/null from the shared aiMode preference', async () => {
    state.aiMode = 'preview';
    const { result } = renderHook(() => useCapabilities(), { wrapper });
    expect(result.current.capabilities).toBeNull(); // before preferences load
    await waitFor(() => expect(result.current.capabilities?.summary).toBe(true));
    expect(result.current.capabilities).toMatchObject({ summary: true, inboxRanking: true });
  });
});
