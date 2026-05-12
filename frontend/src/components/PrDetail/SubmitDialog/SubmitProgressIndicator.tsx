import type { SubmitProgressStep } from '../../../hooks/useSubmit';
import type { SubmitStep } from '../../../api/types';

// Submit-progress UI (spec § 8.3). Merges Phase A and Phase B into one
// component (R2): until BeginPendingReview succeeds, it's a single neutral row
// ("Checking pending review state…"); once Step 2 stamps the PendingReviewId,
// it re-renders to the 5-row checklist with Steps 1+2 pre-ticked. The
// container is aria-live="polite" so step transitions are announced.
interface Props {
  steps: SubmitProgressStep[];
}

const ROW_ORDER: SubmitStep[] = [
  'DetectExistingPendingReview',
  'BeginPendingReview',
  'AttachThreads',
  'AttachReplies',
  'Finalize',
];

const DONE_LABEL: Record<SubmitStep, string> = {
  DetectExistingPendingReview: 'Detected pending review state',
  BeginPendingReview: 'Created pending review',
  AttachThreads: 'Attached threads',
  AttachReplies: 'Attached replies',
  Finalize: 'Submitted',
};

const PENDING_LABEL: Record<SubmitStep, string> = {
  DetectExistingPendingReview: 'Detect pending review state',
  BeginPendingReview: 'Create pending review',
  AttachThreads: 'Attach threads',
  AttachReplies: 'Attach replies',
  Finalize: 'Finalize',
};

type RowState = 'done' | 'active' | 'pending' | 'failed';

const ICON: Record<RowState, string> = { done: '✓', active: '⏳', pending: '○', failed: '✗' };

function isPhaseB(steps: SubmitProgressStep[]): boolean {
  return steps.some((s) => s.step === 'BeginPendingReview' && s.status === 'Succeeded');
}

function rowFor(step: SubmitStep, steps: SubmitProgressStep[]): { state: RowState; text: string } {
  const s = steps.find((x) => x.step === step);
  // In Phase B, Steps 1 and 2 are by definition already succeeded.
  if ((step === 'DetectExistingPendingReview' || step === 'BeginPendingReview') && !s) {
    return { state: 'done', text: DONE_LABEL[step] };
  }
  if (!s) return { state: 'pending', text: PENDING_LABEL[step] };
  if (s.status === 'Failed') {
    const detail = s.errorMessage ? `: ${s.errorMessage}` : '';
    return { state: 'failed', text: `Submit failed${detail}` };
  }
  if (s.status === 'Succeeded') {
    if (step === 'AttachThreads')
      return { state: 'done', text: `Attached ${s.done} of ${s.total} threads` };
    if (step === 'AttachReplies')
      return { state: 'done', text: `Attached ${s.done} of ${s.total} replies` };
    return { state: 'done', text: DONE_LABEL[step] };
  }
  // Started / in flight.
  if (step === 'AttachThreads')
    return { state: 'active', text: `Attaching thread ${s.done + 1} of ${s.total}…` };
  if (step === 'AttachReplies')
    return { state: 'active', text: `Attaching reply ${s.done + 1} of ${s.total}…` };
  if (step === 'Finalize') return { state: 'active', text: 'Finalizing…' };
  return { state: 'active', text: PENDING_LABEL[step] };
}

export function SubmitProgressIndicator({ steps }: Props) {
  if (!isPhaseB(steps)) {
    // Step 1 / Step 2 can fail before BeginPendingReview succeeds — render a
    // failed row then, not the "checking…" spinner (which would contradict the
    // dialog's "Submit failed" title + Retry footer).
    const failed = steps.find((s) => s.status === 'Failed');
    return (
      <div className="submit-progress submit-progress--phase-a" aria-live="polite">
        <div className="submit-progress__row" data-state={failed ? 'failed' : 'active'}>
          <span className="submit-progress__icon" aria-hidden="true">
            {failed ? ICON.failed : ICON.active}
          </span>
          <span className="submit-progress__text">
            {failed
              ? `Submit failed${failed.errorMessage ? `: ${failed.errorMessage}` : ''}`
              : 'Checking pending review state…'}
          </span>
        </div>
      </div>
    );
  }
  return (
    <ul className="submit-progress submit-progress--checklist" aria-live="polite">
      {ROW_ORDER.map((step) => {
        const { state, text } = rowFor(step, steps);
        return (
          <li key={step} className="submit-progress__row" data-state={state} data-step={step}>
            <span className="submit-progress__icon" aria-hidden="true">
              {ICON[state]}
            </span>
            <span className="submit-progress__text">{text}</span>
          </li>
        );
      })}
    </ul>
  );
}
