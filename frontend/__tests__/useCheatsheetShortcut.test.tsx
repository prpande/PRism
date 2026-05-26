import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useCheatsheetShortcut } from '../src/hooks/useCheatsheetShortcut';

function fireKey(opts: KeyboardEventInit & { key: string }, target?: EventTarget) {
  const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...opts });
  (target ?? document.body).dispatchEvent(ev);
  return ev;
}

describe('useCheatsheetShortcut', () => {
  it('toggles on ? when target is the document body', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    act(() => {
      fireKey({ key: '?' });
    });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('preventsDefault on ? outside a text-editing context', () => {
    renderHook(() =>
      useCheatsheetShortcut(
        () => {},
        false,
        () => {},
      ),
    );
    let ev: KeyboardEvent | null = null;
    act(() => {
      ev = fireKey({ key: '?' });
    });
    expect(ev!.defaultPrevented).toBe(true);
  });

  it('does NOT toggle on ? when target is a <textarea>', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    try {
      act(() => {
        fireKey({ key: '?' }, ta);
      });
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(ta);
    }
  });

  it('does NOT toggle on ? when target is inside a [data-composer="true"] subtree', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-composer', 'true');
    const inner = document.createElement('button');
    wrapper.appendChild(inner);
    document.body.appendChild(wrapper);
    try {
      act(() => {
        fireKey({ key: '?' }, inner);
      });
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(wrapper);
    }
  });

  it('does NOT toggle on ? when target is contenteditable', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    document.body.appendChild(div);
    try {
      act(() => {
        fireKey({ key: '?' }, div);
      });
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(div);
    }
  });

  it('does NOT toggle on ? when target is an <input type="text">', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    try {
      act(() => {
        fireKey({ key: '?' }, input);
      });
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(input);
    }
  });

  it('toggles on Cmd+/ regardless of focused element', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    try {
      act(() => {
        fireKey({ key: '/', metaKey: true }, ta);
      });
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(ta);
    }
  });

  it('toggles on Ctrl+/ regardless of focused element', () => {
    const toggle = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    try {
      act(() => {
        fireKey({ key: '/', ctrlKey: true }, ta);
      });
      expect(toggle).toHaveBeenCalledTimes(1);
    } finally {
      document.body.removeChild(ta);
    }
  });

  it('Esc when open calls close + stops propagation + preventsDefault', () => {
    const close = vi.fn();
    const stopProp = vi.fn();
    renderHook(() => useCheatsheetShortcut(() => {}, true, close));
    let ev: KeyboardEvent | null = null;
    act(() => {
      ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      Object.defineProperty(ev, 'stopPropagation', { value: stopProp });
      document.body.dispatchEvent(ev);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(stopProp).toHaveBeenCalled();
    expect(ev!.defaultPrevented).toBe(true);
  });

  it('Esc when NOT open does NOT call close', () => {
    const close = vi.fn();
    renderHook(() => useCheatsheetShortcut(() => {}, false, close));
    act(() => {
      fireKey({ key: 'Escape' });
    });
    expect(close).not.toHaveBeenCalled();
  });

  it('Cmd/Ctrl+R is NOT intercepted (reload pass-through)', () => {
    const toggle = vi.fn();
    const close = vi.fn();
    renderHook(() => useCheatsheetShortcut(toggle, true, close));
    let ev: KeyboardEvent | null = null;
    act(() => {
      ev = fireKey({ key: 'r', metaKey: true });
    });
    expect(toggle).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(ev!.defaultPrevented).toBe(false);
  });

  it('unregisters handler on unmount', () => {
    const toggle = vi.fn();
    const { unmount } = renderHook(() => useCheatsheetShortcut(toggle, false, () => {}));
    unmount();
    act(() => {
      fireKey({ key: '?' });
    });
    expect(toggle).not.toHaveBeenCalled();
  });
});
