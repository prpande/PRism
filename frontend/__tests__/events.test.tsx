import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openEventStream } from '../src/api/events';

class FakeEventSource {
  static instance: FakeEventSource;
  static CLOSED = 2;
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor() {
    FakeEventSource.instance = this;
  }
  addEventListener() {
    /* not exercised here */
  }
  close() {
    this.closed = true;
  }
  fireError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

beforeEach(() => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openEventStream onerror', () => {
  it('dispatches prism-auth-rejected when SSE error coincides with revoked token', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ hasToken: false, host: 'https://github.com', hostMismatch: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch;

    const handler = vi.fn();
    window.addEventListener('prism-auth-rejected', handler);
    try {
      const close = openEventStream({});
      FakeEventSource.instance.fireError();
      // Allow the auth-state probe microtasks to flush.
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/auth/state');
      close();
    } finally {
      window.removeEventListener('prism-auth-rejected', handler);
    }
  });

  it('does not dispatch prism-auth-rejected when token is still valid', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch;

    const handler = vi.fn();
    window.addEventListener('prism-auth-rejected', handler);
    try {
      const close = openEventStream({});
      FakeEventSource.instance.fireError();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(handler).not.toHaveBeenCalled();
      close();
    } finally {
      window.removeEventListener('prism-auth-rejected', handler);
    }
  });

  it('probes /api/auth/state at most once across repeated SSE errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ hasToken: true, host: 'https://github.com', hostMismatch: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ) as unknown as typeof fetch;

    const close = openEventStream({});
    FakeEventSource.instance.fireError();
    FakeEventSource.instance.fireError();
    FakeEventSource.instance.fireError();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    close();
  });
});
