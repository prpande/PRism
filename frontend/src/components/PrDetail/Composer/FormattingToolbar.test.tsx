import { describe, it, expect, vi } from 'vitest';
import { useRef, useState } from 'react';
import { render, fireEvent, within, act } from '@testing-library/react';
import { FormattingToolbar } from './FormattingToolbar';
import type { FormattingHandle } from './formattingHandle';

function Harness({
  initialValue = 'hello',
  initialPreview = false,
  disabled = false,
  onChangeSpy,
}: {
  initialValue?: string;
  initialPreview?: boolean;
  disabled?: boolean;
  onChangeSpy?: (v: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [value, setValue] = useState(initialValue);
  const [previewMode, setPreviewMode] = useState(initialPreview);
  const handle: FormattingHandle = {
    textareaRef: ref,
    value,
    onChange: (v) => {
      setValue(v);
      onChangeSpy?.(v);
    },
    previewMode,
    onTogglePreview: () => setPreviewMode((p) => !p),
    disabled,
  };
  return (
    <div>
      <FormattingToolbar handle={handle} />
      {!previewMode && (
        <textarea
          ref={ref}
          aria-label="body"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      )}
    </div>
  );
}

describe('FormattingToolbar', () => {
  it('renders the Write | Preview control and a formatting toolbar with 10 buttons', () => {
    const { getByRole } = render(<Harness />);
    expect(getByRole('button', { name: 'Write' })).toBeTruthy();
    expect(getByRole('button', { name: 'Preview' })).toBeTruthy();
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    expect(within(toolbar).getAllByRole('button').length).toBe(10);
  });

  it('reflects the active view with aria-pressed', () => {
    const { getByRole } = render(<Harness />);
    expect(getByRole('button', { name: 'Write' }).getAttribute('aria-pressed')).toBe('true');
    expect(getByRole('button', { name: 'Preview' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('hides the format buttons in preview mode but keeps the Write | Preview control', () => {
    const { getByRole, queryByRole } = render(<Harness initialPreview />);
    expect(queryByRole('toolbar')).toBeNull();
    expect(getByRole('button', { name: 'Write' })).toBeTruthy();
  });

  it('disables the format buttons when the handle is disabled', () => {
    const { getByRole } = render(<Harness disabled />);
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    within(toolbar)
      .getAllByRole('button')
      .forEach((b) => expect((b as HTMLButtonElement).disabled).toBe(true));
    // Write | Preview stays enabled
    expect((getByRole('button', { name: 'Preview' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('applies a transform when a button is clicked and leaves focus on the textarea', () => {
    const onChangeSpy = vi.fn();
    const { getByRole, getByLabelText } = render(
      <Harness initialValue="" onChangeSpy={onChangeSpy} />,
    );
    const ta = getByLabelText('body') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
    fireEvent.click(getByRole('button', { name: /Bold/ }));
    expect(onChangeSpy).toHaveBeenCalledWith('****');
    expect(document.activeElement).toBe(ta);
  });

  it('roves focus with ArrowRight/Home/End', () => {
    const { getByRole } = render(<Harness />);
    const toolbar = getByRole('toolbar', { name: 'Formatting' });
    const buttons = within(toolbar).getAllByRole('button') as HTMLButtonElement[];
    buttons[0].focus();
    fireEvent.keyDown(toolbar, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(buttons[1]);
    fireEvent.keyDown(toolbar, { key: 'End' });
    expect(document.activeElement).toBe(buttons[buttons.length - 1]);
    fireEvent.keyDown(toolbar, { key: 'Home' });
    expect(document.activeElement).toBe(buttons[0]);
  });

  it('exposes the Write | Preview control as a single tab stop (roving)', () => {
    const { getByRole } = render(<Harness />);
    const write = getByRole('button', { name: 'Write' }) as HTMLButtonElement;
    const preview = getByRole('button', { name: 'Preview' }) as HTMLButtonElement;
    // Exactly one of the two view buttons is in the tab order at a time.
    expect([write.tabIndex, preview.tabIndex].sort()).toEqual([-1, 0]);
    // The active view (Write) holds the tab stop by default.
    expect(write.tabIndex).toBe(0);
    // ArrowRight moves the roving focus/stop to Preview.
    fireEvent.keyDown(getByRole('group', { name: 'Editor view' }), { key: 'ArrowRight' });
    expect(preview.tabIndex).toBe(0);
    expect(document.activeElement).toBe(preview);
  });

  it('keeps the caret after the controlled re-render so the next char lands in place', () => {
    const { getByRole, getByLabelText } = render(<Harness initialValue="x" />);
    const ta = getByLabelText('body') as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(1, 1); // caret after "x"
    fireEvent.click(getByRole('button', { name: /Bold/ }));
    // Empty-selection bold -> "x****" with the caret parked between the pair.
    // If the controlled re-render reset the caret, this next insert would misplace.
    ta.setRangeText('Z', ta.selectionStart, ta.selectionEnd, 'end');
    expect(ta.value).toBe('x**Z**');
  });
});

// A controllable ResizeObserver mock: capture the callback and let the test push
// a container width.
class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  cb: ResizeObserverCallback;
  el: Element | null = null;
  constructor(cb: ResizeObserverCallback) {
    this.cb = cb;
    MockResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.el = el;
  }
  unobserve() {}
  disconnect() {}
  emit(width: number) {
    this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

describe('FormattingToolbar — overflow', () => {
  it('collapses low-priority buttons into the "…" menu at a constrained width', () => {
    const orig = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const { getByRole } = render(<Harness />);
      act(() => {
        // ~5 buttons' worth of width -> the tail (strikethrough, task, …) overflows.
        MockResizeObserver.instances.at(-1)!.emit(180);
      });
      const toolbar = getByRole('toolbar', { name: 'Formatting' });
      // High-priority buttons stay visible; a More button appears.
      expect(within(toolbar).getByRole('button', { name: /Bold/ })).toBeTruthy();
      expect(getByRole('button', { name: /More formatting/i })).toBeTruthy();
      // Strikethrough (lowest priority) is no longer a direct toolbar button.
      expect(within(toolbar).queryByRole('button', { name: /Strikethrough/ })).toBeNull();
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = orig;
    }
  });

  it('shows no "…" button when everything fits', () => {
    const orig = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const { getByRole, queryByRole } = render(<Harness />);
      act(() => {
        MockResizeObserver.instances.at(-1)!.emit(2000);
      });
      expect(within(getByRole('toolbar')).getAllByRole('button').length).toBe(10);
      expect(queryByRole('button', { name: /More formatting/i })).toBeNull();
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = orig;
    }
  });

  it('keeps a tabbable stop after a shrink overflows the focused button (no keyboard trap)', () => {
    const orig = globalThis.ResizeObserver;
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver;
    try {
      const { getByRole } = render(<Harness />);
      act(() => {
        MockResizeObserver.instances.at(-1)!.emit(2000); // all 10 visible
      });
      const toolbar = getByRole('toolbar', { name: 'Formatting' });
      // Focus a low-priority button that will overflow, then shrink.
      within(toolbar)
        .getByRole('button', { name: /Strikethrough/ })
        .focus();
      act(() => {
        MockResizeObserver.instances.at(-1)!.emit(180); // tail overflows
      });
      // The active index was clamped: exactly one roving stop (a visible button or
      // the "…" trigger) still has tabIndex 0 — the toolbar is not stranded.
      const roving = [...within(toolbar).getAllByRole('button')] as HTMLButtonElement[];
      expect(roving.some((b) => b.tabIndex === 0)).toBe(true);
    } finally {
      (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = orig;
    }
  });
});
