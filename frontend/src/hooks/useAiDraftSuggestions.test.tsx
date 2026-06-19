// frontend/src/hooks/useAiDraftSuggestions.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiDraftSuggestions } from './useAiDraftSuggestions';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiDraftSuggestions';
import { ApiError } from '../api/client';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}>
    <AiFailureProvider>{children}</AiFailureProvider>
  </MemoryRouter>
);

it('is loading then ready when suggestions arrive', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockResolvedValue([
    { filePath: 'a.ts', lineNumber: 3, body: 'x' },
  ]);
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  expect(result.current.e.state).toBe('loading');
  await waitFor(() => expect(result.current.e.state).toBe('ready'));
  expect(result.current.e.suggestions).toHaveLength(1);
});

it('is error and reports the bus on a non-401 throw', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockRejectedValue(new ApiError(503, null, ''));
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.e.state).toBe('error'));
  expect(result.current.f.activeFailedSeams).toContain('draft-suggestions');
});

it('is empty when disabled', () => {
  const { result } = renderHook(
    () => ({ e: useAiDraftSuggestions(PR, false), f: useAiFailure() }),
    { wrapper },
  );
  expect(result.current.e.state).toBe('empty');
  expect(result.current.e.suggestions).toBeNull();
});

it('reports on any non-401 throw (the seam has no backend 503 path today — see spec)', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockRejectedValue(new ApiError(500, null, ''));
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('draft-suggestions'));
});

it('does NOT report on 401', async () => {
  vi.spyOn(api, 'getAiDraftSuggestions').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiDraftSuggestions(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.e.state).toBe('empty'));
  await waitFor(() =>
    expect(result.current.f.activeFailedSeams).not.toContain('draft-suggestions'),
  );
});
