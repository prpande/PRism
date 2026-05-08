import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openEventStream } from '../src/api/events';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
  static CLOSED = 2;
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
  fireError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openEventStream — handshake', () => {
  it('resolves subscriberId promise when subscriber-assigned event lands', async () => {
    const stream = openEventStream();
    try {
      FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 'sub-abc' });
      await expect(stream.subscriberId()).resolves.toBe('sub-abc');
    } finally {
      stream.close();
    }
  });
});

describe('openEventStream — typed listeners', () => {
  it('delivers inbox-updated events to registered listeners', () => {
    const stream = openEventStream();
    const cb = vi.fn();
    stream.on('inbox-updated', cb);
    FakeEventSource.instance.dispatch('inbox-updated', {
      changedSectionIds: ['awaiting-author'],
      newOrUpdatedPrCount: 3,
    });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({
      changedSectionIds: ['awaiting-author'],
      newOrUpdatedPrCount: 3,
    });
    stream.close();
  });

  it('returns unsubscribe function from on()', () => {
    const stream = openEventStream();
    const cb = vi.fn();
    const unsub = stream.on('inbox-updated', cb);
    unsub();
    FakeEventSource.instance.dispatch('inbox-updated', {
      changedSectionIds: [],
      newOrUpdatedPrCount: 1,
    });
    expect(cb).not.toHaveBeenCalled();
    stream.close();
  });

  it('delivers pr-updated events with prRef payload to registered listeners', () => {
    const stream = openEventStream();
    const cb = vi.fn();
    stream.on('pr-updated', cb);
    FakeEventSource.instance.dispatch('pr-updated', {
      prRef: 'octocat/hello/42',
      newHeadSha: 'abc123',
      headShaChanged: true,
      commentCountDelta: 0,
    });
    expect(cb).toHaveBeenCalledWith({
      prRef: 'octocat/hello/42',
      newHeadSha: 'abc123',
      headShaChanged: true,
      commentCountDelta: 0,
    });
    stream.close();
  });

  it('multiple listeners for the same event all fire', () => {
    const stream = openEventStream();
    const a = vi.fn();
    const b = vi.fn();
    stream.on('inbox-updated', a);
    stream.on('inbox-updated', b);
    FakeEventSource.instance.dispatch('inbox-updated', {
      changedSectionIds: [],
      newOrUpdatedPrCount: 1,
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    stream.close();
  });
});

describe('openEventStream — silence watcher (35s = 25s heartbeat + 10s grace)', () => {
  it('reconnects after 35s of silence with no events', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(34_999);
      expect(FakeEventSource.instances[0].closed).toBe(false);
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(2);
      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat resets the silence watcher', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      vi.advanceTimersByTime(25_000);
      FakeEventSource.instances[0].dispatch('heartbeat', { ts: Date.now() });
      vi.advanceTimersByTime(25_000);
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0].closed).toBe(false);
      vi.advanceTimersByTime(10_001);
      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inbox-updated event also resets the silence watcher', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      vi.advanceTimersByTime(20_000);
      FakeEventSource.instances[0].dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      });
      // Without the dispatch, reconnect would fire at 35s; with the dispatch,
      // the watcher resets so 34s later (54s total) we should still have 1 instance.
      vi.advanceTimersByTime(34_999);
      expect(FakeEventSource.instances).toHaveLength(1);
      // 35s after the dispatch — reconnect now fires.
      vi.advanceTimersByTime(2);
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reconnect after close()', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      stream.close();
      expect(FakeEventSource.instances[0].closed).toBe(true);
      vi.advanceTimersByTime(60_000);
      expect(FakeEventSource.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — reconnect signal (AbortController per Promise generation)', () => {
  it('exposes a reconnectSignal that is initially not aborted', () => {
    const stream = openEventStream();
    try {
      const signal = stream.reconnectSignal();
      expect(signal.aborted).toBe(false);
    } finally {
      stream.close();
    }
  });

  it('aborts the current reconnect signal when the watcher reconnects', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      const sigBefore = stream.reconnectSignal();
      expect(sigBefore.aborted).toBe(false);
      vi.advanceTimersByTime(35_001);
      expect(sigBefore.aborted).toBe(true);
      const sigAfter = stream.reconnectSignal();
      expect(sigAfter.aborted).toBe(false);
      expect(sigAfter).not.toBe(sigBefore);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts the reconnect signal on close()', () => {
    const stream = openEventStream();
    const signal = stream.reconnectSignal();
    stream.close();
    expect(signal.aborted).toBe(true);
  });

  it('subscriberId() returns a fresh promise after reconnect', async () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream();
      FakeEventSource.instances[0].dispatch('subscriber-assigned', { subscriberId: 'sub-1' });
      const idBefore = await stream.subscriberId();
      expect(idBefore).toBe('sub-1');
      vi.advanceTimersByTime(35_001);
      // After reconnect, new EventSource exists; new handshake event lands.
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 'sub-2' });
      const idAfter = await stream.subscriberId();
      expect(idAfter).toBe('sub-2');
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — onerror probe via /api/events/ping', () => {
  let originalLocation: Location;
  let reloadSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalLocation = window.location;
    reloadSpy = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...originalLocation, reload: reloadSpy },
    });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  async function flushPromises() {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  it('forces window.location.reload when ping returns 401', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
    const stream = openEventStream();
    try {
      FakeEventSource.instances[0].fireError();
      await flushPromises();
      expect(globalThis.fetch).toHaveBeenCalledWith('/api/events/ping');
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  });

  it('reconnects (no reload) when ping returns 5xx', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 503 })) as unknown as typeof fetch;
    const stream = openEventStream();
    try {
      FakeEventSource.instances[0].fireError();
      await flushPromises();
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(FakeEventSource.instances).toHaveLength(2);
    } finally {
      stream.close();
    }
  });

  it('OLD EventSource onerror fired after a watchdog reconnect does NOT trigger another reconnect (captured-self guard)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(new Response('', { status: 503 })));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const stream = openEventStream();
      try {
        vi.advanceTimersByTime(35_001);
        expect(FakeEventSource.instances).toHaveLength(2);

        FakeEventSource.instances[0].fireError();
        for (let i = 0; i < 10; i++) await Promise.resolve();

        expect(FakeEventSource.instances).toHaveLength(2);
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        stream.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('probes /api/events/ping at most once per EventSource instance across rapid errors', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 200 })) as unknown as typeof fetch;
    const stream = openEventStream();
    try {
      FakeEventSource.instances[0].fireError();
      FakeEventSource.instances[0].fireError();
      FakeEventSource.instances[0].fireError();
      await flushPromises();
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    } finally {
      stream.close();
    }
  });
});
