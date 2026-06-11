import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { pickAiUnavailableResponse } from '../components/AskAiDrawer/askAiUnavailableResponses';

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
  // inside each setThreads updater (see OpenTabsContext ref-mirror pattern).
  const threadsRef = useRef<ReadonlyMap<string, ChatThread>>(threads);

  // Track pending timeouts so clearAll, identity-change, and provider unmount
  // can drain them. Provider lifetime = App lifetime in production, so unmount
  // cleanup matters mostly for vitest StrictMode rerenders and any future
  // dev-time auth-state remount that swaps the App tree.
  const pendingTimeoutsRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const handles = pendingTimeoutsRef;
    return () => {
      for (const h of handles.current) clearTimeout(h);
      handles.current.clear();
    };
  }, []);

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
      // Capture the cycle index at submit time AND advance the ref synchronously,
      // so a same-tick sendMessage on a different PR (before this PR's 600ms
      // reply fires) sees the post-increment value and selects a different
      // canned response. The React-visible `cycleIndex` state is bumped later
      // (when the reply lands) so observers correlate it with "AI replied",
      // not "user submitted".
      const cycleIndexAtSend = cycleIndexRef.current;
      cycleIndexRef.current += 1;
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
        setCycleIndex((c) => c + 1);
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

  // identity-changed → wipe threads + close drawer + cancel pending timeouts.
  // Mirrors the OpenTabsContext pattern: api/events.ts WINDOW_EVENT_BRIDGE
  // re-dispatches every identity-changed SSE frame as a 'prism-identity-changed'
  // window event. AskAiDrawerProvider is mounted outside EventStreamProvider
  // in App.tsx, so the window bridge is the intended cross-provider API here.
  useEffect(() => {
    const onIdentityChange = () => clearAll();
    window.addEventListener('prism-identity-changed', onIdentityChange);
    return () => window.removeEventListener('prism-identity-changed', onIdentityChange);
  }, [clearAll]);

  // `threads` is in the deps even though it isn't in the value object: the
  // ref-mirror pattern means `getThread` always reads the latest data, but
  // consumers won't re-render to call it again unless the context value
  // identity changes. Including `threads` here re-creates the value object
  // on every Map mutation, which is the consumer-visible re-render trigger.
  const value = useMemo<AskAiDrawerContextValue>(
    () => ({ isOpen, cycleIndex, toggle, close, getThread, setInput, sendMessage, clearAll }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `threads` is an intentional memo-bust key: it re-creates the value on Map mutation (the consumer-visible re-render trigger), though it isn't read in the value object (#331)
    [isOpen, cycleIndex, threads, toggle, close, getThread, setInput, sendMessage, clearAll],
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
