import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const submitFeedback = vi.hoisted(() => vi.fn());
vi.mock('../../api/feedback', () => ({ submitFeedback }));

import { FeedbackModal } from './FeedbackModal';

// Suppress Vitest's unhandledRejection tracking for tests that intentionally
// reject promises caught inside async handlers. mockRejectedValue creates a
// rejected promise that is briefly "unhandled" (one microtask tick) before the
// await+catch in onSubmit consumes it. Adding a second listener causes Vitest
// to skip its own unhandledRejection handler (see vitest init.js: "if there is
// another listener, assume that it's handled by user code"). Mirrors the pattern
// in frontend/src/api/feedback.test.ts.
const noop = () => {};

function renderModal(
  props: Partial<React.ComponentProps<typeof FeedbackModal>> & { onClose?: () => void } = {},
) {
  const merged = {
    onClose: vi.fn(),
    authed: true,
    host: 'https://github.com',
    routePattern: '/inbox',
    ...props,
  };
  return render(
    <MemoryRouter>
      <FeedbackModal {...merged} />
    </MemoryRouter>,
  );
}

async function fill() {
  await userEvent.type(screen.getByLabelText(/summary/i), 'It broke');
  await userEvent.type(screen.getByLabelText(/details/i), 'steps to repro');
}

describe('FeedbackModal', () => {
  beforeEach(() => {
    submitFeedback.mockReset();
    process.on('unhandledRejection', noop);
    (window as unknown as { prism?: unknown }).prism = {
      openExternal: vi.fn().mockResolvedValue(true),
    };
  });
  afterEach(() => {
    process.off('unhandledRejection', noop);
    delete (window as unknown as { prism?: unknown }).prism;
  });

  it('renders a labelled dialog titled "Send feedback"', () => {
    renderModal();
    const dialog = screen.getByRole('dialog', { name: /send feedback/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('submit is disabled until category, summary, and details are all filled', async () => {
    renderModal();
    const submit = screen.getByRole('button', { name: /send feedback/i });
    expect(submit).toBeDisabled();
    await fill();
    expect(submit).toBeEnabled();
  });

  it('gives initial focus to the first category radio (Bug)', () => {
    renderModal();
    expect(screen.getByRole('radio', { name: 'Bug' })).toHaveFocus();
  });

  it('shows the consent/secrets notice', () => {
    renderModal();
    expect(
      screen.getByText(/don't include tokens, secrets, or sensitive details/i),
    ).toBeInTheDocument();
  });

  it('success (201): shows "Filed as #N" and "Open in GitHub" calls openExternal(htmlUrl)', async () => {
    const openExternalSpy = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    submitFeedback.mockResolvedValue({
      outcome: 'created',
      issueNumber: 12,
      htmlUrl: 'https://github.com/prpande/PRism-feedback/issues/12',
    });
    renderModal();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByText(/filed as #12/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /open in github/i }));
    expect(openExternalSpy).toHaveBeenCalledWith(
      'https://github.com/prpande/PRism-feedback/issues/12',
    );
  });

  it('cannot-create: offers "Open on GitHub" that builds a prpande/PRism-feedback issues/new https URL', async () => {
    const openExternalSpy = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    submitFeedback.mockResolvedValue({ outcome: 'cannot-create' });
    renderModal();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    await userEvent.click(await screen.findByRole('button', { name: /open on github/i }));
    expect(openExternalSpy.mock.calls[0][0]).toMatch(
      /^https:\/\/github\.com\/prpande\/PRism-feedback\/issues\/new/,
    );
  });

  it('first-run (authed=false): skips submitFeedback and opens the prefilled link', async () => {
    const openExternalSpy = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    renderModal({ authed: false });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
    expect(openExternalSpy.mock.calls[0][0]).toMatch(/^https:/);
  });

  it('GHES (authed, non-github.com host): skips submitFeedback — enterprise PAT never sent to api.github.com', async () => {
    const openExternalSpy = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    renderModal({ authed: true, host: 'https://ghe.corp.example' });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  it('thrown error (5xx): shows role=alert and a Retry button', async () => {
    submitFeedback.mockRejectedValue(new Error('boom'));
    renderModal();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('Esc when form is dirty: does NOT call onClose, focuses Cancel', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.type(screen.getByLabelText(/summary/i), 'typed');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('Esc when form is clean: calls onClose', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the ✕ close button is clicked', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.click(screen.getByRole('button', { name: /close feedback/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Fix 1: Esc during in-flight must NOT close the modal
  it('Esc during in-flight: does NOT call onClose and dialog remains', async () => {
    const onClose = vi.fn();
    // Never-resolving promise keeps the modal in the in-flight state.
    submitFeedback.mockReturnValue(new Promise(() => {}));
    renderModal({ onClose });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    // Button text changes to "Sending…" confirming in-flight state.
    expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  // Fix 2: success-state "Open in GitHub" surfaces openExternal failure as error state
  it('success state: openExternal rejection → error state (role=alert)', async () => {
    const openExternalSpy = vi.fn().mockRejectedValue(new Error('shell blocked'));
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    submitFeedback.mockResolvedValue({
      outcome: 'created',
      issueNumber: 99,
      htmlUrl: 'https://github.com/prpande/PRism-feedback/issues/99',
    });
    renderModal();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    await screen.findByText(/filed as #99/i);
    await userEvent.click(screen.getByRole('button', { name: /open in github/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  // Fix 5: http://github.com (authed) must be treated as link-only, not API path
  it('http://github.com (authed): skips submitFeedback — http is not github.com API-eligible', async () => {
    const openExternalSpy = vi.fn().mockResolvedValue(true);
    (window as unknown as { prism: unknown }).prism = { openExternal: openExternalSpy };
    renderModal({ authed: true, host: 'http://github.com' });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /open on github/i }));
    expect(submitFeedback).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalledTimes(1);
  });

  // Comments 1+2: requestClose() guards scrim and ✕ the same way Esc does.

  it('scrim click while in-flight: onClose NOT called, dialog still present', async () => {
    const onClose = vi.fn();
    submitFeedback.mockReturnValue(new Promise(() => {})); // never resolves
    renderModal({ onClose });
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    // Confirm in-flight state.
    expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('feedback-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('scrim click when dirty (idle): onClose NOT called, Cancel focused', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.type(screen.getByLabelText(/summary/i), 'dirty');
    await userEvent.click(screen.getByTestId('feedback-scrim'));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('✕ click when dirty (idle): onClose NOT called, Cancel focused', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.type(screen.getByLabelText(/summary/i), 'dirty');
    await userEvent.click(screen.getByRole('button', { name: /close feedback/i }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('✕ is disabled while in-flight', async () => {
    submitFeedback.mockReturnValue(new Promise(() => {})); // never resolves
    renderModal();
    await fill();
    await userEvent.click(screen.getByRole('button', { name: /send feedback/i }));
    expect(screen.getByRole('button', { name: /sending/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /close feedback/i })).toBeDisabled();
  });

  it('Cancel closes directly when dirty (onClose called)', async () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    await userEvent.type(screen.getByLabelText(/summary/i), 'dirty');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
