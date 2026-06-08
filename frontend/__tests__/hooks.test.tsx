import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { usePreferences } from '../src/hooks/usePreferences';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { AuthProvider, useAuth } from '../src/hooks/useAuth';

const showMock = vi.fn();
vi.mock('../src/components/Toast', () => ({
  useToast: () => ({ show: showMock, dismiss: vi.fn(), toasts: [] }),
}));

const server = setupServer(
  http.get('/api/preferences', () =>
    HttpResponse.json({
      ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'ci-failing': true,
        },
      },
      github: {
        host: 'https://github.com',
        configPath: '/fake/config.json',
        logsPath: '/fake/logs',
      },
    }),
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
    expect(result.current.preferences?.ui.theme).toBe('system');
  });

  it('exposes inbox.sections and github.{configPath,logsPath} from the richer GET shape', async () => {
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());
    expect(result.current.preferences!.inbox.sections['review-requested']).toBe(true);
    expect(result.current.preferences!.inbox.sections['ci-failing']).toBe(true);
    expect(result.current.preferences!.github.configPath).toContain('config.json');
    expect(result.current.preferences!.github.logsPath).toContain('logs');
  });

  it('rolls back ONLY the failing key when two rapid POSTs interleave and the second fails', async () => {
    // Regression: pre-fix, set() captured the whole `prior` snapshot at call
    // time. Two near-simultaneous toggles both snapshot the same baseline P0;
    // if A succeeds and B fails, B's rollback to P0 silently undoes A. Fix is
    // key-scoped writeKey() patched against current state via functional set.
    showMock.mockReset();
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());

    // First POST: succeed and flip ci-failing → false.
    server.use(
      http.post('/api/preferences', async () =>
        HttpResponse.json({
          ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
          inbox: {
            sections: {
              'review-requested': true,
              'awaiting-author': true,
              'authored-by-me': true,
              mentioned: true,
              'ci-failing': false,
            },
          },
          github: {
            host: 'https://github.com',
            configPath: '/fake/config.json',
            logsPath: '/fake/logs',
          },
        }),
      ),
    );
    await act(async () => {
      await result.current.set('inbox.sections.ci-failing', false);
    });
    expect(result.current.preferences!.inbox.sections['ci-failing']).toBe(false);

    // Second POST: fail on the mentioned toggle.
    server.use(http.post('/api/preferences', () => HttpResponse.text('boom', { status: 500 })));
    await act(async () => {
      await expect(result.current.set('inbox.sections.mentioned', false)).rejects.toBeDefined();
    });

    // Only `mentioned` reverts; the prior successful `ci-failing` flip survives.
    expect(result.current.preferences!.inbox.sections['mentioned']).toBe(true);
    expect(result.current.preferences!.inbox.sections['ci-failing']).toBe(false);
  });

  it('rolls back preferences and surfaces an error toast when POST /api/preferences rejects', async () => {
    // Server starts as the default (theme=system); flipping the POST to 500
    // should restore that state and fire one error toast — never a half-applied
    // preference. Closes spec § 2.6 "rollback on 4xx/5xx/network failure".
    showMock.mockReset();
    const { result } = renderHook(() => usePreferences());
    await waitFor(() => expect(result.current.preferences).not.toBeNull());
    const before = result.current.preferences;

    server.use(http.post('/api/preferences', () => HttpResponse.text('boom', { status: 500 })));

    await act(async () => {
      await expect(result.current.set('theme', 'dark')).rejects.toBeDefined();
    });

    expect(result.current.preferences).toEqual(before);
    expect(showMock).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });
});

describe('useCapabilities', () => {
  // #221: capabilities are now DERIVED from the shared aiPreview preference, not
  // fetched from /api/capabilities. AllOff when aiPreview is false.
  it('derives AllOff from the shared preference when aiPreview is off', async () => {
    const { result } = renderHook(() => useCapabilities());
    await waitFor(() => expect(result.current.capabilities).not.toBeNull());
    expect(result.current.capabilities?.summary).toBe(false);
  });

  it('derives AllOn when aiPreview is on', async () => {
    server.use(
      http.get('/api/preferences', () =>
        HttpResponse.json({
          ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
          inbox: { sections: {} },
          github: { host: 'https://github.com', configPath: '/c', logsPath: '/l' },
        }),
      ),
    );
    const { result } = renderHook(() => useCapabilities());
    await waitFor(() => expect(result.current.capabilities?.summary).toBe(true));
    expect(result.current.capabilities?.inboxRanking).toBe(true);
  });
});

describe('useAuth', () => {
  it('fetches auth state on mount', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
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
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.authState).not.toBeNull());
    expect(result.current.authState?.hasToken).toBe(false);
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => expect(result.current.authState?.hasToken).toBe(true));
  });

  // S6 PR4 — spec § 3.2.1 identity-change rule. The SSE bridge in api/events.ts
  // dispatches `prism-identity-changed` on every IdentityChanged event the
  // backend publishes; useAuth refetches /api/auth/state to pick up the new
  // login. Tested via the window event directly (no SSE harness required).
  it('refetches auth state when prism-identity-changed fires', async () => {
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
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.authState).not.toBeNull());
    expect(result.current.authState?.hasToken).toBe(false);
    window.dispatchEvent(new CustomEvent('prism-identity-changed'));
    await waitFor(() => expect(result.current.authState?.hasToken).toBe(true));
  });

  // Spec § 3.2.1 reconnect-replay defense. If the SSE stream blipped and missed
  // an identity-change frame, the events.ts reconnect() handler dispatches
  // `prism-events-reconnected`; useAuth refetches so the new login is reflected
  // without waiting for window focus.
  it('refetches auth state when prism-events-reconnected fires', async () => {
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
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await waitFor(() => expect(result.current.authState).not.toBeNull());
    expect(result.current.authState?.hasToken).toBe(false);
    window.dispatchEvent(new CustomEvent('prism-events-reconnected'));
    await waitFor(() => expect(result.current.authState?.hasToken).toBe(true));
  });
});
