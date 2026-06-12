import { render, renderHook } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useFilesTabShortcuts } from './useFilesTabShortcuts';

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

  it('ignores keys when target is a child of a contenteditable ancestor', () => {
    const handlers = {
      onNextFile: vi.fn(),
      onPrevFile: vi.fn(),
      onToggleViewed: vi.fn(),
      onToggleDiffMode: vi.fn(),
    };
    renderHook(() => useFilesTabShortcuts(handlers));
    const container = document.createElement('div');
    container.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    container.appendChild(child);
    document.body.appendChild(container);
    try {
      fireKey('j', child);
      expect(handlers.onNextFile).not.toHaveBeenCalled();
    } finally {
      document.body.removeChild(container);
    }
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

// Originally co-located: the INPUT-guard must still let a radio inside the
// diff-view-toggle radiogroup fire (radios are input-like but the toggle is a
// keyboard target), while checkboxes and text fields stay suppressed.
function Harness({
  onToggleDiffMode,
  onNextFile,
}: {
  onToggleDiffMode: () => void;
  onNextFile: () => void;
}) {
  useFilesTabShortcuts({
    onNextFile,
    onPrevFile: () => {},
    onToggleViewed: () => {},
    onToggleDiffMode,
  });
  return (
    <div>
      <div role="radiogroup" className="diff-view-toggle">
        <input type="radio" data-testid="r" />
      </div>
      <input type="checkbox" data-testid="c" />
      <textarea data-testid="t" />
    </div>
  );
}

describe('useFilesTabShortcuts INPUT guard', () => {
  it('fires from a radiogroup radio but stays suppressed in checkboxes and text fields', () => {
    const onToggle = vi.fn();
    const onNext = vi.fn();
    const { getByTestId } = render(<Harness onToggleDiffMode={onToggle} onNextFile={onNext} />);

    getByTestId('r').focus();
    getByTestId('r').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    getByTestId('c').focus();
    getByTestId('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(onNext).not.toHaveBeenCalled();

    getByTestId('t').focus();
    getByTestId('t').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
