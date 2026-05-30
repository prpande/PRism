# PR8 — Ask AI drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the static `AskAiEmptyState` `<section>` rendered inline under `PrHeader` with a right-side slide-in `AskAiDrawer` providing a working stub chat surface backed by a per-PR message thread, gated on `aiPreview === true` via the existing `AskAiButton`.

**Architecture:** New App-level `AskAiDrawerProvider` context holds `{ isOpen, cycleIndex, threads: Map<prRefKey, ChatThread> }` where `cycleIndex` is **session-level** (not per-PR — see D74 amendment). The drawer mounts as a fixed-position sibling of `<Routes>` in `App.tsx`. Per-PR threads persist across PR-to-PR navigation. Canned AI replies come from a new `components/AskAiDrawer/askAiUnavailableResponses.ts` module (colocated, NOT in `lib/` — see D76 amendment) designed for dual-purpose reuse (PR8 mock today, v1.x+ AI-unavailable fallback). Drawer is a true non-modal dialog — `aria-modal="false"`, no focus trap, no backdrop — coexists with diff pane shortcuts. ESC handler skips when an `[aria-modal="true"]` element is open (Modal-coexistence guard).

**Tech Stack:** React 19 + TypeScript + Vite + CSS Modules + Vitest + Playwright (existing). New: zero new dependencies.

**Source spec:** `docs/specs/2026-05-29-design-parity-recovery-design.md` § 4.8 (post-brainstorm + post-adversarial-pass revision 2026-05-30). Deferrals: D71–D80 in `docs/specs/2026-05-29-design-parity-recovery-deferrals.md`.

---

## File Structure

**Created:**
- `frontend/src/components/AskAiDrawer/askAiUnavailableResponses.ts` — constant + `pickAiUnavailableResponse()` helper
- `frontend/src/components/AskAiDrawer/askAiUnavailableResponses.test.ts`
- `frontend/src/components/AskAiDrawer/parsePrRefFromPathname.ts` — pathname → prRef parser shared by drawer body + effects
- `frontend/src/components/AskAiDrawer/parsePrRefFromPathname.test.ts`
- `frontend/src/contexts/AskAiDrawerContext.tsx` — provider + `useAskAiDrawer()` hook + types
- `frontend/src/contexts/AskAiDrawerContext.test.tsx`
- `frontend/src/components/AskAiDrawer/AskAiDrawer.tsx`
- `frontend/src/components/AskAiDrawer/AskAiDrawer.module.css`
- `frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx`
- `frontend/src/components/AskAiDrawer/DrawerEffects.tsx` — pathname-based auto-close, render-null
- `frontend/src/components/AskAiDrawer/DrawerEffects.test.tsx`
- `frontend/e2e/ask-ai-drawer.spec.ts`
- `frontend/e2e/parity-baselines/ask-ai-drawer.png` (parity capture, generated)

**Modified:**
- `frontend/src/App.tsx` — wrap `AskAiDrawerProvider` alongside `OpenTabsProvider`; mount `<AskAiDrawer />` + `<DrawerEffects />` siblings of `<Routes>`
- `frontend/src/components/PrDetail/PrHeader.tsx` — remove `askAiOpen` local state, rewire `AskAiButton.onClick` to `useAskAiDrawer().toggle()`, delete inline `<AskAiEmptyState />` render
- `frontend/e2e/parity-baselines.spec.ts` — add `ask-ai-drawer` zone capture (un-fixme if currently fixme'd)
- Various existing test specs that render `PrHeader` / `PrDetailPage` and currently wrap with `OpenTabsProvider`: add `AskAiDrawerProvider` to the wrapper

**Deleted:**
- `frontend/src/components/PrDetail/AskAiEmptyState.tsx`
- Any `AskAiEmptyState.test.tsx` file if present (verify before deleting)

---

## Task 1: Canned response module

**Files:**
- Create: `frontend/src/components/AskAiDrawer/askAiUnavailableResponses.ts`
- Test: `frontend/src/components/AskAiDrawer/askAiUnavailableResponses.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/components/AskAiDrawer/askAiUnavailableResponses.test.ts
import { describe, expect, it } from 'vitest';
import {
  AI_UNAVAILABLE_RESPONSES,
  pickAiUnavailableResponse,
} from './askAiUnavailableResponses';

describe('AI_UNAVAILABLE_RESPONSES', () => {
  it('exports exactly 5 distinct strings', () => {
    expect(AI_UNAVAILABLE_RESPONSES).toHaveLength(5);
    expect(new Set(AI_UNAVAILABLE_RESPONSES).size).toBe(5);
  });

  it('every string starts with "AI is not connected." and is non-empty', () => {
    for (const s of AI_UNAVAILABLE_RESPONSES) {
      expect(s).toMatch(/^AI isn't available right now\./);
      expect(s.length).toBeGreaterThan(30);
    }
  });
});

describe('pickAiUnavailableResponse', () => {
  it('returns entry at index 0 for cycleIndex 0', () => {
    expect(pickAiUnavailableResponse(0)).toBe(AI_UNAVAILABLE_RESPONSES[0]);
  });

  it('wraps around past the pool length (modulo)', () => {
    expect(pickAiUnavailableResponse(5)).toBe(AI_UNAVAILABLE_RESPONSES[0]);
    expect(pickAiUnavailableResponse(12)).toBe(AI_UNAVAILABLE_RESPONSES[2]);
  });

  it('handles negative indices via positive modulo', () => {
    expect(pickAiUnavailableResponse(-1)).toBe(AI_UNAVAILABLE_RESPONSES[4]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/askAiUnavailableResponses.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/components/AskAiDrawer/askAiUnavailableResponses.ts
/**
 * Canned strings shown when AI is unavailable.
 *
 * Used today by PR8's AskAiDrawer as the canned-reply pool (no AI backend exists yet).
 * Reusable downstream by any AI-integration code path that needs an "AI is unavailable"
 * fallback (timeout / unset API key / user disabled in Settings). The "AI is not connected"
 * framing is honest in BOTH states without rewording.
 */
export const AI_UNAVAILABLE_RESPONSES: readonly string[] = [
  "AI isn't available right now. When it is, it would summarize the diff per file and highlight risky areas.",
  "AI isn't available right now. When it is, it would surface tests that exercise the changed lines.",
  "AI isn't available right now. When it is, it would explain how a specific function got refactored.",
  "AI isn't available right now. When it is, it would compare the head SHA to the base and call out behavior changes.",
  "AI isn't available right now. When it is, it would flag drafts whose anchor lines moved in the latest iteration.",
] as const;

export function pickAiUnavailableResponse(cycleIndex: number): string {
  const len = AI_UNAVAILABLE_RESPONSES.length;
  const i = ((cycleIndex % len) + len) % len;
  return AI_UNAVAILABLE_RESPONSES[i];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/askAiUnavailableResponses.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer/askAiUnavailableResponses.ts frontend/src/components/AskAiDrawer/askAiUnavailableResponses.test.ts
git commit -m "feat(pr8): canned AI-unavailable response module + pickAiUnavailableResponse helper"
```

---

## Task 2: PR-ref pathname parser

**Files:**
- Create: `frontend/src/components/AskAiDrawer/parsePrRefFromPathname.ts`
- Test: `frontend/src/components/AskAiDrawer/parsePrRefFromPathname.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// frontend/src/components/AskAiDrawer/parsePrRefFromPathname.test.ts
import { describe, expect, it } from 'vitest';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';

describe('parsePrRefFromPathname', () => {
  it('parses /pr/owner/repo/123 into { owner, repo, number: 123 }', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('parses /pr/owner/repo/123/files (sub-route)', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123/files')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('parses /pr/owner/repo/123/drafts', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123/drafts')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('returns null for /', () => {
    expect(parsePrRefFromPathname('/')).toBeNull();
  });

  it('returns null for /setup', () => {
    expect(parsePrRefFromPathname('/setup')).toBeNull();
  });

  it('returns null for /settings', () => {
    expect(parsePrRefFromPathname('/settings')).toBeNull();
  });

  it('returns null for /pr (no segments)', () => {
    expect(parsePrRefFromPathname('/pr')).toBeNull();
  });

  it('returns null for /pr/acme (only owner)', () => {
    expect(parsePrRefFromPathname('/pr/acme')).toBeNull();
  });

  it('returns null for /pr/acme/api/abc (non-numeric number)', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/abc')).toBeNull();
  });

  it('parses /pr/owner-with-dashes/repo.with.dots/42', () => {
    expect(parsePrRefFromPathname('/pr/owner-with-dashes/repo.with.dots/42')).toEqual({
      owner: 'owner-with-dashes',
      repo: 'repo.with.dots',
      number: 42,
    });
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/parsePrRefFromPathname.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// frontend/src/components/AskAiDrawer/parsePrRefFromPathname.ts
import type { PrReference } from '../api/types';

/**
 * Parse the leading /pr/:owner/:repo/:number segments from a pathname.
 *
 * Returns null when the pathname does not match a PR Detail route. Used at App level
 * (where useParams() returns empty) to derive the current PR ref from useLocation().pathname.
 */
export function parsePrRefFromPathname(pathname: string): PrReference | null {
  const m = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/.*)?$/.exec(pathname);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    number: parseInt(m[3], 10),
  };
}
```

- [ ] **Step 4: Run test**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/parsePrRefFromPathname.test.ts`
Expected: 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer/parsePrRefFromPathname.ts frontend/src/components/AskAiDrawer/parsePrRefFromPathname.test.ts
git commit -m "feat(pr8): parsePrRefFromPathname helper for App-level prRef derivation"
```

---

## Task 3: AskAiDrawerContext provider (state machine, no UI)

**Files:**
- Create: `frontend/src/contexts/AskAiDrawerContext.tsx`
- Test: `frontend/src/contexts/AskAiDrawerContext.test.tsx`

The provider models the full state machine. The `<AskAiDrawer />` JSX (Task 4+) consumes via `useAskAiDrawer()`.

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/contexts/AskAiDrawerContext.test.tsx
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  AskAiDrawerProvider,
  useAskAiDrawer,
  type ChatThread,
} from './AskAiDrawerContext';
import type { PrReference } from '../api/types';

const refA: PrReference = { owner: 'acme', repo: 'api', number: 1 };
const refB: PrReference = { owner: 'acme', repo: 'api', number: 2 };
const keyA = 'acme/api#1';
const keyB = 'acme/api#2';

function wrapper({ children }: { children: React.ReactNode }) {
  return <AskAiDrawerProvider>{children}</AskAiDrawerProvider>;
}

describe('AskAiDrawerContext', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with isOpen=false, session cycleIndex 0, and no threads', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    expect(result.current.isOpen).toBe(false);
    expect(result.current.cycleIndex).toBe(0);
    expect(result.current.getThread(keyA)).toEqual<ChatThread>({
      messages: [],
      input: '',
      pendingAiReply: false,
    });
  });

  it('toggle() flips isOpen', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(false);
  });

  it('close() sets isOpen=false (no-op when already closed)', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    act(() => result.current.close());
    expect(result.current.isOpen).toBe(false);
  });

  it('setInput updates per-PR input without touching other PR threads', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'hello PR A'));
    expect(result.current.getThread(keyA).input).toBe('hello PR A');
    expect(result.current.getThread(keyB).input).toBe('');
  });

  it('sendMessage appends user msg, sets pending, schedules reply; cycleIndex is session-level', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'why this change?'));
    act(() => result.current.sendMessage(keyA));
    let thread = result.current.getThread(keyA);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ role: 'user', body: 'why this change?' });
    expect(thread.input).toBe('');
    expect(thread.pendingAiReply).toBe(true);
    expect(result.current.cycleIndex).toBe(0);

    act(() => {
      vi.advanceTimersByTime(700);
    });
    thread = result.current.getThread(keyA);
    expect(thread.messages).toHaveLength(2);
    expect(thread.messages[1].role).toBe('ai');
    expect(thread.messages[1].body).toMatch(/^AI isn't available right now\./);
    expect(thread.pendingAiReply).toBe(false);
    expect(result.current.cycleIndex).toBe(1);
  });

  it('sendMessage trims trailing whitespace from body before appending', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, '  hello  \n\n'));
    act(() => result.current.sendMessage(keyA));
    expect(result.current.getThread(keyA).messages[0].body).toBe('hello');
  });

  it('sendMessage drops when input is empty-or-whitespace', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, '   \n  '));
    act(() => result.current.sendMessage(keyA));
    expect(result.current.getThread(keyA).messages).toHaveLength(0);
    expect(result.current.getThread(keyA).pendingAiReply).toBe(false);
  });

  it('sendMessage drops when pendingAiReply is true', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'first'));
    act(() => result.current.sendMessage(keyA));
    act(() => result.current.setInput(keyA, 'second while pending'));
    act(() => result.current.sendMessage(keyA));
    expect(result.current.getThread(keyA).messages).toHaveLength(1);
  });

  it('sendMessage caps body at 4000 chars', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    const big = 'x'.repeat(5000);
    act(() => result.current.setInput(keyA, big));
    act(() => result.current.sendMessage(keyA));
    expect(result.current.getThread(keyA).messages[0].body).toHaveLength(4000);
  });

  it('sendMessage on PR A then PR B advances the session cycle so responses differ', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'A msg 1'));
    act(() => result.current.sendMessage(keyA));
    act(() => result.current.setInput(keyB, 'B msg 1'));
    act(() => result.current.sendMessage(keyB));
    act(() => {
      vi.advanceTimersByTime(700);
    });
    const aThread = result.current.getThread(keyA);
    const bThread = result.current.getThread(keyB);
    expect(aThread.messages).toHaveLength(2);
    expect(bThread.messages).toHaveLength(2);
    expect(result.current.cycleIndex).toBe(2);
    // PR A submit captured cycle 0; PR B submit captured cycle 1. Responses differ.
    expect(aThread.messages[1].body).not.toBe(bThread.messages[1].body);
  });

  it('clearAll wipes threads + isOpen', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'hi'));
    act(() => result.current.sendMessage(keyA));
    act(() => result.current.toggle());
    act(() => result.current.clearAll());
    expect(result.current.isOpen).toBe(false);
    expect(result.current.getThread(keyA).messages).toHaveLength(0);
  });

  it('throws when useAskAiDrawer is called outside provider', () => {
    expect(() => renderHook(() => useAskAiDrawer())).toThrow(
      /useAskAiDrawer must be used inside AskAiDrawerProvider/,
    );
  });
});
```

- [ ] **Step 2: Run test**

Run: `cd frontend && npx vitest run src/contexts/AskAiDrawerContext.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```tsx
// frontend/src/contexts/AskAiDrawerContext.tsx
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { pickAiUnavailableResponse } from '../lib/askAiUnavailableResponses';

const AI_REPLY_DELAY_MS = 600;
const MAX_INPUT_CHARS = 4000;

export interface ChatMessage {
  role: 'user' | 'ai';
  body: string;
  ts: number;
}

export interface ChatThread {
  messages: ChatMessage[];
  input: string;
  pendingAiReply: boolean;
}

const EMPTY_THREAD: ChatThread = Object.freeze({
  messages: [],
  input: '',
  pendingAiReply: false,
});

export interface AskAiDrawerContextValue {
  isOpen: boolean;
  cycleIndex: number;
  toggle(): void;
  close(): void;
  getThread(prRefKey: string): ChatThread;
  setInput(prRefKey: string, value: string): void;
  sendMessage(prRefKey: string): void;
  clearAll(): void;
}

const AskAiDrawerContext = createContext<AskAiDrawerContextValue | null>(null);

export function AskAiDrawerProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [cycleIndex, setCycleIndex] = useState(0);
  const [threads, setThreads] = useState<ReadonlyMap<string, ChatThread>>(() => new Map());
  const cycleIndexRef = useRef(0);

  // Mirror of `threads` so sendMessage's setTimeout callback can read the latest
  // thread state without re-subscribing on every render. The ref is written
  // inside each setThreads updater (see OpenTabsContext D78 ref-mirror pattern).
  const threadsRef = useRef<ReadonlyMap<string, ChatThread>>(threads);

  // Track pending timeouts for cleanup on unmount (provider lifetime = App
  // lifetime, so this matters mostly for vitest's StrictMode + cleanup).
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const updateThread = useCallback(
    (prRefKey: string, mutator: (thread: ChatThread) => ChatThread) => {
      setThreads((prev) => {
        const existing = prev.get(prRefKey) ?? EMPTY_THREAD;
        const next = mutator(existing);
        if (next === existing) {
          threadsRef.current = prev;
          return prev;
        }
        const nextMap = new Map(prev);
        nextMap.set(prRefKey, next);
        threadsRef.current = nextMap;
        return nextMap;
      });
    },
    [],
  );

  const toggle = useCallback(() => {
    setIsOpen((v) => !v);
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
  }, []);

  const getThread = useCallback(
    (prRefKey: string): ChatThread => threadsRef.current.get(prRefKey) ?? EMPTY_THREAD,
    [],
  );

  const setInput = useCallback(
    (prRefKey: string, value: string) => {
      updateThread(prRefKey, (t) => ({ ...t, input: value }));
    },
    [updateThread],
  );

  const sendMessage = useCallback(
    (prRefKey: string) => {
      const thread = threadsRef.current.get(prRefKey) ?? EMPTY_THREAD;
      if (thread.pendingAiReply) return;
      const body = thread.input.trim().slice(0, MAX_INPUT_CHARS);
      if (body.length === 0) return;

      const userMessage: ChatMessage = { role: 'user', body, ts: Date.now() };
      const cycleIndexAtSend = cycleIndexRef.current;
      updateThread(prRefKey, (t) => ({
        messages: [...t.messages, userMessage],
        input: '',
        pendingAiReply: true,
      }));

      const handle = setTimeout(() => {
        pendingTimeoutsRef.current.delete(handle);
        const aiMessage: ChatMessage = {
          role: 'ai',
          body: pickAiUnavailableResponse(cycleIndexAtSend),
          ts: Date.now(),
        };
        updateThread(prRefKey, (t) => ({
          messages: [...t.messages, aiMessage],
          input: t.input,
          pendingAiReply: false,
        }));
        cycleIndexRef.current += 1;
        setCycleIndex(cycleIndexRef.current);
      }, AI_REPLY_DELAY_MS);
      pendingTimeoutsRef.current.add(handle);
    },
    [updateThread],
  );

  const clearAll = useCallback(() => {
    for (const handle of pendingTimeoutsRef.current) {
      clearTimeout(handle);
    }
    pendingTimeoutsRef.current.clear();
    threadsRef.current = new Map();
    cycleIndexRef.current = 0;
    setThreads(new Map());
    setCycleIndex(0);
    setIsOpen(false);
  }, []);

  const value = useMemo<AskAiDrawerContextValue>(
    () => ({ isOpen, cycleIndex, toggle, close, getThread, setInput, sendMessage, clearAll }),
    [isOpen, cycleIndex, toggle, close, getThread, setInput, sendMessage, clearAll],
  );

  return <AskAiDrawerContext.Provider value={value}>{children}</AskAiDrawerContext.Provider>;
}

export function useAskAiDrawer(): AskAiDrawerContextValue {
  const v = useContext(AskAiDrawerContext);
  if (v == null) {
    throw new Error('useAskAiDrawer must be used inside AskAiDrawerProvider');
  }
  return v;
}
```

- [ ] **Step 4: Run test**

Run: `cd frontend && npx vitest run src/contexts/AskAiDrawerContext.test.tsx`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/contexts/AskAiDrawerContext.tsx frontend/src/contexts/AskAiDrawerContext.test.tsx
git commit -m "feat(pr8): AskAiDrawerProvider context + per-PR thread state machine"
```

---

## Task 4: AskAiDrawer visual chrome + slide-in animation

CSS module + skeleton component (header, body skeleton, composer skeleton, slide-in). NO message rendering yet (Task 5), no composer logic (Task 6). Pure chrome + open/close.

**Files:**
- Create: `frontend/src/components/AskAiDrawer/AskAiDrawer.tsx`
- Create: `frontend/src/components/AskAiDrawer/AskAiDrawer.module.css`
- Test: `frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx`

- [ ] **Step 1: Write the CSS module (handoff `.ai-drawer` port — screens.css:791-819)**

```css
/* frontend/src/components/AskAiDrawer/AskAiDrawer.module.css */
.drawer {
  position: fixed;
  right: 0;
  top: 0;
  bottom: 0;
  width: 400px;
  max-width: 100vw;
  background: var(--surface-1);
  border-left: 1px solid var(--border-1);
  box-shadow: var(--shadow-3);
  transform: translateX(100%);
  transition: transform 220ms var(--ease-out);
  display: flex;
  flex-direction: column;
  z-index: 50;
}

.drawer.isOpen {
  transform: translateX(0);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--s-3) var(--s-4);
  border-bottom: 1px solid var(--border-1);
}

.headTitle {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  font-weight: 600;
}

.headSubtitle {
  color: var(--text-2);
  font-weight: 400;
}

.body {
  flex: 1;
  overflow: auto;
  padding: var(--s-4);
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
}

.emptyHint {
  color: var(--text-3);
  font-size: var(--text-sm);
}

.emptyKbdHint {
  align-self: flex-start;
  margin-top: auto;
}

.composer {
  display: flex;
  gap: var(--s-2);
  padding: var(--s-3);
  border-top: 1px solid var(--border-1);
  align-items: flex-end;
}

.composerTextarea {
  flex: 1;
  min-height: 36px;
  max-height: calc(36px * 4);
  resize: none;
}

@media (prefers-reduced-motion: reduce) {
  .drawer {
    transition: none;
  }
}
```

- [ ] **Step 2: Write the failing component test**

```tsx
// frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { AskAiDrawer } from './AskAiDrawer';
import { AskAiDrawerProvider, useAskAiDrawer } from '../../contexts/AskAiDrawerContext';

function Harness({ openOnMount }: { openOnMount: boolean }) {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <ToggleOnMount openOnMount={openOnMount} />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function ToggleOnMount({ openOnMount }: { openOnMount: boolean }) {
  const { isOpen, toggle } = useAskAiDrawer();
  if (openOnMount && !isOpen) toggle();
  return null;
}

describe('AskAiDrawer chrome', () => {
  it('renders the drawer container always (for animation), with isOpen class only when open', () => {
    const { container } = render(<Harness openOnMount={false} />);
    const drawer = container.querySelector('aside[role="dialog"]');
    expect(drawer).toBeInTheDocument();
    expect(drawer).not.toHaveClass('isOpen');
  });

  it('adds the isOpen class when state is open', () => {
    const { container } = render(<Harness openOnMount={true} />);
    const drawer = container.querySelector('aside[role="dialog"]');
    expect(drawer).toHaveClass(/isOpen/);
  });

  it('renders header label "Ask about this PR · AI unavailable" with subtitle muted', () => {
    render(<Harness openOnMount={true} />);
    expect(screen.getByText('Ask about this PR')).toBeInTheDocument();
    expect(screen.getByText(/AI unavailable/)).toBeInTheDocument();
  });

  it('has aria-modal="false" and aria-labelledby pointing at the header title', () => {
    const { container } = render(<Harness openOnMount={true} />);
    const dialog = container.querySelector('aside[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('false');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)).toHaveTextContent('Ask about this PR');
  });

  it('sets aria-hidden=true when closed and false when open', () => {
    const { container, rerender } = render(<Harness openOnMount={false} />);
    expect(container.querySelector('aside[role="dialog"]')!.getAttribute('aria-hidden')).toBe(
      'true',
    );
    rerender(<Harness openOnMount={true} />);
    expect(container.querySelector('aside[role="dialog"]')!.getAttribute('aria-hidden')).toBe(
      'false',
    );
  });

  it('close button is keyboard-reachable and labelled', () => {
    render(<Harness openOnMount={true} />);
    const close = screen.getByRole('button', { name: /close ask ai drawer/i });
    expect(close).toBeInTheDocument();
  });

  it('Escape key closes the drawer', () => {
    render(<Harness openOnMount={true} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    const drawer = document.querySelector('aside[role="dialog"]')!;
    expect(drawer).not.toHaveClass(/isOpen/);
  });

  it('clicking the close button closes the drawer', () => {
    render(<Harness openOnMount={true} />);
    fireEvent.click(screen.getByRole('button', { name: /close ask ai drawer/i }));
    const drawer = document.querySelector('aside[role="dialog"]')!;
    expect(drawer).not.toHaveClass(/isOpen/);
  });

  it('empty body shows "Ask anything about this PR." hint + ⌘ ⏎ kbd hint', () => {
    render(<Harness openOnMount={true} />);
    expect(screen.getByText(/Ask anything about this PR/)).toBeInTheDocument();
    expect(screen.getByText(/⌘ ⏎ to send/)).toBeInTheDocument();
  });

  it('composer textarea is initial focus on open', () => {
    render(<Harness openOnMount={true} />);
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });
});
```

- [ ] **Step 3: Run test**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/AskAiDrawer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Write the component implementation**

```tsx
// frontend/src/components/AskAiDrawer/AskAiDrawer.tsx
import { useEffect, useId, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from '../../lib/parsePrRefFromPathname';
import { prRefKey } from '../../api/types';
import styles from './AskAiDrawer.module.css';

export function AskAiDrawer() {
  const { isOpen, close, getThread } = useAskAiDrawer();
  const { pathname } = useLocation();
  const titleId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const prRef = parsePrRefFromPathname(pathname);
  const prKey = prRef ? prRefKey(prRef) : '';
  const thread = prKey ? getThread(prKey) : null;

  // Focus capture-on-open + restore-on-close. Composer is the initial focus target.
  useEffect(() => {
    if (isOpen) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      textareaRef.current?.focus();
      return () => {
        previouslyFocused.current?.focus();
      };
    }
  }, [isOpen]);

  // ESC closes (do NOT preventDefault — composer + browser ESC chains still flow).
  // Modal-coexistence guard: if any [aria-modal="true"] element is open, the modal
  // should consume ESC first — drawer ESC is suppressed for that keystroke. Mirrors
  // Cheatsheet.tsx's capture-phase guard at useCheatsheetShortcut.ts:53.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  const hasMessages = (thread?.messages.length ?? 0) > 0;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-hidden={!isOpen}
      data-testid="ask-ai-drawer"
      className={`${styles.drawer} ${isOpen ? styles.isOpen : ''}`}
    >
      <div className={styles.head}>
        <span id={titleId} className={styles.headTitle}>
          <span className="ai-icon" aria-hidden="true">
            ✨
          </span>
          <span>
            Ask about this PR{' '}
            <span className={styles.headSubtitle}>· AI unavailable</span>
          </span>
        </span>
        <button
          type="button"
          className="btn-icon"
          aria-label="Close Ask AI drawer"
          onClick={close}
        >
          ✕
        </button>
      </div>
      <div className={styles.body}>
        {!hasMessages && (
          <>
            <p className={styles.emptyHint}>Ask anything about this PR.</p>
            <span className={`kbd ${styles.emptyKbdHint}`}>⌘ ⏎ to send</span>
          </>
        )}
        {/* Message rendering lands in Task 5 */}
      </div>
      <div className={styles.composer}>
        <textarea
          ref={textareaRef}
          className={`textarea ${styles.composerTextarea}`}
          placeholder="Ask about this PR…"
          rows={2}
          aria-label="Message"
        />
        <button type="button" className="btn btn-primary btn-sm" disabled>
          Send
        </button>
      </div>
    </aside>
  );
}
```

- [ ] **Step 5: Run test**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/AskAiDrawer.test.tsx`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/AskAiDrawer
git commit -m "feat(pr8): AskAiDrawer chrome — slide-in, header, ESC close, empty-state hint"
```

---

## Task 5: Message list rendering (user bubble, AI bubble, typing indicator)

**Files:**
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.tsx`
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.module.css`
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx`

- [ ] **Step 1: Append CSS for messages**

```css
/* append to AskAiDrawer.module.css */
.msgUser {
  align-self: flex-end;
  padding: var(--s-3);
  background: var(--surface-2);
  border-radius: var(--radius-3);
  max-width: 85%;
  max-height: 60vh;
  overflow-y: auto;
  font-size: var(--text-sm);
  line-height: 1.5;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.msgAi {
  display: flex;
  gap: var(--s-2);
  padding: var(--s-3);
  font-size: var(--text-sm);
  line-height: 1.5;
}

.msgAiBody {
  flex: 1;
  white-space: pre-wrap;
  word-wrap: break-word;
}

.typing {
  display: inline-flex;
  gap: 4px;
}

.typingDot {
  width: 6px;
  height: 6px;
  background: var(--text-3);
  border-radius: 50%;
  animation: typingBounce 1.2s infinite ease-in-out;
}

.typingDot:nth-child(2) {
  animation-delay: 0.15s;
}

.typingDot:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes typingBounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.5;
  }
  30% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .typingDot {
    animation: none;
  }
}
```

- [ ] **Step 2: Add failing tests for message rendering**

```tsx
// append to AskAiDrawer.test.tsx within the same describe block
import { act } from '@testing-library/react';

function HarnessWithSeed({ messages }: { messages: Array<{ role: 'user' | 'ai'; body: string }> }) {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <Seed messages={messages} />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function Seed({ messages }: { messages: Array<{ role: 'user' | 'ai'; body: string }> }) {
  const { setInput, sendMessage, toggle } = useAskAiDrawer();
  useEffect(() => {
    toggle();
    // Synchronously push user messages by calling setInput + sendMessage,
    // skipping the canned-reply delay via fake timers in the test.
    for (const m of messages) {
      if (m.role === 'user') {
        act(() => {
          setInput('acme/api#1', m.body);
          sendMessage('acme/api#1');
        });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('AskAiDrawer messages', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('renders user bubble for user messages', () => {
    render(<HarnessWithSeed messages={[{ role: 'user', body: 'why?' }]} />);
    expect(screen.getByText('why?')).toBeInTheDocument();
  });

  it('renders typing indicator while pendingAiReply', () => {
    render(<HarnessWithSeed messages={[{ role: 'user', body: 'why?' }]} />);
    expect(screen.getByTestId('ai-typing-indicator')).toBeInTheDocument();
  });

  it('renders AI bubble after timeout fires', () => {
    render(<HarnessWithSeed messages={[{ role: 'user', body: 'why?' }]} />);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(screen.queryByTestId('ai-typing-indicator')).not.toBeInTheDocument();
    expect(screen.getByText(/AI isn't available right now\./)).toBeInTheDocument();
  });

  it('renders bodies as plain text, not HTML (XSS guard)', () => {
    render(<HarnessWithSeed messages={[{ role: 'user', body: '<script>x</script>' }]} />);
    expect(screen.getByText('<script>x</script>')).toBeInTheDocument();
    expect(document.querySelector('script')).toBeNull();
  });
});
```

- [ ] **Step 3: Update component to render messages**

Replace the `<div className={styles.body}>` block in `AskAiDrawer.tsx` with:

```tsx
<div className={styles.body}>
  {!hasMessages && !thread?.pendingAiReply && (
    <>
      <p className={styles.emptyHint}>Ask anything about this PR.</p>
      <span className={`kbd ${styles.emptyKbdHint}`}>⌘ ⏎ to send</span>
    </>
  )}
  {thread?.messages.map((m, i) =>
    m.role === 'user' ? (
      <div key={i} className={styles.msgUser}>
        {m.body}
      </div>
    ) : (
      <div key={i} className={styles.msgAi}>
        <span className="ai-icon" aria-hidden="true">
          ✨
        </span>
        <div className={styles.msgAiBody}>{m.body}</div>
      </div>
    ),
  )}
  {thread?.pendingAiReply && (
    <div className={styles.msgAi} data-testid="ai-typing-indicator">
      <span className="ai-icon" aria-hidden="true">
        ✨
      </span>
      <span className={styles.typing} aria-label="AI is responding">
        <span className={styles.typingDot} />
        <span className={styles.typingDot} />
        <span className={styles.typingDot} />
      </span>
    </div>
  )}
</div>
```

- [ ] **Step 4: Run tests**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/AskAiDrawer.test.tsx`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/AskAiDrawer
git commit -m "feat(pr8): AskAiDrawer message list + typing indicator + plain-text rendering"
```

---

## Task 6: Composer wiring (Cmd+Enter submit, disable rules, 4000-char cap)

**Files:**
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.tsx`
- Modify: `frontend/src/components/AskAiDrawer/AskAiDrawer.test.tsx`

- [ ] **Step 1: Add failing tests for composer**

```tsx
// append to AskAiDrawer.test.tsx
import { userEvent } from '@testing-library/user-event';

function ComposerHarness() {
  return (
    <MemoryRouter initialEntries={['/pr/acme/api/1']}>
      <AskAiDrawerProvider>
        <OpenOnMount />
        <AskAiDrawer />
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
}

function OpenOnMount() {
  const { isOpen, toggle } = useAskAiDrawer();
  useEffect(() => {
    if (!isOpen) toggle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

describe('AskAiDrawer composer', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('typing in textarea updates input via setInput', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'hello');
    expect((textarea as HTMLTextAreaElement).value).toBe('hello');
  });

  it('Send button is disabled when input is empty', () => {
    render(<ComposerHarness />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('Send button is disabled when input is whitespace-only', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), '   ');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('Send button enables when input has non-whitespace chars', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'x');
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('clicking Send appends user message + sets pending', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'why?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('why?')).toBeInTheDocument();
    expect(screen.getByTestId('ai-typing-indicator')).toBeInTheDocument();
  });

  it('Cmd/Ctrl+Enter submits', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'why?');
    await user.keyboard('{Control>}{Enter}{/Control}');
    expect(screen.getByText('why?')).toBeInTheDocument();
  });

  it('plain Enter inserts newline, does NOT submit', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox');
    await user.type(textarea, 'line1{Enter}line2');
    expect((textarea as HTMLTextAreaElement).value).toBe('line1\nline2');
    expect(screen.queryByTestId('ai-typing-indicator')).not.toBeInTheDocument();
  });

  it('Send button disabled while pendingAiReply', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    await user.type(screen.getByRole('textbox'), 'first');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    await user.type(screen.getByRole('textbox'), 'second');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('input is cleared after successful submit', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ComposerHarness />);
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    await user.type(textarea, 'why?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(textarea.value).toBe('');
  });
});
```

- [ ] **Step 2: Update component composer wiring**

Replace the static `<textarea>` + Send button section in `AskAiDrawer.tsx` with the controlled equivalent that reads from `thread.input` and submits via `sendMessage`. Sketch:

```tsx
const { sendMessage, setInput } = useAskAiDrawer();
const inputValue = thread?.input ?? '';
const canSubmit = !!thread && !thread.pendingAiReply && inputValue.trim().length > 0;

const handleSubmit = useCallback(() => {
  if (!prKey || !canSubmit) return;
  sendMessage(prKey);
}, [prKey, canSubmit, sendMessage]);

const handleKeyDown = useCallback(
  (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  },
  [handleSubmit],
);

// ... in JSX:
<textarea
  ref={textareaRef}
  className={`textarea ${styles.composerTextarea}`}
  placeholder="Ask about this PR…"
  rows={2}
  aria-label="Message"
  value={inputValue}
  onChange={(e) => prKey && setInput(prKey, e.target.value)}
  onKeyDown={handleKeyDown}
/>
<button
  type="button"
  className="btn btn-primary btn-sm"
  disabled={!canSubmit}
  onClick={handleSubmit}
>
  Send
</button>
```

Import `useCallback` from React.

- [ ] **Step 3: Run tests**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/AskAiDrawer.test.tsx`
Expected: all composer tests PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AskAiDrawer
git commit -m "feat(pr8): AskAiDrawer composer — controlled textarea, Cmd+Enter submit, disable rules"
```

---

## Task 7: DrawerEffects — pathname-based auto-close

**Files:**
- Create: `frontend/src/components/AskAiDrawer/DrawerEffects.tsx`
- Test: `frontend/src/components/AskAiDrawer/DrawerEffects.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// frontend/src/components/AskAiDrawer/DrawerEffects.test.tsx
import { act, render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { DrawerEffects } from './DrawerEffects';
import { AskAiDrawerProvider, useAskAiDrawer } from '../../contexts/AskAiDrawerContext';

function StateProbe({
  onMount,
  onState,
}: {
  onMount: (toggle: () => void, navigate: ReturnType<typeof useNavigate>) => void;
  onState: (isOpen: boolean) => void;
}) {
  const { isOpen, toggle } = useAskAiDrawer();
  const navigate = useNavigate();
  useEffect(() => {
    onMount(toggle, navigate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    onState(isOpen);
  }, [isOpen, onState]);
  return null;
}

describe('DrawerEffects', () => {
  it('does NOT close drawer while on a PR Detail route', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t) => {
              toggleFn = t;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    expect(states[states.length - 1]).toBe(true);
  });

  it('auto-closes drawer when pathname leaves PR Detail', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    let navigateFn: ReturnType<typeof useNavigate> | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t, n) => {
              toggleFn = t;
              navigateFn = n;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    expect(states[states.length - 1]).toBe(true);
    act(() => navigateFn!('/'));
    expect(states[states.length - 1]).toBe(false);
  });

  it('does NOT auto-reopen when pathname returns to PR Detail', () => {
    const states: boolean[] = [];
    let toggleFn: (() => void) | null = null;
    let navigateFn: ReturnType<typeof useNavigate> | null = null;
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <AskAiDrawerProvider>
          <StateProbe
            onMount={(t, n) => {
              toggleFn = t;
              navigateFn = n;
            }}
            onState={(o) => states.push(o)}
          />
          <DrawerEffects />
        </AskAiDrawerProvider>
      </MemoryRouter>,
    );
    act(() => toggleFn!());
    act(() => navigateFn!('/'));
    act(() => navigateFn!('/pr/acme/api/1'));
    expect(states[states.length - 1]).toBe(false);
  });
});
```

- [ ] **Step 2: Write the implementation**

```tsx
// frontend/src/components/AskAiDrawer/DrawerEffects.tsx
import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from '../../lib/parsePrRefFromPathname';

/**
 * Render-null component that closes the AskAi drawer when the user navigates
 * away from a PR Detail route. The drawer state itself lives in the provider;
 * this component owns the location-coupled effect so the provider stays
 * route-agnostic and testable in isolation.
 */
export function DrawerEffects() {
  const { isOpen, close } = useAskAiDrawer();
  const { pathname } = useLocation();
  const isOnPrDetail = parsePrRefFromPathname(pathname) !== null;

  useEffect(() => {
    if (!isOnPrDetail && isOpen) {
      close();
    }
  }, [isOnPrDetail, isOpen, close]);

  return null;
}
```

- [ ] **Step 3: Run tests**

Run: `cd frontend && npx vitest run src/components/AskAiDrawer/DrawerEffects.test.tsx`
Expected: 3 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/AskAiDrawer/DrawerEffects.tsx frontend/src/components/AskAiDrawer/DrawerEffects.test.tsx
git commit -m "feat(pr8): DrawerEffects — pathname-based auto-close on PR Detail exit"
```

---

## Task 8: Identity-change wipe in provider

**Files:**
- Modify: `frontend/src/contexts/AskAiDrawerContext.tsx`
- Modify: `frontend/src/contexts/AskAiDrawerContext.test.tsx`

- [ ] **Step 1: Add failing test**

```tsx
// append to AskAiDrawerContext.test.tsx
describe('AskAiDrawerContext identity-change', () => {
  it('clears all threads + closes drawer when prism-identity-changed fires', () => {
    const { result } = renderHook(() => useAskAiDrawer(), { wrapper });
    act(() => result.current.setInput(keyA, 'hi'));
    act(() => result.current.sendMessage(keyA));
    act(() => result.current.toggle());
    expect(result.current.isOpen).toBe(true);
    expect(result.current.getThread(keyA).messages).toHaveLength(1);

    act(() => {
      window.dispatchEvent(new Event('prism-identity-changed'));
    });

    expect(result.current.isOpen).toBe(false);
    expect(result.current.getThread(keyA).messages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Add useEffect listener to provider (above the `value` memo)**

```tsx
// AskAiDrawerContext.tsx — inside AskAiDrawerProvider, before the useMemo
useEffect(() => {
  const onIdentityChange = () => clearAll();
  window.addEventListener('prism-identity-changed', onIdentityChange);
  return () => window.removeEventListener('prism-identity-changed', onIdentityChange);
}, [clearAll]);
```

Import `useEffect` from React at the top of the file.

- [ ] **Step 3: Run tests**

Run: `cd frontend && npx vitest run src/contexts/AskAiDrawerContext.test.tsx`
Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/contexts/AskAiDrawerContext.tsx frontend/src/contexts/AskAiDrawerContext.test.tsx
git commit -m "feat(pr8): AskAiDrawerProvider clears threads on prism-identity-changed"
```

---

## Task 9: App.tsx wiring — mount provider + drawer + effects

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add provider + components to App tree**

Edits to `App.tsx`:

1. Add imports near the top:
```tsx
import { AskAiDrawerProvider } from './contexts/AskAiDrawerContext';
import { AskAiDrawer } from './components/AskAiDrawer/AskAiDrawer';
import { DrawerEffects } from './components/AskAiDrawer/DrawerEffects';
```

2. In the `tree` JSX, add `<AskAiDrawer />` and `<DrawerEffects />` as siblings of `<PrTabStrip />`:

```tsx
const tree: ReactNode = (
  <>
    <Header hasToken={authState.hasToken} />
    <PrTabStrip />
    <AskAiDrawer />
    <DrawerEffects />
    <TabSignals />
    <Routes>
      {/* unchanged */}
    </Routes>
    <ToastContainer />
    <Cheatsheet />
  </>
);
```

3. Wrap `AskAiDrawerProvider` inside `OpenTabsProvider`:

```tsx
return (
  <ErrorBoundary>
    <ToastProvider>
      <CheatsheetProvider>
        <OpenTabsProvider>
          <AskAiDrawerProvider>
            {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
          </AskAiDrawerProvider>
        </OpenTabsProvider>
      </CheatsheetProvider>
    </ToastProvider>
  </ErrorBoundary>
);
```

- [ ] **Step 2: Run the full vitest suite to surface any cascading failures**

Run: `cd frontend && npx vitest run`
Expected: previously-passing tests still PASS. Failures here are Task 10's scope (test wrappers).

- [ ] **Step 3: Commit (even with failures noted — they're addressed in Task 10)**

```bash
git add frontend/src/App.tsx
git commit -m "feat(pr8): mount AskAiDrawerProvider + AskAiDrawer + DrawerEffects in App.tsx"
```

---

## Task 10: Rewire AskAiButton to toggle + delete AskAiEmptyState + update test wrappers

**Files:**
- Modify: `frontend/src/components/PrDetail/PrHeader.tsx`
- Delete: `frontend/src/components/PrDetail/AskAiEmptyState.tsx`
- Delete: `frontend/src/components/PrDetail/AskAiEmptyState.test.tsx` (verify exists first)
- Modify: every test file that renders a component which now consumes `useAskAiDrawer()` indirectly

- [ ] **Step 1: Find all test files that need the provider wrap**

Use Grep to find tests that wrap with `OpenTabsProvider` or render `PrHeader` / `PrDetailPage` / `AskAiButton`:

```bash
# Run this command and list affected files:
grep -rln "OpenTabsProvider\|<PrHeader\|<PrDetailPage\|<AskAiButton" frontend/src --include='*.test.tsx'
grep -rln "OpenTabsProvider\|<PrHeader\|<PrDetailPage\|<AskAiButton" frontend/__tests__ --include='*.test.tsx' 2>/dev/null || true
```

Capture the list of files. For each file, the wrapper needs `AskAiDrawerProvider` added — either alongside `OpenTabsProvider` or as a sole wrap if the file doesn't currently use providers.

- [ ] **Step 2: Modify PrHeader.tsx**

```tsx
// PrHeader.tsx — remove the import:
// import { AskAiEmptyState } from './AskAiEmptyState';

// Add import:
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';

// Inside PrHeader function, REPLACE:
//   const [askAiOpen, setAskAiOpen] = useState(false);
// WITH:
const { toggle: toggleAskAi } = useAskAiDrawer();

// REPLACE:
//   <AskAiButton aiPreview={aiPreview} onClick={() => setAskAiOpen(true)} />
// WITH:
<AskAiButton aiPreview={aiPreview} onClick={toggleAskAi} />

// REMOVE the inline render:
//   <AskAiEmptyState open={askAiOpen} onClose={() => setAskAiOpen(false)} />
```

Verify the import `useState` is still needed (it likely is for other state in PrHeader; only remove if unused).

- [ ] **Step 3: Delete AskAiEmptyState files**

```bash
git rm frontend/src/components/PrDetail/AskAiEmptyState.tsx
# Only if the test file exists:
test -f frontend/src/components/PrDetail/AskAiEmptyState.test.tsx && git rm frontend/src/components/PrDetail/AskAiEmptyState.test.tsx || true
```

- [ ] **Step 4: Update each affected test file**

For each file flagged in Step 1, wrap the render tree with `AskAiDrawerProvider`. Pattern:

```tsx
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
// or adjust relative path per file

// Where existing wrap is:
<OpenTabsProvider>
  <Component />
</OpenTabsProvider>

// Becomes:
<OpenTabsProvider>
  <AskAiDrawerProvider>
    <Component />
  </AskAiDrawerProvider>
</OpenTabsProvider>
```

If the test file doesn't currently use a provider but renders something that consumes `useAskAiDrawer()` (e.g., PrHeader directly), add the wrap.

- [ ] **Step 5: Run the full vitest suite**

Run: `cd frontend && npx vitest run`
Expected: full GREEN. Any remaining failure = a test file missed in Step 1; grep and fix.

- [ ] **Step 6: Commit**

```bash
git add -A frontend
git commit -m "feat(pr8): rewire AskAiButton to drawer toggle, delete AskAiEmptyState, update test wrappers"
```

---

## Task 11: Playwright e2e — open → send → reply → close → reopen-preserved → identity clear

**Files:**
- Create: `frontend/e2e/ask-ai-drawer.spec.ts`

- [ ] **Step 1: Write the e2e spec**

```ts
// frontend/e2e/ask-ai-drawer.spec.ts
import { test, expect } from '@playwright/test';
import { setupAndOpenScenarioPr } from './helpers';

test.describe('Ask AI drawer', () => {
  test.beforeEach(async ({ page }) => {
    // The drawer requires aiPreview === true so AskAiButton renders.
    await page.addInitScript(() => {
      window.localStorage.setItem('prism:ai-preview-enabled', '1');
    });
  });

  test('open drawer, send a message, canned reply lands, preserved across close+reopen', async ({
    page,
  }) => {
    await setupAndOpenScenarioPr(page);
    // Enable aiPreview via the Settings page (assume helper or direct preferences PATCH).
    await page.request.patch('/api/preferences', {
      data: { 'ui.aiPreview': true },
    });
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]', { timeout: 10_000 });

    const askAi = page.getByRole('button', { name: /ask ai/i });
    await expect(askAi).toBeVisible();
    await askAi.click();

    const drawer = page.getByTestId('ask-ai-drawer');
    await expect(drawer).toHaveClass(/isOpen/);
    await expect(page.getByText('Ask anything about this PR.')).toBeVisible();

    const composer = drawer.getByRole('textbox', { name: 'Message' });
    await composer.fill('Why this change?');
    await drawer.getByRole('button', { name: 'Send' }).click();

    await expect(drawer.getByText('Why this change?')).toBeVisible();
    await expect(drawer.getByTestId('ai-typing-indicator')).toBeVisible();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible({ timeout: 5_000 });

    // Close + reopen — thread persists.
    await drawer.getByRole('button', { name: /close ask ai drawer/i }).click();
    await expect(drawer).not.toHaveClass(/isOpen/);
    await askAi.click();
    await expect(drawer.getByText('Why this change?')).toBeVisible();
    await expect(drawer.getByText(/AI is not connected\./)).toBeVisible();
  });

  test('navigating away from PR Detail auto-closes drawer; thread preserved on return', async ({
    page,
  }) => {
    await setupAndOpenScenarioPr(page);
    await page.request.patch('/api/preferences', { data: { 'ui.aiPreview': true } });
    await page.reload();
    await page.waitForSelector('[data-testid="pr-header"]', { timeout: 10_000 });
    await page.getByRole('button', { name: /ask ai/i }).click();

    const drawer = page.getByTestId('ask-ai-drawer');
    await drawer.getByRole('textbox', { name: 'Message' }).fill('preserved?');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect(drawer.getByText(/AI isn't available right now\./)).toBeVisible({ timeout: 5_000 });

    // Nav to Inbox.
    await page.getByRole('link', { name: /inbox/i }).click();
    await expect(drawer).not.toHaveClass(/isOpen/);

    // Nav back to PR Detail via the open tab.
    await page.getByRole('button', { name: /acme\/api/i }).click();
    await expect(drawer).not.toHaveClass(/isOpen/); // No auto-reopen.
    await page.getByRole('button', { name: /ask ai/i }).click();
    await expect(drawer.getByText('preserved?')).toBeVisible();
    await expect(drawer.getByText(/AI is not connected\./)).toBeVisible();
  });
});
```

(Adjust `setupAndOpenScenarioPr` import path + the Inbox/tab navigation selectors to match the helpers established in PR7.)

- [ ] **Step 2: Run the e2e**

Run: `cd frontend && npx playwright test e2e/ask-ai-drawer.spec.ts --project=chromium`
Expected: 2 specs PASS.

- [ ] **Step 3: Fix flakes one at a time**

If the canned-reply timeout is fragile, replace fixed `timeout: 5_000` with `toBeVisible({ timeout: 5_000 })` polling. Do NOT add fixed `waitForTimeout` ceilings — per memory `feedback_windows_ci_fixed_delay_flake.md`.

- [ ] **Step 4: Commit**

```bash
git add frontend/e2e/ask-ai-drawer.spec.ts
git commit -m "test(pr8): Playwright e2e — drawer open/send/reply/close/reopen + nav-preserved"
```

---

## Task 12: Parity baseline capture (`ask-ai-drawer.png`)

**Files:**
- Modify: `frontend/e2e/parity-baselines.spec.ts`
- Create: `frontend/e2e/parity-baselines/ask-ai-drawer.png` (generated by `--update-snapshots`)

- [ ] **Step 1: Find current state of `parity-baselines.spec.ts`**

Grep for the `ask-ai-drawer` zone — it's likely `test.fixme` from PR1's groundwork.

```bash
grep -n 'ask-ai-drawer' frontend/e2e/parity-baselines.spec.ts
```

- [ ] **Step 2: Un-fixme + add capture steps**

Replace the fixme'd spec with the active capture. Pattern (adjust to match PR1's spec shape):

```ts
test('ask-ai-drawer', async ({ page }) => {
  await setupAndOpenScenarioPr(page);
  await page.request.patch('/api/preferences', { data: { 'ui.aiPreview': true } });
  await page.reload();
  await page.waitForSelector('[data-testid="pr-header"]');
  await page.getByRole('button', { name: /ask ai/i }).click();

  const drawer = page.getByTestId('ask-ai-drawer');
  await expect(drawer).toHaveClass(/isOpen/);

  // Seed two user messages + one AI reply (cycle through pendings).
  await drawer.getByRole('textbox', { name: 'Message' }).fill('Why this change?');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByText(/AI isn't available right now\./).first()).toBeVisible({ timeout: 5_000 });

  await drawer.getByRole('textbox', { name: 'Message' }).fill('What about tests?');
  await drawer.getByRole('button', { name: 'Send' }).click();
  await expect(drawer.getByText(/exercise the changed lines/)).toBeVisible({ timeout: 5_000 });

  await expect(drawer).toHaveScreenshot('ask-ai-drawer.png');
});
```

- [ ] **Step 3: Generate the baseline image**

Run: `cd frontend && npx playwright test e2e/parity-baselines.spec.ts -g "ask-ai-drawer" --update-snapshots --project=chromium`
Expected: image written to `frontend/e2e/parity-baselines/ask-ai-drawer.png`.

- [ ] **Step 4: Run again without `--update-snapshots` to confirm stability**

Run: `cd frontend && npx playwright test e2e/parity-baselines.spec.ts -g "ask-ai-drawer" --project=chromium`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/e2e/parity-baselines.spec.ts frontend/e2e/parity-baselines/ask-ai-drawer.png
git commit -m "test(pr8): parity baseline ask-ai-drawer.png — drawer with 2 user + 2 AI msgs"
```

---

## Task 13: Pre-push checklist + side-by-side capture

- [ ] **Step 1: Frontend lint + build (full)**

Run: `cd frontend && npm run lint && npm run build`
Expected: both GREEN.

- [ ] **Step 2: Backend build + test**

Run: `dotnet build --configuration Release` (timeout 300s)
Run: `dotnet test --no-build --configuration Release` (timeout 300s)
Expected: GREEN.

- [ ] **Step 3: Full vitest run**

Run: `cd frontend && npx vitest run`
Expected: GREEN (all suites incl. new + bulk-wrapped existing).

- [ ] **Step 4: Full Playwright run**

Run: `cd frontend && npx playwright test --project=chromium`
Expected: GREEN (incl. `ask-ai-drawer.spec.ts` + `parity-baselines.spec.ts`).

- [ ] **Step 5: Capture side-by-side handoff comparison**

Per `.ai/docs/design-handoff.md`. Open `design/handoff/PRism.html` to the Ask AI drawer view, capture, place next to the implementation drawer screenshot. Save under the same PR's documentation slot.

- [ ] **Step 6: Push branch + open PR via pr-autopilot**

Hand off to `pr-autopilot` skill.

---

## Self-Review

- [x] **Spec coverage:** § 4.8 Components / Mount / State / Behavior / Visuals / Accessibility / Header label / Removal of existing surface / v1-trial gating all mapped to tasks.
- [x] **Placeholder scan:** No `TBD`, no "implement later", no "similar to Task N". Every code step contains the actual code.
- [x] **Type consistency:** `ChatThread`, `ChatMessage`, `prRefKey`, `PrReference` consistent across tasks. `useAskAiDrawer()` API stable across Task 3, 4, 5, 6, 9, 10.
- [x] **Deferrals D71–D78** all surface in the relevant tasks (D71 non-modal: Task 4; D72 sibling mount: Task 9; D73 per-PR threads: Task 3; D74 setTimeout-binding: Task 3; D75 input cap: Task 3 + Task 6; D76 module reuse: Task 1; D77 identity wipe: Task 8; D78 toggle: Task 10).

## Execution Handoff

Use **subagent-driven-development** (recommended). Fresh implementer per task + spec compliance + code quality review.
