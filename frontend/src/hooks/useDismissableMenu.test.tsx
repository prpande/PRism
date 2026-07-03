import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { useDismissableMenu } from './useDismissableMenu';

interface HarnessProps {
  initialOpen?: boolean;
  onCloseSpy?: () => void;
}

function Harness({ initialOpen = true, onCloseSpy }: HarnessProps) {
  const [open, setOpen] = useState(initialOpen);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismissableMenu({
    open,
    rootRef,
    returnFocusRef: triggerRef,
    onClose: () => {
      onCloseSpy?.();
      setOpen(false);
    },
  });
  return (
    <div>
      <button data-testid="outside">outside</button>
      <div ref={rootRef} data-testid="root">
        <button ref={triggerRef} data-testid="trigger" onClick={() => setOpen((o) => !o)}>
          trigger
        </button>
        {open && (
          <div role="menu" data-testid="menu">
            <button data-testid="item">item</button>
          </div>
        )}
      </div>
    </div>
  );
}

describe('useDismissableMenu — Escape', () => {
  it('closes on document-level Escape and returns focus to the trigger (deferred)', async () => {
    render(<Harness />);
    screen.getByTestId('item').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('menu')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('trigger')).toHaveFocus());
  });

  it('closes on Escape even when focus is outside the menu root', async () => {
    render(<Harness />);
    screen.getByTestId('outside').focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('menu')).toBeNull();
    await waitFor(() => expect(screen.getByTestId('trigger')).toHaveFocus());
  });

  it('does not preventDefault on the Escape keydown', () => {
    render(<Harness />);
    const notPrevented = fireEvent.keyDown(document, { key: 'Escape' });
    expect(notPrevented).toBe(true);
    expect(screen.queryByTestId('menu')).toBeNull();
  });

  it('ignores an Escape another widget already consumed (defaultPrevented)', () => {
    const onCloseSpy = vi.fn();
    render(<Harness onCloseSpy={onCloseSpy} />);
    const consumed = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    consumed.preventDefault();
    document.dispatchEvent(consumed);
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
  });
});

describe('useDismissableMenu — outside pointerdown', () => {
  it('closes on outside click WITHOUT stealing focus', async () => {
    render(<Harness />);
    const outside = screen.getByTestId('outside');
    await userEvent.click(outside);
    expect(screen.queryByTestId('menu')).toBeNull();
    // Flush any (wrongly) deferred focus return before asserting.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByTestId('trigger')).not.toHaveFocus();
  });

  it('ignores pointerdown inside the root boundary', async () => {
    const onCloseSpy = vi.fn();
    render(<Harness onCloseSpy={onCloseSpy} />);
    await userEvent.click(screen.getByTestId('item'));
    expect(onCloseSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('menu')).toBeInTheDocument();
  });
});

describe('useDismissableMenu — closed is inert', () => {
  it('installs no listeners while closed', async () => {
    const onCloseSpy = vi.fn();
    render(<Harness initialOpen={false} onCloseSpy={onCloseSpy} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    await userEvent.click(screen.getByTestId('outside'));
    expect(onCloseSpy).not.toHaveBeenCalled();
  });
});
