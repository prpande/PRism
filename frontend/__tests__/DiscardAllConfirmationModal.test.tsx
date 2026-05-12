import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DiscardAllConfirmationModal } from '../src/components/PrDetail/DiscardAllConfirmationModal';

function renderModal(overrides: Partial<Parameters<typeof DiscardAllConfirmationModal>[0]> = {}) {
  const props = {
    open: true,
    prState: 'closed' as const,
    threadCount: 2,
    replyCount: 1,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DiscardAllConfirmationModal {...props} />) };
}

describe('DiscardAllConfirmationModal', () => {
  it('lists the draft/reply counts and warns it cannot be undone', () => {
    renderModal({ threadCount: 2, replyCount: 1 });
    expect(screen.getByText(/2 draft comments? and 1 repl/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });

  it('singularizes draft / reply counts', () => {
    renderModal({ threadCount: 1, replyCount: 1, prState: 'closed' });
    expect(screen.getByText(/1 draft comment and 1 reply\b/i)).toBeInTheDocument();
  });

  it('names a summary-only / pending-review-only leftover instead of "0 draft(s) and 0 reply(ies)"', () => {
    const { unmount } = render(
      <DiscardAllConfirmationModal
        open
        prState="merged"
        threadCount={0}
        replyCount={0}
        hasPendingReview
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/pending review on github/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 draft/i)).toBeNull();
    unmount();
    render(
      <DiscardAllConfirmationModal
        open
        prState="closed"
        threadCount={0}
        replyCount={0}
        hasSummary
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/your draft summary/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 draft/i)).toBeNull();
  });

  it('names the actual PR state in the copy', () => {
    const { unmount } = render(
      <DiscardAllConfirmationModal
        open
        prState="closed"
        threadCount={1}
        replyCount={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/on this closed PR/i)).toBeInTheDocument();
    unmount();
    render(
      <DiscardAllConfirmationModal
        open
        prState="merged"
        threadCount={1}
        replyCount={0}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/on this merged PR/i)).toBeInTheDocument();
  });

  it('default focus is on Cancel (destructive precedent)', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }));
  });

  it('has the destructive primary button (btn-danger) for the confirm action', () => {
    renderModal();
    const confirm = screen.getByRole('button', { name: /^discard all$/i });
    expect(confirm.className).toMatch(/btn-danger/);
  });

  it('Confirm fires onConfirm; Cancel fires onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <DiscardAllConfirmationModal
        open
        prState="closed"
        threadCount={1}
        replyCount={0}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^discard all$/i }));
    expect(onConfirm).toHaveBeenCalled();
    rerender(
      <DiscardAllConfirmationModal
        open
        prState="closed"
        threadCount={1}
        replyCount={0}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('Esc dismisses to onCancel', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('is a labelled modal dialog (aria-modal + aria-labelledby via the shared Modal)', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <DiscardAllConfirmationModal
        open={false}
        prState="closed"
        threadCount={1}
        replyCount={1}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // R15: width contract — shared <Modal> shell, 480px default (no .submit-dialog).
  it('renders inside the .modal-dialog shell without the .submit-dialog 720px override hook', () => {
    renderModal();
    const dialog = document.querySelector('.modal-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('.submit-dialog')).toBeNull();
  });
});
