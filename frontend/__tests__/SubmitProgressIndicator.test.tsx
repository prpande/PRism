import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SubmitProgressIndicator } from '../src/components/PrDetail/SubmitDialog/SubmitProgressIndicator';
import type { SubmitProgressStep } from '../src/hooks/useSubmit';

describe('SubmitProgressIndicator — merged Phase A / Phase B (R2)', () => {
  it('Phase A: no BeginPendingReview-Succeeded yet → a single neutral row, no checklist', () => {
    render(<SubmitProgressIndicator steps={[]} />);
    expect(screen.getByText(/Checking pending review state/i)).toBeInTheDocument();
    expect(screen.queryByText(/Attach threads/i)).not.toBeInTheDocument();
  });

  it('Phase A persists while Step 1 is in flight', () => {
    const steps: SubmitProgressStep[] = [
      { step: 'DetectExistingPendingReview', status: 'Started', done: 0, total: 1 },
    ];
    render(<SubmitProgressIndicator steps={steps} />);
    expect(screen.getByText(/Checking pending review state/i)).toBeInTheDocument();
  });

  it('Phase B: once BeginPendingReview Succeeded → the 5-row checklist with steps 1 and 2 ticked', () => {
    const steps: SubmitProgressStep[] = [
      { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
      { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
    ];
    render(<SubmitProgressIndicator steps={steps} />);
    expect(screen.queryByText(/Checking pending review state/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Detected pending review state/i)).toBeInTheDocument();
    expect(screen.getByText(/Created pending review/i)).toBeInTheDocument();
    expect(screen.getByText(/Attach threads/i)).toBeInTheDocument();
    expect(screen.getByText(/Attach replies/i)).toBeInTheDocument();
    expect(screen.getByText(/Finalize/i)).toBeInTheDocument();
  });

  it('Phase B mid-run: shows progress counts for the active rows', () => {
    const steps: SubmitProgressStep[] = [
      { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
      { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
      { step: 'AttachThreads', status: 'Succeeded', done: 3, total: 3 },
      { step: 'AttachReplies', status: 'Started', done: 0, total: 2 },
    ];
    render(<SubmitProgressIndicator steps={steps} />);
    expect(screen.getByText(/Attached 3 of 3 threads/i)).toBeInTheDocument();
    expect(screen.getByText(/Attaching reply 1 of 2/i)).toBeInTheDocument();
  });

  it('Phase B failure: the failed row shows ✗ + the error message', () => {
    const steps: SubmitProgressStep[] = [
      { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
      { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
      { step: 'AttachThreads', status: 'Failed', done: 1, total: 3, errorMessage: 'network blip' },
    ];
    render(<SubmitProgressIndicator steps={steps} />);
    expect(screen.getByText(/network blip/i)).toBeInTheDocument();
  });

  it('the container is an aria-live polite region in both phases', () => {
    const { rerender, container } = render(<SubmitProgressIndicator steps={[]} />);
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
    rerender(
      <SubmitProgressIndicator
        steps={[
          { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
          { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
        ]}
      />,
    );
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});
