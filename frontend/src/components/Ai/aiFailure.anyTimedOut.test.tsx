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
