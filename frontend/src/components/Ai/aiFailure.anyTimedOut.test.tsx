import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect } from 'vitest';
import { AiFailureProvider, useAiFailure } from './aiFailure';
import type { PrReference } from '../../api/types';

// Reuse the active-PR route setup from aiFailure.test.tsx: a MemoryRouter at /pr/o/r/1 makes
// prRef o/r/1 the active key (parsePrRoute resolves it via useEffectiveLocation).
const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };

function Probe() {
  const api = useAiFailure();
  return (
    <div>
      <span data-testid="any-timed-out">{String(api.anyTimedOut)}</span>
      <button onClick={() => api.report(PR, 'summary', { retry: () => {}, reason: 'timeout' })}>
        t
      </button>
      <button
        onClick={() => api.report(PR, 'file-focus', { retry: () => {}, reason: 'provider-error' })}
      >
        p
      </button>
      <button onClick={() => api.clearPr(PR)}>c</button>
    </div>
  );
}

describe('anyTimedOut', () => {
  it('is false with no failures, true when any active failed seam timed out, false after clear', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/o/r/1']}>
        <AiFailureProvider>
          <Probe />
        </AiFailureProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
    await act(async () => screen.getByText('p').click()); // provider-error only
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
    await act(async () => screen.getByText('t').click()); // add a timeout
    expect(screen.getByTestId('any-timed-out').textContent).toBe('true');
    await act(async () => screen.getByText('c').click()); // clear the PR
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
  });
});

// Pins the spec's deliberate decision: the dismissal fingerprint is `${activeKey}:${seams}` —
// reason-free. A reason change for the SAME seam set must NOT un-dismiss the toast (only a
// seam-set change or a retry/clear does). A regression that folded reason into the fingerprint
// would re-surface a dismissed toast on a same-seam escalation; this catches it.
function DismissProbe() {
  const api = useAiFailure();
  return (
    <div>
      <span data-testid="dismissed">{String(api.dismissed)}</span>
      <span data-testid="any-timed-out">{String(api.anyTimedOut)}</span>
      <button
        onClick={() => api.report(PR, 'summary', { retry: () => {}, reason: 'provider-error' })}
      >
        report-pe
      </button>
      <button onClick={() => api.report(PR, 'summary', { retry: () => {}, reason: 'timeout' })}>
        escalate
      </button>
      <button onClick={() => api.dismiss()}>dismiss</button>
    </div>
  );
}

describe('dismissal fingerprint excludes reason', () => {
  it('a same-seam reason escalation keeps the toast dismissed while anyTimedOut still flips true', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/o/r/1']}>
        <AiFailureProvider>
          <DismissProbe />
        </AiFailureProvider>
      </MemoryRouter>,
    );
    await act(async () => screen.getByText('report-pe').click()); // summary: provider-error
    await act(async () => screen.getByText('dismiss').click());
    expect(screen.getByTestId('dismissed').textContent).toBe('true');
    expect(screen.getByTestId('any-timed-out').textContent).toBe('false');
    // SAME seam set ('summary'), reason escalates to timeout. Fingerprint is reason-free → still dismissed,
    // but anyTimedOut reads the live failure map and flips true.
    await act(async () => screen.getByText('escalate').click());
    expect(screen.getByTestId('dismissed').textContent).toBe('true');
    expect(screen.getByTestId('any-timed-out').textContent).toBe('true');
  });
});
