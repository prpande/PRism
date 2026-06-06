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
      const stream = openEventStream({ random: () => 0.5 });
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(35_001); // watchdog fires: old closed, backoff armed
      expect(FakeEventSource.instances[0].closed).toBe(true);
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(1_000); // backoff (BASE) elapses → new ES
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('heartbeat resets the silence watcher', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      vi.advanceTimersByTime(25_000);
      FakeEventSource.instances[0].dispatch('heartbeat', { ts: 0 });
      vi.advanceTimersByTime(25_000);
      expect(FakeEventSource.instances).toHaveLength(1);
      expect(FakeEventSource.instances[0].closed).toBe(false);
      vi.advanceTimersByTime(10_001); // 35s after heartbeat → watchdog fires
      expect(FakeEventSource.instances[0].closed).toBe(true);
      vi.advanceTimersByTime(1_000); // backoff
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inbox-updated event also resets the silence watcher', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      vi.advanceTimersByTime(20_000);
      FakeEventSource.instances[0].dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      });
      vi.advanceTimersByTime(34_999);
      expect(FakeEventSource.instances).toHaveLength(1);
      vi.advanceTimersByTime(2); // watchdog fires
      vi.advanceTimersByTime(1_000); // backoff
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
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].dispatch('subscriber-assigned', { subscriberId: 'sub-1' });
      const idBefore = await stream.subscriberId();
      expect(idBefore).toBe('sub-1');
      vi.advanceTimersByTime(35_001);
      vi.advanceTimersByTime(1_000); // backoff → instances[1] now exists
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

describe('openEventStream — backoff', () => {
  it('grows the delay across consecutive reconnects (no liveness)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      vi.advanceTimersByTime(35_001); // watchdog → attempt 0 → delay 1000
      vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(34_999); // land instance-2 watchdog exactly → attempt 1 → delay 2000
      expect(FakeEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(1_999);
      expect(FakeEventSource.instances).toHaveLength(2); // not yet
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(3);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — ping timeout (D3)', () => {
  it('reconnects when the ping never resolves (timeout aborts at 5s)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn(
        (_url, init?: RequestInit) =>
          new Promise((_res, rej) => {
            init?.signal?.addEventListener('abort', () =>
              rej(new DOMException('aborted', 'AbortError')),
            );
          }),
      ) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(5_000); // ping timeout fires → .catch → scheduleReconnect
      await vi.advanceTimersByTimeAsync(1_000); // backoff
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects on a network-error ping (no longer a silent no-op)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new TypeError('network')) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(0); // microtask: .catch runs → scheduleReconnect
      await vi.advanceTimersByTimeAsync(1_000); // backoff
      expect(FakeEventSource.instances).toHaveLength(2);
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

  it('dispatches prism-auth-rejected and tombstones the stream on a 401 ping (no reload)', async () => {
    vi.useFakeTimers();
    try {
      const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(0); // ping resolves
      expect(reloadSpy).not.toHaveBeenCalled();
      expect(
        dispatchSpy.mock.calls.some(([e]) => (e as Event).type === 'prism-auth-rejected'),
      ).toBe(true);
      expect(FakeEventSource.instances[0].closed).toBe(true);
      // tombstoned: no further reconnects ever
      await vi.advanceTimersByTimeAsync(60_000);
      expect(FakeEventSource.instances).toHaveLength(1);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reconnects (no reload) when ping returns 5xx', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 503 })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      try {
        FakeEventSource.instances[0].fireError();
        await vi.advanceTimersByTimeAsync(0); // ping resolves → scheduleReconnect
        await vi.advanceTimersByTimeAsync(1_000); // backoff → instance 2
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(FakeEventSource.instances).toHaveLength(2);
      } finally {
        stream.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('OLD EventSource onerror fired after a watchdog reconnect does NOT trigger another reconnect (captured-self guard)', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 503 }));
      globalThis.fetch = fetchMock as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      try {
        vi.advanceTimersByTime(35_001); // watchdog → scheduleReconnect (old closed)
        await vi.advanceTimersByTimeAsync(1_000); // backoff → instance 2
        expect(FakeEventSource.instances).toHaveLength(2);
        FakeEventSource.instances[0].fireError(); // buffered error on the superseded ES
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(FakeEventSource.instances).toHaveLength(2);
        expect(fetchMock).not.toHaveBeenCalled(); // captured-self guard suppressed the probe
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

describe('openEventStream — dwell-gated reset (D2)', () => {
  it('resets attempt only after the stream survives the 10s dwell', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // first outage: attempt 0 → delay 1000
      vi.advanceTimersByTime(35_001);
      vi.advanceTimersByTime(1_000);
      expect(FakeEventSource.instances).toHaveLength(2);
      // new stream handshakes and SURVIVES the dwell → attempt resets to 0
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 's' });
      vi.advanceTimersByTime(10_000); // dwell elapses → attempt = 0
      // next outage should again use delay 1000 (attempt 0), not 2000.
      // Land the watchdog exactly — overshooting would let the small reset
      // backoff fire inside the same advance.
      vi.advanceTimersByTime(25_000); // watchdog fires → backoff(1000) armed
      expect(FakeEventSource.instances).toHaveLength(2);
      vi.advanceTimersByTime(999);
      expect(FakeEventSource.instances).toHaveLength(2); // not yet
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(3); // delay 1000 → attempt was 0
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a stale dwell from a dropped connection does NOT reset attempt (D8)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 503 })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      try {
        // Climb attempt to 2 via two silence outages (delays 1000, then 2000).
        vi.advanceTimersByTime(35_001);
        await vi.advanceTimersByTimeAsync(1_000); // attempt 0→1, instance 2
        vi.advanceTimersByTime(35_001);
        await vi.advanceTimersByTimeAsync(2_000); // attempt 1→2, instance 3
        expect(FakeEventSource.instances).toHaveLength(3);
        // instance 3 handshakes (arms dwell_A, would fire in 10s) then DROPS at +1s.
        FakeEventSource.instances[2].dispatch('subscriber-assigned', { subscriberId: 's' });
        vi.advanceTimersByTime(1_000);
        FakeEventSource.instances[2].fireError();
        await vi.advanceTimersByTimeAsync(0); // ping 503 → scheduleReconnect: clears dwell_A; computeDelay(2)=4000, attempt→3
        await vi.advanceTimersByTimeAsync(4_000); // instance 4 opens; do NOT handshake it
        expect(FakeEventSource.instances).toHaveLength(4);
        // Pass the moment dwell_A WOULD have fired (10s after instance-3 handshake).
        await vi.advanceTimersByTimeAsync(10_000);
        // Drop instance 4. Next reconnect delay reveals attempt: FIX computeDelay(3)=8000; BUG computeDelay(0)=1000.
        FakeEventSource.instances[3].fireError();
        await vi.advanceTimersByTimeAsync(1_001);
        expect(FakeEventSource.instances).toHaveLength(4); // FIX still waiting (8000); BUG would be 5
        await vi.advanceTimersByTimeAsync(7_000);
        expect(FakeEventSource.instances).toHaveLength(5);
      } finally {
        stream.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — health (D5/D6)', () => {
  it('starts healthy and stays healthy while heartbeats arrive', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      expect(stream.streamHealthy()).toBe(true);
      vi.advanceTimersByTime(20_000);
      FakeEventSource.instances[0].dispatch('heartbeat', { ts: 0 });
      vi.advanceTimersByTime(29_000); // <30s since last heartbeat
      expect(stream.streamHealthy()).toBe(true);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flips unhealthy after 30s with no liveness and notifies subscribers', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      vi.advanceTimersByTime(30_001);
      expect(stream.streamHealthy()).toBe(false);
      expect(onChange).toHaveBeenCalledWith(false);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers to healthy on the next liveness signal', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      vi.advanceTimersByTime(30_001);
      expect(stream.streamHealthy()).toBe(false);
      FakeEventSource.instance.dispatch('heartbeat', { ts: 0 }); // liveness on the current instance
      expect(stream.streamHealthy()).toBe(true);
      expect(onChange).toHaveBeenLastCalledWith(true);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('onHealthChange returns an unsubscribe', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const cb = vi.fn();
      const unsub = stream.onHealthChange(cb);
      unsub();
      vi.advanceTimersByTime(31_000);
      expect(cb).not.toHaveBeenCalled();
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // DEVIATION-PROOF: connect()-tail (reconnect) must NOT reset the health countdown.
  it('a reconnect does NOT reset the health countdown (anchored to liveness, not connect attempts)', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 503 })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      // No liveness ever. Force a reconnect at t=20s (its connect()-tail re-runs).
      await vi.advanceTimersByTimeAsync(20_000);
      FakeEventSource.instance.fireError(); // → ping 503 → scheduleReconnect → backoff → new connect()
      await vi.advanceTimersByTimeAsync(2_000); // reconnect completes; connect()-tail ran
      expect(stream.streamHealthy()).toBe(true); // still within 30s of t=0
      await vi.advanceTimersByTimeAsync(8_001); // cross 30s from t=0
      expect(stream.streamHealthy()).toBe(false); // FIX: fires at 30s anchored to init; BUG: would still be true
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flip unhealthy after close() (health timer cleared on teardown)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      stream.close();
      vi.advanceTimersByTime(60_000);
      expect(onChange).not.toHaveBeenCalled(); // no false-flip after teardown
      expect(stream.streamHealthy()).toBe(true); // never went unhealthy
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not flip unhealthy after a 401 tombstone (health timer cleared)', async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload },
      });
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(new Response('', { status: 401 })) as unknown as typeof fetch;
      const stream = openEventStream({ random: () => 0.5 });
      const onChange = vi.fn();
      stream.onHealthChange(onChange);
      FakeEventSource.instances[0].fireError();
      await vi.advanceTimersByTimeAsync(0); // 401 → tombstone
      await vi.advanceTimersByTimeAsync(60_000);
      expect(onChange).not.toHaveBeenCalledWith(false);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — forceReconnect (D6)', () => {
  it('reconnects immediately, bypassing the backoff wait', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      stream.forceReconnect();
      vi.advanceTimersByTime(0); // immediate (delay 0)
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reset the backoff curve (attempt unchanged)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // climb to attempt 1 (one silence outage), then force an immediate reconnect.
      vi.advanceTimersByTime(35_001);
      vi.advanceTimersByTime(1_000); // attempt 0→1, instance 2
      stream.forceReconnect();
      vi.advanceTimersByTime(0); // immediate, instance 3, attempt stays 1
      // instance 3 has no handshake; land its watchdog exactly (35_000 from t=36_001).
      vi.advanceTimersByTime(35_000); // watchdog → attempt 1 → delay 2000 armed
      expect(FakeEventSource.instances).toHaveLength(3);
      vi.advanceTimersByTime(1_999);
      expect(FakeEventSource.instances).toHaveLength(3); // not yet (delay 2000 ⇒ attempt was NOT reset to 0)
      vi.advanceTimersByTime(1);
      expect(FakeEventSource.instances).toHaveLength(4);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('collapses mashed Retry-now clicks into a single reconnect', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // Each immediate trigger cancels the prior 0ms timer and re-arms it, so
      // mashing the button does not spawn a thundering herd of EventSources —
      // only the last-armed timer fires.
      stream.forceReconnect();
      stream.forceReconnect();
      stream.forceReconnect();
      vi.advanceTimersByTime(0);
      expect(FakeEventSource.instances).toHaveLength(2); // only one new stream
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('overrides a pending backoff wait (Retry now fires immediately mid-backoff)', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // A silence outage arms a real backoff: instance 1 never handshakes, so the
      // 35s watchdog fires → scheduleReconnect() arms a 1000ms (attempt 0) wait.
      vi.advanceTimersByTime(35_000); // watchdog → backoff armed, reconnectPending
      expect(FakeEventSource.instances).toHaveLength(1); // backoff has NOT elapsed
      // User clicks "Retry now" mid-backoff. It must cancel the 1000ms wait and
      // reconnect now — NOT silently no-op until the backoff would have elapsed.
      // (Without the immediate-override, scheduleReconnect bails on reconnectPending
      // and advancing 0ms leaves instances at 1.)
      stream.forceReconnect();
      vi.advanceTimersByTime(0);
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('openEventStream — malformed handshake (D4)', () => {
  it('reconnects when subscriber-assigned payload is not valid JSON', () => {
    vi.useFakeTimers();
    try {
      const stream = openEventStream({ random: () => 0.5 });
      // dispatch a raw frame whose .data is not JSON
      FakeEventSource.instances[0].listeners['subscriber-assigned']?.forEach((cb) =>
        cb({ data: 'not-json{' } as MessageEvent),
      );
      vi.advanceTimersByTime(1_000); // immediate scheduleReconnect (attempt 0 → delay 1000)
      expect(FakeEventSource.instances).toHaveLength(2);
      stream.close();
    } finally {
      vi.useRealTimers();
    }
  });
});
