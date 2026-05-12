import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventSource } from './useEventSource';
import {
  discardForeignPendingReview as discardForeignApi,
  resumeForeignPendingReview as resumeForeignApi,
  submitReview as submitReviewApi,
} from '../api/submit';
import type {
  PrReference,
  SubmitForeignPendingReviewEvent,
  SubmitProgressEvent,
  SubmitStaleCommitOidEvent,
  SubmitStep,
  SubmitStepStatus,
  Verdict,
} from '../api/types';

export interface SubmitProgressStep {
  step: SubmitStep;
  status: SubmitStepStatus;
  done: number;
  total: number;
  errorMessage?: string;
}

// Spec § 8.4. `stale-commit-oid` is deliberately distinct from `in-flight`:
// in that kind Cancel is re-enabled and the primary button is an explicit
// "Recreate and resubmit", not a spinner.
export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'in-flight'; steps: SubmitProgressStep[] }
  | { kind: 'success'; pullRequestReviewId: string }
  | { kind: 'failed'; failedStep: SubmitStep; errorMessage: string; steps: SubmitProgressStep[] }
  | { kind: 'foreign-pending-review-prompt'; snapshot: SubmitForeignPendingReviewEvent }
  | { kind: 'stale-commit-oid'; orphanCommitOid: string };

export interface UseSubmitResult {
  state: SubmitState;
  submit(verdict: Verdict): Promise<void>;
  retry(): Promise<void>;
  resumeForeignPendingReview(reviewId: string): Promise<void>;
  discardForeignPendingReview(reviewId: string): Promise<void>;
  reset(): void;
}

function prRefString(reference: PrReference): string {
  return `${reference.owner}/${reference.repo}/${reference.number}`;
}

function upsertStep(steps: SubmitProgressStep[], ev: SubmitProgressEvent): SubmitProgressStep[] {
  const next: SubmitProgressStep = {
    step: ev.step,
    status: ev.status,
    done: ev.done,
    total: ev.total,
    errorMessage: ev.errorMessage ?? undefined,
  };
  const idx = steps.findIndex((s) => s.step === ev.step);
  if (idx === -1) return [...steps, next];
  return steps.map((s, i) => (i === idx ? next : s));
}

export function useSubmit(reference: PrReference): UseSubmitResult {
  const [state, setState] = useState<SubmitState>({ kind: 'idle' });
  const stream = useEventSource();
  const prRef = prRefString(reference);

  // Multi-tab guard: SSE events only drive transitions when THIS tab's
  // submit() / retry() call has returned 200 OK (spec § 8.4). A foreign tab's
  // submit fans out the same prRef-scoped events; ignoring them keeps the
  // dialog lifecycle local to the initiating tab.
  const ownsActiveSubmit = useRef(false);
  // Last-confirmed verdict, so retry() (stale-commitOID recovery, post-failure
  // retry) re-fires with the same value without plumbing it back through props.
  const lastVerdictRef = useRef<Verdict | null>(null);

  useEffect(() => {
    if (!stream) return;
    const offs = [
      stream.on('submit-progress', (ev: SubmitProgressEvent) => {
        if (ev.prRef !== prRef || !ownsActiveSubmit.current) return;
        setState((prev) => {
          const baseSteps = prev.kind === 'in-flight' || prev.kind === 'failed' ? prev.steps : [];
          const steps = upsertStep(baseSteps, ev);
          if (ev.status === 'Failed') {
            ownsActiveSubmit.current = false;
            return {
              kind: 'failed',
              failedStep: ev.step,
              errorMessage: ev.errorMessage ?? '',
              steps,
            };
          }
          if (ev.step === 'Finalize' && ev.status === 'Succeeded') {
            ownsActiveSubmit.current = false;
            // The submit-* SSE payloads don't carry the new review id (threat-model
            // defense, spec § 7.4 / § 17 #2 / #26); the success "View on GitHub"
            // link targets the PR page instead. Recorded in the deferrals sidecar.
            return { kind: 'success', pullRequestReviewId: '' };
          }
          return { kind: 'in-flight', steps };
        });
      }),
      stream.on('submit-foreign-pending-review', (ev: SubmitForeignPendingReviewEvent) => {
        if (ev.prRef !== prRef || !ownsActiveSubmit.current) return;
        setState({ kind: 'foreign-pending-review-prompt', snapshot: ev });
      }),
      stream.on('submit-stale-commit-oid', (ev: SubmitStaleCommitOidEvent) => {
        if (ev.prRef !== prRef || !ownsActiveSubmit.current) return;
        // The orphan was already deleted + session stamps cleared server-side;
        // this kind is the user-consent gate for the resubmit, not the recreate
        // (spec § 12). Cancel stays enabled until the user clicks "Recreate and
        // resubmit", which fires retry().
        ownsActiveSubmit.current = false;
        setState({ kind: 'stale-commit-oid', orphanCommitOid: ev.orphanCommitOid });
      }),
    ];
    return () => offs.forEach((off) => off());
  }, [stream, prRef]);

  const fire = useCallback(
    async (verdict: Verdict) => {
      lastVerdictRef.current = verdict;
      ownsActiveSubmit.current = true;
      try {
        await submitReviewApi(reference, verdict);
        setState({ kind: 'in-flight', steps: [] });
      } catch (err) {
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' }); // 409 / 4xx return to idle; caller surfaces a toast
        throw err;
      }
    },
    [reference],
  );

  const submit = useCallback((verdict: Verdict) => fire(verdict), [fire]);

  const retry = useCallback(async () => {
    const verdict = lastVerdictRef.current;
    if (verdict === null) return;
    await fire(verdict);
  }, [fire]);

  const resumeForeignPendingReview = useCallback(
    async (reviewId: string) => {
      try {
        await resumeForeignApi(reference, reviewId);
        // Imports land in the session as Draft entries; the user adjudicates via
        // the Drafts tab, then re-clicks Submit Review. (spec § 11.1)
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' });
      } catch (err) {
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' });
        throw err;
      }
    },
    [reference],
  );

  const discardForeignPendingReview = useCallback(
    async (reviewId: string) => {
      try {
        await discardForeignApi(reference, reviewId);
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' });
      } catch (err) {
        ownsActiveSubmit.current = false;
        setState({ kind: 'idle' });
        throw err;
      }
    },
    [reference],
  );

  const reset = useCallback(() => {
    ownsActiveSubmit.current = false;
    setState({ kind: 'idle' });
  }, []);

  return { state, submit, retry, resumeForeignPendingReview, discardForeignPendingReview, reset };
}
