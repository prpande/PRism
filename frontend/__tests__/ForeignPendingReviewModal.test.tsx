import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ForeignPendingReviewModal } from '../src/components/PrDetail/ForeignPendingReviewModal/ForeignPendingReviewModal';
import type { SubmitForeignPendingReviewEvent } from '../src/api/types';

const snapshot: SubmitForeignPendingReviewEvent = {
  prRef: 'o/r/1',
  pullRequestReviewId: 'PRR_x',
  commitOid: 'abc1234',
  createdAt: '2026-05-11T08:00:00Z',
  threadCount: 3,
  replyCount: 2,
};

function renderModal(overrides: Partial<Parameters<typeof ForeignPendingReviewModal>[0]> = {}) {
  const props = {
    open: true,
    snapshot,
    onResume: vi.fn(),
    onDiscard: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<ForeignPendingReviewModal {...props} />) };
}

describe('ForeignPendingReviewModal', () => {
  it('renders counts copy: "3 thread(s) and 2 reply(ies)"', () => {
    renderModal();
    expect(screen.getByText(/3 thread/i)).toBeInTheDocument();
    expect(screen.getByText(/2 repl/i)).toBeInTheDocument();
  });

  it('renders the humanized createdAt timestamp', () => {
    renderModal();
    // The exact locale string is environment-dependent; assert the year shows up.
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it('renders three buttons: Resume / Discard… / Cancel', () => {
    renderModal();
    expect(screen.getByRole('button', { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /discard/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeInTheDocument();
  });

  it('default focus is on Cancel', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /cancel/i }));
  });

  it('Resume click fires onResume with the pullRequestReviewId', () => {
    const onResume = vi.fn();
    renderModal({ onResume });
    fireEvent.click(screen.getByRole('button', { name: /^resume$/i }));
    expect(onResume).toHaveBeenCalledWith('PRR_x');
  });

  it('Discard… opens the DiscardConfirmationSubModal with the count copy', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(screen.getByText(/3 thread/i)).toBeInTheDocument();
    expect(screen.getByText(/2 repl/i)).toBeInTheDocument();
  });

  it('confirming the sub-modal fires onDiscard with the pullRequestReviewId', () => {
    const onDiscard = vi.fn();
    renderModal({ onDiscard });
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(onDiscard).toHaveBeenCalledWith('PRR_x');
  });

  it('cancelling the sub-modal returns to the primary modal without calling onDiscard', () => {
    const onDiscard = vi.fn();
    renderModal({ onDiscard });
    fireEvent.click(screen.getByRole('button', { name: /discard/i }));
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onDiscard).not.toHaveBeenCalled();
    // Back to the primary modal — Resume is visible again.
    expect(screen.getByRole('button', { name: /^resume$/i })).toBeInTheDocument();
  });

  // R14: Esc dismisses to Cancel semantics (disableEscDismiss=false) — distinct
  // from SubmitDialog where Esc only moves focus.
  it('Esc dismisses to onCancel', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <ForeignPendingReviewModal
        open={false}
        snapshot={snapshot}
        onResume={vi.fn()}
        onDiscard={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // R15: width contract — the modal uses the shared <Modal> shell, whose
  // .modal-dialog carries the 480px default in tokens.css (no .submit-dialog
  // child → the 720px override doesn't apply). jsdom doesn't load tokens.css,
  // so this pins the structural hook the width rule keys on.
  it('renders inside the .modal-dialog shell without the .submit-dialog 720px override hook', () => {
    renderModal();
    const dialog = document.querySelector('.modal-dialog');
    expect(dialog).not.toBeNull();
    expect(dialog!.querySelector('.submit-dialog')).toBeNull();
  });
});
