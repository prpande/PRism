import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
const captured = vi.hoisted(() => ({ body: null as Record<string, unknown> | null }));
const post = vi.hoisted(() => ({ reject: false }));

const showMock = vi.hoisted(() => vi.fn());
vi.mock('../components/Toast', () => ({
  useToast: () => ({ show: showMock, dismiss: vi.fn(), toasts: [] }),
}));

vi.mock('../api/client', () => {
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
      onboardingSeen: false,
    },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async () => prefs()),
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        captured.body = body;
        if (post.reject) throw new Error('boom');
        if ('ui.ai.mode' in body) state.aiMode = body['ui.ai.mode'] as 'off' | 'preview' | 'live';
        return prefs();
      }),
    },
  };
});

import { usePreferences } from '../hooks/usePreferences';
import { PreferencesProvider } from './PreferencesContext';

function ModeProbe() {
  const { preferences, set } = usePreferences();
  return (
    <div>
      <span data-testid="mode">{preferences?.ui.aiMode ?? 'loading'}</span>
      {/* inbox.sections keys are surfaced so the rollback test can detect the
          generic-fallthrough corruption (a spurious `''` section key) that a
          missing `ui.ai.mode` writeKey arm would produce. */}
      <span data-testid="section-keys">
        {preferences ? JSON.stringify(Object.keys(preferences.inbox.sections)) : 'loading'}
      </span>
      <button onClick={() => void set('ui.ai.mode', 'preview').catch(() => {})}>go</button>
    </div>
  );
}

beforeEach(() => {
  state.aiMode = 'off';
  captured.body = null;
  post.reject = false;
  showMock.mockReset();
});

describe('PreferencesContext ui.ai.mode', () => {
  it('POSTs the literal {"ui.ai.mode":...} key and reflects the new mode', async () => {
    render(
      <PreferencesProvider>
        <ModeProbe />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('preview'));
    expect(captured.body).toEqual({ 'ui.ai.mode': 'preview' });
  });

  it('rolls back to the prior mode and fires an error toast when the POST rejects', async () => {
    // Exercises the optimistic-ROLLBACK arm: set() captures priorValue via
    // readKey('ui.ai.mode') (PreferencesContext.tsx:38) and, on POST failure,
    // restores it via writeKey('ui.ai.mode', priorValue) (line 54). Without the
    // dedicated `ui.ai.mode` writeKey case the generic inbox.sections fallthrough
    // would corrupt state and the mode would not revert — this test would catch it.
    post.reject = true;
    render(
      <PreferencesProvider>
        <ModeProbe />
      </PreferencesProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('off'));

    await userEvent.click(screen.getByRole('button', { name: 'go' }));

    // The error toast confirms set() took the catch branch and ran writeKey()
    // for the rollback (not the success branch).
    await waitFor(() =>
      expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' })),
    );
    // The POST body still used the literal key.
    expect(captured.body).toEqual({ 'ui.ai.mode': 'preview' });
    // Mode reverts to its prior value ('off'), not silently left as 'preview'.
    expect(screen.getByTestId('mode')).toHaveTextContent('off');
    // The rollback wrote through the dedicated `ui.ai.mode` writeKey arm — NOT
    // the generic inbox.sections fallthrough, which would slice 'ui.ai.mode'
    // and corrupt state with a spurious `''` section key (plan line 222).
    expect(screen.getByTestId('section-keys')).toHaveTextContent('[]');
  });
});
