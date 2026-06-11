// Shared test double for the browser EventSource, unifying the ten hand-rolled
// copies that had drifted across the SSE test suite (#332). It captures every
// constructed instance on `FakeEventSource.instances`, lets a test push server
// events via `dispatch` / `dispatchRaw`, and models the error path through
// `fireError`. The richest pre-existing copy (useEventSource.test.tsx) plus the
// `onmessage` / `removeEventListener` members from the HelpModal stub are merged
// here so every former caller is covered.

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
  static CLOSED = 2;

  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
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

  removeEventListener(type: string, cb: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  // NOTE: dispatch / dispatchRaw fire only `addEventListener`-registered
  // listeners, NOT the `onmessage` property — every former caller subscribes via
  // addEventListener('<named-event>', ...), never onmessage. `onmessage` is
  // exposed only because the real EventSource has it; setting `instance.onmessage`
  // and calling dispatch('message', ...) will NOT invoke it (mirrors that no
  // caller relies on that path).
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }

  dispatchRaw(type: string, raw: string) {
    this.listeners[type]?.forEach((cb) => cb({ data: raw } as MessageEvent));
  }

  fireError() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event('error'));
  }
}

// Installs FakeEventSource as the global EventSource and resets the instance
// registry. Call inside a test file's beforeEach — it replaces the
// `instances = []` + `globalThis.EventSource = FakeEventSource` pair that each
// copy repeated.
export function installFakeEventSource(): void {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
}
