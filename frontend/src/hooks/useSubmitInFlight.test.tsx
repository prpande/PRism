import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useSubmitInFlight } from './useSubmitInFlight';

const server = setupServer(
  http.get('/api/submit/in-flight', () => HttpResponse.json({ inFlight: false, prRef: null })),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('useSubmitInFlight', () => {
  it('exposes the initial /api/submit/in-flight response', async () => {
    server.use(
      http.get('/api/submit/in-flight', () =>
        HttpResponse.json({ inFlight: true, prRef: 'octocat/Hello-World/42' }),
      ),
    );
    const { result } = renderHook(() => useSubmitInFlight());
    await waitFor(() => expect(result.current.inFlight).toBe(true));
    expect(result.current.prRef).toBe('octocat/Hello-World/42');
  });

  it('refetches on the prism-state-changed window event so the link re-enables', async () => {
    let calls = 0;
    server.use(
      http.get('/api/submit/in-flight', () => {
        calls += 1;
        // First call: in-flight. Second (after window event): clear.
        return HttpResponse.json(
          calls === 1
            ? { inFlight: true, prRef: 'octocat/Hello-World/42' }
            : { inFlight: false, prRef: null },
        );
      }),
    );
    const { result } = renderHook(() => useSubmitInFlight());
    await waitFor(() => expect(result.current.inFlight).toBe(true));

    await act(async () => {
      window.dispatchEvent(new CustomEvent('prism-state-changed'));
    });

    await waitFor(() => expect(result.current.inFlight).toBe(false));
    expect(result.current.prRef).toBeNull();
  });

  it('fails open ({inFlight:false}) when a refetch fails after a prior inFlight=true', async () => {
    // Regression for Copilot iter-2 finding: original behavior retained prior
    // state on error, which left the Replace link stuck disabled if the
    // post-lock-release refetch 503'd (no future state-changed event would
    // clear it because the submit was already done). New behavior resets to
    // {inFlight:false, prRef:null} on any error — the backend's /api/auth/replace
    // 409 still enforces correctness on the actual replace attempt.
    let calls = 0;
    server.use(
      http.get('/api/submit/in-flight', () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ inFlight: true, prRef: 'octocat/Hello-World/42' });
        }
        return HttpResponse.text('boom', { status: 503 });
      }),
    );
    const { result } = renderHook(() => useSubmitInFlight());
    // First fetch establishes a non-default prior state.
    await waitFor(() => expect(result.current.inFlight).toBe(true));
    expect(result.current.prRef).toBe('octocat/Hello-World/42');

    // Refetch fails — hook must clear, not retain.
    await act(async () => {
      window.dispatchEvent(new CustomEvent('prism-state-changed'));
    });
    await waitFor(() => expect(result.current.inFlight).toBe(false));
    expect(result.current.prRef).toBeNull();
  });

  it('fails open on the initial mount-time fetch error too', async () => {
    server.use(http.get('/api/submit/in-flight', () => HttpResponse.text('boom', { status: 503 })));
    const { result } = renderHook(() => useSubmitInFlight());
    await waitFor(() => expect(result.current.inFlight).toBe(false));
    expect(result.current.prRef).toBeNull();
  });
});
