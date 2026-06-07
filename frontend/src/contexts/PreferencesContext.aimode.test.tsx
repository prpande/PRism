import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PreferencesResponse } from '../api/types';

const state = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
const captured = vi.hoisted(() => ({ body: null as Record<string, unknown> | null }));

vi.mock('../api/client', () => {
  const prefs = (): PreferencesResponse => ({
    ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false, aiMode: state.aiMode },
    inbox: { sections: {} } as never,
    github: {} as never,
  });
  return {
    apiClient: {
      get: vi.fn(async () => prefs()),
      post: vi.fn(async (_path: string, body: Record<string, unknown>) => {
        captured.body = body;
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
      <button onClick={() => void set('ui.ai.mode', 'preview').catch(() => {})}>go</button>
    </div>
  );
}

beforeEach(() => {
  state.aiMode = 'off';
  captured.body = null;
});

describe('PreferencesContext ui.ai.mode', () => {
  it('POSTs the literal {"ui.ai.mode":...} key and reflects the new mode', async () => {
    render(<PreferencesProvider><ModeProbe /></PreferencesProvider>);
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('off'));
    await userEvent.click(screen.getByRole('button', { name: 'go' }));
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('preview'));
    expect(captured.body).toEqual({ 'ui.ai.mode': 'preview' });
  });
});
