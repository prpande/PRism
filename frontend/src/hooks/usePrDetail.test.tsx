import { describe, test, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { PrReference } from '../api/types';
import { usePrDetail } from './usePrDetail';
import { makePrDetailDto, makePr } from '../../__tests__/helpers/prDetail';

// ---------------------------------------------------------------------------
// usePrDetail — real data-preservation contract (PR2 Task 8 / OQ6).
//
// This locks the contract the plan names and that usePrDetail.ts implements at
// lines 46-48 (data is only cleared on PR *navigation*, never on a same-PR
// reload) and 81-85 (a rejected fetch sets `error` and leaves `data` intact):
//
//   A rejected same-PR reload() keeps the prior `data` rendered and surfaces
//   `error`. It must NOT blank the kept-alive content.
//
// PrDetailView.freshness.test's OQ6 case mocks usePrDetail and therefore cannot
// exercise this; here we drive the REAL hook against a mocked api layer.
// ---------------------------------------------------------------------------

const { getPrDetailMock } = vi.hoisted(() => ({ getPrDetailMock: vi.fn() }));

vi.mock('../api/prDetail', () => ({
  getPrDetail: getPrDetailMock,
}));

// mark-viewed is a fire-and-forget best-effort POST after a successful fetch;
// stub it to a resolved no-op so it never touches the network or the assertions.
vi.mock('../api/markViewed', () => ({
  postMarkViewed: vi.fn().mockResolvedValue(undefined),
}));

const PR_REF: PrReference = { owner: 'acme', repo: 'api', number: 7 };

const PR_DETAIL = makePrDetailDto({
  pr: makePr({ reference: PR_REF, title: 'Keep-alive title', author: 'alice' }),
});

beforeEach(() => {
  getPrDetailMock.mockReset();
});

describe('usePrDetail — preservation on failed same-PR reload', () => {
  test('a rejected reload() keeps the prior data and surfaces the error', async () => {
    // First fetch succeeds.
    getPrDetailMock.mockResolvedValueOnce(PR_DETAIL);
    const { result } = renderHook(() => usePrDetail(PR_REF));

    await waitFor(() => expect(result.current.data).toEqual(PR_DETAIL));
    expect(result.current.error).toBeNull();

    // Next fetch (the focus-refetch) rejects.
    getPrDetailMock.mockRejectedValueOnce(new Error('network down'));
    // `await act(async …)` flushes the reload's scheduled effect + the rejected
    // fetch's microtask inside an act() scope, so the error state settles before
    // waitFor runs and React emits no "not wrapped in act" warning.
    await act(async () => {
      result.current.reload();
    });

    // The error surfaces...
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toBe('network down');
    // ...and the prior data is STILL preserved (not blanked) on same-PR reload.
    expect(result.current.data).toEqual(PR_DETAIL);
  });
});
