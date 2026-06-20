// frontend/src/hooks/useAiHunkAnnotations.test.tsx
import { render, renderHook, waitFor } from '@testing-library/react';
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
  expect(result.current.e.state).toBe('error');
});

it('does NOT report on 401; still clears', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
  await waitFor(() => expect(result.current.e.state).toBe('empty'));
});

it('clears on success / 204→null', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue(null);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations'));
  await waitFor(() => expect(result.current.e.state).toBe('empty'));
});

it('is loading then ready when annotations arrive', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue([
    { path: 'a.ts', hunkIndex: 0, body: 'x', tone: 'calm' },
  ]);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  expect(result.current.e.state).toBe('loading');
  await waitFor(() => expect(result.current.e.state).toBe('ready'));
  expect(result.current.e.annotations).toHaveLength(1);
});

it('maps 204→null to empty, not error, and does not report', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockResolvedValue(null);
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.e.state).toBe('empty'));
  expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations');
});

it('is error and reports the bus on a non-401 throw', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(503, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.e.state).toBe('error'));
  expect(result.current.f.activeFailedSeams).toContain('hunk-annotations');
});

it('maps 401 to empty and does not report', async () => {
  vi.spyOn(api, 'getAiHunkAnnotations').mockRejectedValue(new ApiError(401, null, ''));
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, true), f: useAiFailure() }), {
    wrapper,
  });
  await waitFor(() => expect(result.current.e.state).toBe('empty'));
  expect(result.current.f.activeFailedSeams).not.toContain('hunk-annotations');
});

it('is empty when disabled', () => {
  const { result } = renderHook(() => ({ e: useAiHunkAnnotations(PR, false), f: useAiFailure() }), {
    wrapper,
  });
  expect(result.current.e.state).toBe('empty');
  expect(result.current.e.annotations).toBeNull();
});

it('never reports loading when disabled (no working-marker flash) and does not fetch', () => {
  const spy = vi.spyOn(api, 'getAiHunkAnnotations');
  spy.mockClear(); // prior tests in this file share the spy; count only this render's calls
  const states: string[] = [];
  function Probe() {
    states.push(useAiHunkAnnotations(PR, false).state);
    return null;
  }
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureProvider>
        <Probe />
      </AiFailureProvider>
    </MemoryRouter>,
  );
  // The lazy initializer starts in 'empty' for a gated-off hook, so 'loading' is never
  // rendered — without it the first render would flash 'loading' before the effect.
  expect(states).not.toContain('loading');
  expect(states.at(-1)).toBe('empty');
  expect(spy).not.toHaveBeenCalled();
});
