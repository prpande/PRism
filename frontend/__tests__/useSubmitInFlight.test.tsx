import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { useSubmitInFlight } from '../src/hooks/useSubmitInFlight';

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

  it('swallows a transient 5xx and keeps the prior state', async () => {
    server.use(http.get('/api/submit/in-flight', () => HttpResponse.text('boom', { status: 503 })));
    const { result } = renderHook(() => useSubmitInFlight());
    // Initial defaults survive an immediate 503; the hook never throws.
    await waitFor(() => expect(result.current.inFlight).toBe(false));
    expect(result.current.prRef).toBeNull();
  });
});
