// frontend/src/hooks/useAiHunkAnnotations.test.tsx
import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiHunkAnnotations } from './useAiHunkAnnotations';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiHunkAnnotations';
import { ApiError } from '../api/client';
import type { PrReference } from '../api/types';

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}>
    <AiFailureProvider>{children}</AiFailureProvider>
  </MemoryRouter>
);

it('reports a failure on 503', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(503, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('hunk-annotations'));
});

it('does NOT report on 401; still clears', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
});

it('clears on success / 204→null', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue(null);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
});
