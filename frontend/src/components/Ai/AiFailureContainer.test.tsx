// frontend/src/components/Ai/AiFailureContainer.test.tsx
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AiFailureProvider, useAiFailure } from './aiFailure';
import { AiFailureContainer } from './AiFailureContainer';
import type { PrReference } from '../../api/types';

const PR_A: PrReference = { owner: 'o', repo: 'r', number: 1 };
function harness(path = '/pr/o/r/1') {
  let api!: ReturnType<typeof useAiFailure>;
  function Grab() { api = useAiFailure(); return null; }
  render(
    <MemoryRouter initialEntries={[path]}>
      <AiFailureProvider><Grab /><AiFailureContainer /></AiFailureProvider>
    </MemoryRouter>,
  );
  return () => api;
}

it('live region pre-exists empty, populates on failure, empties on recovery', () => {
  const api = harness();
  const live = screen.getByTestId('ai-failure-live');
  expect(live).toHaveAttribute('aria-live', 'polite');
  expect(live.textContent).toBe('');
  act(() => { api().report(PR_A, 'summary', { retry: () => {} }); });
  expect(live.textContent).toBe('AI generation failed.');
  expect(screen.getByText(/AI couldn't generate: summary/)).toBeInTheDocument();
  act(() => { api().clear(PR_A, 'summary'); });
  expect(live.textContent).toBe('');
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
});

it('partial recovery does not change the live-region text (no re-announce)', () => {
  const api = harness();
  act(() => {
    api().report(PR_A, 'summary', { retry: () => {} });
    api().report(PR_A, 'file-focus', { retry: () => {} });
  });
  const live = screen.getByTestId('ai-failure-live');
  expect(live.textContent).toBe('AI generation failed.');
  act(() => { api().clear(PR_A, 'summary'); }); // 2 → 1 seam
  expect(live.textContent).toBe('AI generation failed.'); // unchanged → no new announcement
  expect(screen.getByText(/AI couldn't generate: hotspots/)).toBeInTheDocument();
});

it('hides the toast after dismiss until a new failure', () => {
  const api = harness();
  act(() => { api().report(PR_A, 'summary', { retry: () => {} }); });
  act(() => { api().dismiss(); });
  expect(screen.queryByText(/AI couldn't generate/)).toBeNull();
  act(() => { api().report(PR_A, 'file-focus', { retry: () => {} }); });
  expect(screen.getByText(/AI couldn't generate: summary, hotspots/)).toBeInTheDocument();
});
