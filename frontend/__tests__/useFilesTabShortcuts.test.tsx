import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useFilesTabShortcuts } from '../src/hooks/useFilesTabShortcuts';

function fireKey(key: string, target?: EventTarget) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true });
  if (target) {
    Object.defineProperty(event, 'target', { value: target });
  }
  document.dispatchEvent(event);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useFilesTabShortcuts', () => {
  it('calls onNextFile on j key', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    fireKey('j');
    expect(handlers.onNextFile).toHaveBeenCalledTimes(1);
  });

  it('calls onPrevFile on k key', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    fireKey('k');
    expect(handlers.onPrevFile).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleViewed on v key', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    fireKey('v');
    expect(handlers.onToggleViewed).toHaveBeenCalledTimes(1);
  });

  it('calls onToggleDiffMode on d key', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    fireKey('d');
    expect(handlers.onToggleDiffMode).toHaveBeenCalledTimes(1);
  });

  it('ignores keys when target is a textarea', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    const textarea = document.createElement('textarea');
    fireKey('j', textarea);
    expect(handlers.onNextFile).not.toHaveBeenCalled();
  });

  it('ignores keys when target is an input', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    const input = document.createElement('input');
    fireKey('j', input);
    expect(handlers.onNextFile).not.toHaveBeenCalled();
  });

  it('ignores keys when target is a select', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    const select = document.createElement('select');
    fireKey('j', select);
    expect(handlers.onNextFile).not.toHaveBeenCalled();
  });

  it('ignores keys when target is contenteditable', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    const div = document.createElement('div');
    div.setAttribute('contenteditable', 'true');
    fireKey('j', div);
    expect(handlers.onNextFile).not.toHaveBeenCalled();
  });

  it('unregisters handler on unmount', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    const { unmount } = renderHook(() => useFilesTabShortcuts(handlers));
    unmount();
    fireKey('j');
    expect(handlers.onNextFile).not.toHaveBeenCalled();
  });
});
