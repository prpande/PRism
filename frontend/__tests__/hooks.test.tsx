import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { usePreferences } from '../src/hooks/usePreferences';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { useAuth } from '../src/hooks/useAuth';

const server = setupServer(
  http.get('/api/preferences', () =>
    HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
  ),
  http.get('/api/capabilities', () =>
    HttpResponse.json({
      ai: {
        summary: false,
        fileFocus: false,
        hunkAnnotations: false,
        preSubmitValidators: false,
        composerAssist: false,
        draftSuggestions: false,
        draftReconciliation: false,
        inboxEnrichment: false,
        inboxRanking: false,
      },
    }),
  ),
  http.get('/api/auth/state', () =>
    HttpResponse.json({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('usePreferences', () => {
  it('fetches preferences on mount', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());
    expect(result.current.preferences?.theme).toBe('system');
  });
});

describe('useCapabilities', () => {
  it('fetches capabilities on mount', async () => {
    const { result } = renderHook(() => useCapabilities());
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    expect(result.current.capabilities?.summary).toBe(false);
  });
});

describe('useAuth', () => {
  it('fetches auth state on mount', async () => {
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authState).not.toBeNull());
    expect(result.current.authState?.hasToken).toBe(false);
  });

  it('refetches auth state when window regains focus', async () => {
    let calls = 0;
    server.use(
      http.get('/api/auth/state', () => {
        calls += 1;
        return HttpResponse.json({
          hasToken: calls > 1,
          host: 'https://github.com',
          hostMismatch: null,
        });
      }),
    );
    const { result } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authState).not.toBeNull());
    expect(result.current.authState?.hasToken).toBe(false);
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(result.current.authState?.hasToken).toBe(true));
  });
});
