import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { Modal } from '../src/components/Modal/Modal';

function Harness({
  defaultFocus,
  disableEscDismiss,
  onClose,
  initialOpen = true,
}: {
  defaultFocus?: 'primary' | 'cancel';
  disableEscDismiss?: boolean;
  onClose: () => void;
  initialOpen?: boolean;
}) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <>
      <button data-testid="trigger" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        open={open}
        title="Discard saved draft?"
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        defaultFocus={defaultFocus}
        disableEscDismiss={disableEscDismiss}
      >
        <p>Body</p>
        <button data-modal-role="cancel" data-testid="btn-cancel">
          Cancel
        </button>
        <button data-modal-role="primary" data-testid="btn-discard">
          Discard
        </button>
      </Modal>
    </>
  );
}

describe('Modal — focus management (spec § 5.5a)', () => {
  it('OnOpen_FocusMovesToDefaultButton — defaultFocus="primary"', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="primary" />);
    expect(document.activeElement).toBe(screen.getByTestId('btn-discard'));
  });

  it('OnOpen_FocusMovesToDefaultButton — defaultFocus="cancel"', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="cancel" />);
    expect(document.activeElement).toBe(screen.getByTestId('btn-cancel'));
  });

  it('TabKey_TrapsFocusInModal — Tab from last wraps to first', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="primary" />);
    // primary is the LAST button (Cancel comes first in DOM order).
    const cancel = screen.getByTestId('btn-cancel');
    const discard = screen.getByTestId('btn-discard');
    expect(document.activeElement).toBe(discard);

    fireEvent.keyDown(document, { key: 'Tab' });
    // From last (discard) → wraps to first (cancel).
    expect(document.activeElement).toBe(cancel);
  });

  it('TabKey_TrapsFocusInModal — Shift+Tab from first wraps to last', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="cancel" />);
    const cancel = screen.getByTestId('btn-cancel');
    const discard = screen.getByTestId('btn-discard');
    expect(document.activeElement).toBe(cancel);

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(discard);
  });

  it('EscKey_ClosesViaCancelAction', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} defaultFocus="cancel" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('OnClose_FocusReturnsToTrigger', () => {
    function ControlledHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button data-testid="trigger" onClick={() => setOpen(true)}>
            Open
          </button>
          <Modal open={open} title="t" onClose={() => setOpen(false)}>
            <button data-modal-role="primary" data-testid="btn-primary">
              OK
            </button>
          </Modal>
        </>
      );
    }
    render(<ControlledHarness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByTestId('btn-primary'));

    // Close via Esc.
    fireEvent.keyDown(document, { key: 'Escape' });
    // Focus restored.
    expect(document.activeElement).toBe(trigger);
  });
});

describe('Modal — disableEscDismiss (addendum A4)', () => {
  it('EscKey_Suppressed_WhenDisableEscDismissTrue', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} defaultFocus="primary" disableEscDismiss />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Tab still works when disableEscDismiss is true', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="primary" disableEscDismiss />);
    const cancel = screen.getByTestId('btn-cancel');
    const discard = screen.getByTestId('btn-discard');
    expect(document.activeElement).toBe(discard);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
  });
});

describe('Modal — ARIA contract', () => {
  it('renders role=dialog with aria-modal=true and aria-labelledby pointing at title', () => {
    render(<Harness onClose={vi.fn()} defaultFocus="primary" />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    const ariaLabelledBy = dialog.getAttribute('aria-labelledby');
    expect(ariaLabelledBy).toBeTruthy();
    expect(document.getElementById(ariaLabelledBy as string)?.textContent).toBe(
      'Discard saved draft?',
    );
  });

  it('returns null when open is false (no DOM presence)', () => {
    render(<Harness onClose={vi.fn()} initialOpen={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
