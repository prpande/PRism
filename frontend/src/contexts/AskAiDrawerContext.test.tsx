import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { AskAiDrawerProvider, useAskAiDrawer, type ChatThread } from './AskAiDrawerContext';
import type { PrReference } from '../api/types';

const refA: PrReference = { owner: 'acme', repo: 'api', number: 1 };
const refB: PrReference = { owner: 'acme', repo: 'api', number: 2 };
const keyA = 'acme/api#1';
const keyB = 'acme/api#2';

// Touch the typed refs so the import isn't pruned by the linter — the keys
// derive from them logically and keeping the symbols documents the mapping.
void refA;
void refB;

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

describe('AskAiDrawerContext identity-change', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

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
