import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSubmitFlow } from './useSubmitFlow';
import { SubmitConflictError } from '../../api/submit';
import type { PrReference, ReviewSessionDto } from '../../api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error — mirrors the pattern in
// PrHeader.actions.test.tsx.
const {
  submitReviewMock,
  resumeForeignMock,
  discardForeignMock,
  discardAllMock,
  discardOwnMock,
  sendPatchMock,
} = vi.hoisted(() => ({
  submitReviewMock: vi.fn(),
  resumeForeignMock: vi.fn(),
  discardForeignMock: vi.fn(),
  discardAllMock: vi.fn(),
  discardOwnMock: vi.fn(),
  sendPatchMock: vi.fn(),
}));

// Real SubmitConflictError kept; only the network calls are stubbed so the
// catch handlers in useSubmitFlow run against real thrown error types.
vi.mock('../../api/submit', async () => {
  const actual = await vi.importActual<typeof import('../../api/submit')>('../../api/submit');
  return {
    ...actual,
    submitReview: (...args: unknown[]) => submitReviewMock(...args),
    resumeForeignPendingReview: (...args: unknown[]) => resumeForeignMock(...args),
    discardForeignPendingReview: (...args: unknown[]) => discardForeignMock(...args),
    discardAllDrafts: (...args: unknown[]) => discardAllMock(...args),
    discardOwnPendingReview: (...args: unknown[]) => discardOwnMock(...args),
  };
});

vi.mock('../../api/draft', () => ({
  sendPatch: (...args: unknown[]) => sendPatchMock(...args),
  getTabId: () => 'test-tab',
}));

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

function session(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
    ...overrides,
  };
}

function setup(opts: { session?: ReviewSessionDto | null } = {}) {
  const show = vi.fn();
  const onSessionRefetch = vi.fn();
  const hook = renderHook(() =>
    useSubmitFlow({
      reference: ref,
      session: 'session' in opts ? (opts.session ?? null) : session(),
      onSessionRefetch,
      show,
    }),
  );
  return { ...hook, show, onSessionRefetch };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendPatchMock.mockResolvedValue(undefined);
});

describe('useSubmitFlow — dialog state', () => {
  it('starts with the dialog closed; openDialog opens it', () => {
    const { result } = setup();
    expect(result.current.dialogOpen).toBe(false);
    act(() => result.current.openDialog());
    expect(result.current.dialogOpen).toBe(true);
  });

  it('closeDialog closes the dialog and resets the submit state to idle', async () => {
    submitReviewMock.mockResolvedValue(undefined);
    const { result } = setup({ session: session({ pendingReviewId: 'PRR_x' }) });
    await act(async () => result.current.onResume());
    expect(result.current.dialogOpen).toBe(true);
    expect(result.current.submitState.kind).toBe('in-flight');
    act(() => result.current.closeDialog());
    expect(result.current.dialogOpen).toBe(false);
    expect(result.current.submitState.kind).toBe('idle');
  });
});

describe('useSubmitFlow — resume flow (R3)', () => {
  it('onResume opens the dialog and re-fires submit with the persisted verdict', async () => {
    submitReviewMock.mockResolvedValue(undefined);
    const { result } = setup({
      session: session({ pendingReviewId: 'PRR_x', draftVerdict: 'approve' }),
    });
    await act(async () => result.current.onResume());
    expect(result.current.dialogOpen).toBe(true);
    expect(submitReviewMock).toHaveBeenCalledWith(ref, 'approve');
    // The POST is fire-and-forget server-side; the hook goes in-flight before it resolves.
    expect(result.current.submitState.kind).toBe('in-flight');
    // No SSE prompt was involved, so no resume summary is surfaced.
    expect(result.current.lastResume).toBeNull();
  });

  it('onResume defaults the verdict to comment when the session has none', async () => {
    submitReviewMock.mockResolvedValue(undefined);
    const { result } = setup({ session: session({ pendingReviewId: 'PRR_x' }) });
    await act(async () => result.current.onResume());
    expect(submitReviewMock).toHaveBeenCalledWith(ref, 'comment');
  });

  it('surfaces a per-code toast when the resume submit 409s (surfaceSubmitError path)', async () => {
    submitReviewMock.mockRejectedValue(new SubmitConflictError('head-sha-drift', 'server-said'));
    const { result, show } = setup({ session: session({ pendingReviewId: 'PRR_x' }) });
    await act(async () => result.current.onResume());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/head commit changed.*Reload the PR/i),
      }),
    );
    // useSubmit reverted the pre-pipeline rejection to idle.
    expect(result.current.submitState.kind).toBe('idle');
  });

  it('surfaces a generic error toast when submit throws a non-SubmitConflictError', async () => {
    submitReviewMock.mockRejectedValue(new Error('network down'));
    const { result, show } = setup({ session: session({ pendingReviewId: 'PRR_x' }) });
    await act(async () => result.current.onResume());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/unexpected error.*Try again/i),
      }),
    );
  });
});

describe('useSubmitFlow — onSubmit / onRetry wrap surfaceSubmitError', () => {
  it('onSubmit fires the submit POST with the chosen verdict', async () => {
    submitReviewMock.mockResolvedValue(undefined);
    const { result } = setup();
    await act(async () => result.current.onSubmit('request-changes'));
    expect(submitReviewMock).toHaveBeenCalledWith(ref, 'request-changes');
    expect(result.current.submitState.kind).toBe('in-flight');
  });

  it('onSubmit surfaces a 4xx via toast instead of an unhandled rejection', async () => {
    submitReviewMock.mockRejectedValue(new SubmitConflictError('no-session', 'server-said'));
    const { result, show } = setup();
    await act(async () => result.current.onSubmit('approve'));
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/no draft session for this PR/i),
      }),
    );
    expect(result.current.submitState.kind).toBe('idle');
  });

  it('onRetry re-fires with the last-confirmed verdict and surfaces failures via toast', async () => {
    submitReviewMock.mockResolvedValueOnce(undefined);
    const { result, show } = setup();
    await act(async () => result.current.onSubmit('approve'));
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('submit-in-progress', 'server-said'),
    );
    await act(async () => result.current.onRetry());
    expect(submitReviewMock).toHaveBeenLastCalledWith(ref, 'approve');
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/A submit is already in flight/i),
      }),
    );
  });
});

describe('useSubmitFlow — foreign pending review (spec § 11)', () => {
  it('onResumeForeignPendingReview closes the dialog synchronously, then imports + refetches', async () => {
    let resolveResume!: (v: { threadCount: number; replyCount: number; threads: never[] }) => void;
    resumeForeignMock.mockReturnValue(
      new Promise((res) => {
        resolveResume = res;
      }),
    );
    const { result, onSessionRefetch } = setup();
    act(() => result.current.openDialog());
    act(() => result.current.onResumeForeignPendingReview('PRR_foreign'));
    // Optimistic close BEFORE the POST resolves — no one-render form flash.
    expect(result.current.dialogOpen).toBe(false);
    expect(onSessionRefetch).not.toHaveBeenCalled();
    await act(async () => resolveResume({ threadCount: 1, replyCount: 2, threads: [] }));
    expect(resumeForeignMock).toHaveBeenCalledWith(ref, 'PRR_foreign');
    await waitFor(() => expect(onSessionRefetch).toHaveBeenCalled());
  });

  it('onDiscardForeignPendingReview closes the dialog and refetches on success', async () => {
    discardForeignMock.mockResolvedValue(undefined);
    const { result, onSessionRefetch } = setup();
    act(() => result.current.openDialog());
    await act(async () => result.current.onDiscardForeignPendingReview('PRR_foreign'));
    expect(result.current.dialogOpen).toBe(false);
    expect(discardForeignMock).toHaveBeenCalledWith(ref, 'PRR_foreign');
    await waitFor(() => expect(onSessionRefetch).toHaveBeenCalled());
  });

  it('surfaces the TOCTOU 409 (pending-review-state-changed) as a retry-submit toast', async () => {
    resumeForeignMock.mockRejectedValue(
      new SubmitConflictError('pending-review-state-changed', 'server-said'),
    );
    const { result, show, onSessionRefetch } = setup();
    await act(async () => result.current.onResumeForeignPendingReview('PRR_foreign'));
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/pending review state changed.*retry submit/i),
      }),
    );
    expect(onSessionRefetch).not.toHaveBeenCalled();
  });

  it('surfaces a generic error toast when a foreign-review action fails unexpectedly', async () => {
    discardForeignMock.mockRejectedValue(new Error('boom'));
    const { result, show } = setup();
    await act(async () => result.current.onDiscardForeignPendingReview('PRR_foreign'));
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/Could not complete that action on the pending review/i),
      }),
    );
  });
});

describe('useSubmitFlow — discard-all (spec § 13)', () => {
  it('onDiscardAllDrafts posts the discard and refetches the session on success', async () => {
    discardAllMock.mockResolvedValue(undefined);
    const { result, show, onSessionRefetch } = setup();
    await act(async () => result.current.onDiscardAllDrafts());
    expect(discardAllMock).toHaveBeenCalledWith(ref);
    await waitFor(() => expect(onSessionRefetch).toHaveBeenCalled());
    expect(show).not.toHaveBeenCalled();
  });

  it('surfaces an error toast and skips the refetch when the discard fails', async () => {
    discardAllMock.mockRejectedValue(new Error('boom'));
    const { result, show, onSessionRefetch } = setup();
    await act(async () => result.current.onDiscardAllDrafts());
    await waitFor(() =>
      expect(show).toHaveBeenCalledWith({
        kind: 'error',
        message: expect.stringMatching(/Could not discard the drafts/i),
      }),
    );
    expect(onSessionRefetch).not.toHaveBeenCalled();
  });
});

describe('useSubmitFlow — pill discard (spec § 4.9)', () => {
  it('success closes the pill modal, clears the error, and shows the optimistic toast', async () => {
    discardOwnMock.mockResolvedValue({ ok: true });
    const { result, show } = setup();
    act(() => result.current.openPillDiscardModal());
    expect(result.current.pillDiscardModalOpen).toBe(true);
    await act(async () => result.current.handlePillDiscard());
    expect(result.current.pillDiscardModalOpen).toBe(false);
    expect(result.current.pillDiscardError).toBeNull();
    expect(show).toHaveBeenCalledWith({ kind: 'info', message: 'Pending review discarded' });
  });

  it('failure keeps the modal open and surfaces the message with any trailing period stripped', async () => {
    discardOwnMock.mockResolvedValue({
      ok: false,
      code: 'github-forbidden',
      message: 'GitHub said no.',
    });
    const { result, show } = setup();
    act(() => result.current.openPillDiscardModal());
    await act(async () => result.current.handlePillDiscard());
    expect(result.current.pillDiscardModalOpen).toBe(true);
    // The modal appends its own period — a trailing one here would render "..".
    expect(result.current.pillDiscardError).toBe('GitHub said no');
    expect(show).not.toHaveBeenCalled();
  });

  it('cancelPillDiscard is a no-op mid-discard, then closes the modal and clears the error', async () => {
    // First attempt fails so there's an error state to clear on cancel.
    discardOwnMock.mockResolvedValueOnce({
      ok: false,
      code: 'github-forbidden',
      message: 'GitHub said no.',
    });
    const { result } = setup();
    act(() => result.current.openPillDiscardModal());
    await act(async () => result.current.handlePillDiscard());
    expect(result.current.pillDiscardError).toBe('GitHub said no');

    // Second attempt held in flight: cancel must leave the modal open.
    let resolveDiscard!: (r: { ok: false; code: string; message: string }) => void;
    discardOwnMock.mockReturnValueOnce(
      new Promise((res) => {
        resolveDiscard = res;
      }),
    );
    let inFlight!: Promise<void>;
    act(() => {
      inFlight = result.current.handlePillDiscard();
    });
    expect(result.current.discardInFlight).toBe(true);
    act(() => result.current.cancelPillDiscard());
    expect(result.current.pillDiscardModalOpen).toBe(true);

    // Once the discard settles, cancel closes the modal and clears the error.
    await act(async () => {
      resolveDiscard({ ok: false, code: 'github-forbidden', message: 'GitHub said no.' });
      await inFlight;
    });
    expect(result.current.discardInFlight).toBe(false);
    act(() => result.current.cancelPillDiscard());
    expect(result.current.pillDiscardModalOpen).toBe(false);
    expect(result.current.pillDiscardError).toBeNull();
  });
});

describe('useSubmitFlow — patchVerdict', () => {
  it('PATCHes the draft verdict and refetches the session', async () => {
    const { result, onSessionRefetch } = setup();
    await act(async () => result.current.patchVerdict('approve'));
    expect(sendPatchMock).toHaveBeenCalledWith(ref, { kind: 'draftVerdict', payload: 'approve' });
    await waitFor(() => expect(onSessionRefetch).toHaveBeenCalled());
  });
});
