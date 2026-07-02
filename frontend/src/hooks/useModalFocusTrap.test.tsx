import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef } from 'react';
import { useModalFocusTrap, useScrimDismiss, FOCUSABLE_SELECTOR } from './useModalFocusTrap';

interface TrapHarnessProps {
  active: boolean;
  onEscape?: () => void;
  restoreFallbackSelector?: string;
  initialFocus?: () => HTMLElement | null;
}

// Dialog stays mounted while inactive (keep-alive shape) so the inert case can
// assert the hook does nothing for a mounted-but-inactive dialog.
function TrapHarness({
  active,
  onEscape,
  restoreFallbackSelector,
  initialFocus,
}: TrapHarnessProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocusTrap(dialogRef, { active, onEscape, restoreFallbackSelector, initialFocus });
  return (
    <div>
      <button data-testid="opener">open</button>
      <button data-testid="fallback">fallback landmark</button>
      <div ref={dialogRef} data-testid="dialog">
        <button data-testid="first">first</button>
        <button data-testid="middle" data-modal-role="middle">
          middle
        </button>
        <button data-testid="last">last</button>
      </div>
    </div>
  );
}

describe('useModalFocusTrap — initial focus', () => {
  it('focuses the first FOCUSABLE_SELECTOR match when no initialFocus is given', () => {
    render(<TrapHarness active />);
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('focuses the initialFocus() result when provided', () => {
    render(
      <TrapHarness
        active
        initialFocus={() => document.querySelector<HTMLElement>('[data-modal-role="middle"]')}
      />,
    );
    expect(screen.getByTestId('middle')).toHaveFocus();
  });

  it('falls back to the first focusable when initialFocus() returns null', () => {
    render(<TrapHarness active initialFocus={() => null} />);
    expect(screen.getByTestId('first')).toHaveFocus();
  });
});

describe('useModalFocusTrap — Tab trap', () => {
  it('Tab from the last element wraps to the first', () => {
    render(<TrapHarness active />);
    screen.getByTestId('last').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByTestId('first')).toHaveFocus();
  });

  it('Shift+Tab from the first element wraps to the last', () => {
    render(<TrapHarness active />);
    screen.getByTestId('first').focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByTestId('last')).toHaveFocus();
  });
});

describe('useModalFocusTrap — Escape routing', () => {
  it('calls onEscape on Escape and prevents default', () => {
    const onEscape = vi.fn();
    render(<TrapHarness active onEscape={onEscape} />);
    const notPrevented = fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(notPrevented).toBe(false);
  });

  it('ignores Escape entirely when onEscape is omitted (disableEscDismiss)', () => {
    render(<TrapHarness active />);
    const notPrevented = fireEvent.keyDown(document, { key: 'Escape' });
    expect(notPrevented).toBe(true);
  });

  it('reads onEscape through a latest ref (fresh closure per render, no re-subscribe)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<TrapHarness active onEscape={first} />);
    rerender(<TrapHarness active onEscape={second} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('useModalFocusTrap — capture and restore', () => {
  it('restores focus to the previously-focused opener on deactivate', () => {
    const { rerender } = render(<TrapHarness active={false} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    rerender(<TrapHarness active />);
    expect(screen.getByTestId('first')).toHaveFocus();
    rerender(<TrapHarness active={false} />);
    expect(opener).toHaveFocus();
  });

  it('restores to the fallback selector when the opener was document.body', () => {
    const { rerender } = render(
      <TrapHarness active={false} restoreFallbackSelector="[data-testid='fallback']" />,
    );
    (document.activeElement as HTMLElement | null)?.blur();
    rerender(<TrapHarness active restoreFallbackSelector="[data-testid='fallback']" />);
    rerender(<TrapHarness active={false} restoreFallbackSelector="[data-testid='fallback']" />);
    expect(screen.getByTestId('fallback')).toHaveFocus();
  });

  it('restores on unmount as well', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = render(<TrapHarness active />);
    expect(screen.getByTestId('first')).toHaveFocus();
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('useModalFocusTrap — inactive is inert', () => {
  it('does not steal focus, trap Tab, or route Escape while active is false', () => {
    const onEscape = vi.fn();
    render(<TrapHarness active={false} onEscape={onEscape} />);
    const opener = screen.getByTestId('opener');
    opener.focus();
    expect(opener).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(opener).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).not.toHaveBeenCalled();
  });
});

describe('FOCUSABLE_SELECTOR', () => {
  it('matches enabled controls and skips disabled/tabindex=-1 ones', () => {
    const host = document.createElement('div');
    host.innerHTML =
      '<button disabled>d</button><button>b</button><input disabled /><a href="#x">a</a><div tabindex="-1">t</div>';
    const matches = Array.from(host.querySelectorAll(FOCUSABLE_SELECTOR));
    expect(matches).toHaveLength(2);
  });
});

function ScrimHarness({ onDismiss }: { onDismiss: () => void }) {
  const scrim = useScrimDismiss(onDismiss);
  return (
    <div data-testid="scrim" onPointerDown={scrim.onPointerDown} onPointerUp={scrim.onPointerUp}>
      <div data-testid="pane">
        <button>inside</button>
      </div>
    </div>
  );
}

describe('useScrimDismiss', () => {
  it('fires onDismiss when pointer-down and pointer-up both hit the scrim itself', () => {
    const onDismiss = vi.fn();
    render(<ScrimHarness onDismiss={onDismiss} />);
    const scrim = screen.getByTestId('scrim');
    fireEvent.pointerDown(scrim);
    fireEvent.pointerUp(scrim);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire when pointer-down starts inside the pane and up lands on the scrim', () => {
    const onDismiss = vi.fn();
    render(<ScrimHarness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('pane'));
    fireEvent.pointerUp(screen.getByTestId('scrim'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does NOT fire when pointer-down starts on the scrim and up lands inside the pane (drag)', () => {
    const onDismiss = vi.fn();
    render(<ScrimHarness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('scrim'));
    fireEvent.pointerUp(screen.getByTestId('pane'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('uses the freshest onDismiss closure (identity may churn per render)', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<ScrimHarness onDismiss={first} />);
    rerender(<ScrimHarness onDismiss={second} />);
    const scrim = screen.getByTestId('scrim');
    fireEvent.pointerDown(scrim);
    fireEvent.pointerUp(scrim);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
