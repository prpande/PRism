import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DiscardPendingReviewConfirmationModal } from '../src/components/PrDetail/DiscardPendingReviewConfirmationModal';

function renderModal(
  overrides: Partial<Parameters<typeof DiscardPendingReviewConfirmationModal>[0]> = {},
) {
  const props = {
    open: true,
    discardInFlight: false,
    errorMessage: null as string | null,
    onCancel: vi.fn(),
    onDiscard: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DiscardPendingReviewConfirmationModal {...props} />) };
}

describe('DiscardPendingReviewConfirmationModal', () => {
  it('renders the title and both always-shown bullets', () => {
    renderModal();
    expect(
      screen.getByRole('heading', { name: /discard pending review on github\?/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/the pending review on github will be deleted, along with its threads/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your prism drafts and replies will be unstamped, ready to submit fresh/i),
    ).toBeInTheDocument();
  });

  // ── Normal state ─────────────────────────────────────────────────────────
  it('Normal: Discard (destructive, enabled) + Cancel (enabled)', () => {
    renderModal();
    const discard = screen.getByRole('button', { name: /^discard$/i });
    expect(discard).toBeEnabled();
    expect(discard.className).toMatch(/btn-danger/);
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    expect(cancel).toBeEnabled();
  });

  it('Normal: clicking Discard calls onDiscard', () => {
    const onDiscard = vi.fn();
    renderModal({ onDiscard });
    fireEvent.click(screen.getByRole('button', { name: /^discard$/i }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('Normal: clicking Cancel calls onCancel', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Normal: Esc dismisses to onCancel', () => {
    const onCancel = vi.fn();
    renderModal({ onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('default focus is on the Cancel button (destructive precedent)', () => {
    renderModal();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^cancel$/i }));
  });

  // ── discardInFlight state ────────────────────────────────────────────────
  it('discardInFlight: action button shows "Discarding…" and is disabled', () => {
    renderModal({ discardInFlight: true });
    const action = screen.getByTestId('confirm-discard-pending');
    expect(action).toHaveTextContent(/discarding…/i);
    expect(action).toBeDisabled();
  });

  it('discardInFlight: Cancel button is not rendered', () => {
    renderModal({ discardInFlight: true });
    expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^close$/i })).toBeNull();
  });

  it('discardInFlight: Esc does NOT dismiss (onCancel not called)', () => {
    const onCancel = vi.fn();
    renderModal({ discardInFlight: true, onCancel });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  // ── Failure state ────────────────────────────────────────────────────────
  it('Failure: shows the error row with the message', () => {
    renderModal({ errorMessage: 'network exploded' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/couldn't discard: network exploded\./i);
  });

  it('Failure: action button shows "Retry" (destructive, enabled) → onDiscard', () => {
    const onDiscard = vi.fn();
    renderModal({ errorMessage: 'boom', onDiscard });
    const retry = screen.getByTestId('confirm-discard-pending');
    expect(retry).toHaveTextContent(/^retry$/i);
    expect(retry).toBeEnabled();
    expect(retry.className).toMatch(/btn-danger/);
    fireEvent.click(retry);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it('Failure: cancel-side button shows "Close" → onCancel', () => {
    const onCancel = vi.fn();
    renderModal({ errorMessage: 'boom', onCancel });
    const close = screen.getByRole('button', { name: /^close$/i });
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Failure: still shows both bullets', () => {
    renderModal({ errorMessage: 'boom' });
    expect(
      screen.getByText(/the pending review on github will be deleted, along with its threads/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/your prism drafts and replies will be unstamped, ready to submit fresh/i),
    ).toBeInTheDocument();
  });

  // ── Shared-shell + closed contract ───────────────────────────────────────
  it('is a labelled modal dialog (aria-modal + aria-labelledby via the shared Modal)', () => {
    renderModal();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');
  });

  it('renders nothing when closed', () => {
    const { container } = render(
      <DiscardPendingReviewConfirmationModal
        open={false}
        discardInFlight={false}
        errorMessage={null}
        onCancel={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
