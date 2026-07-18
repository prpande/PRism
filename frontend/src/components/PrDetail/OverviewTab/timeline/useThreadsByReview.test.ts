import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useThreadsByReview } from './useThreadsByReview';
import type { ReviewThreadDto } from '../../../../api/types';

const thread = (over: Partial<ReviewThreadDto>): ReviewThreadDto => ({
  threadId: 't',
  filePath: 'src/Calc.cs',
  lineNumber: 1,
  isResolved: false,
  comments: [{ commentId: 'c', author: 'a', createdAt: '2026-01-01T00:00:00Z', body: 'b', editedAt: null }],
  ...over,
});

describe('useThreadsByReview', () => {
  it('groups threads by reviewDatabaseId', () => {
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 't1', reviewDatabaseId: 1 }),
        thread({ threadId: 't2', reviewDatabaseId: 2 }),
        thread({ threadId: 't3', reviewDatabaseId: 1 }),
      ]),
    );
    expect(result.current.get(1)?.map((t) => t.threadId)).toEqual(['t1', 't3']);
    expect(result.current.get(2)?.map((t) => t.threadId)).toEqual(['t2']);
  });

  it('omits threads with a null reviewDatabaseId', () => {
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 't1', reviewDatabaseId: null }),
        thread({ threadId: 't2', reviewDatabaseId: undefined }),
        thread({ threadId: 't3', reviewDatabaseId: 5 }),
      ]),
    );
    expect([...result.current.keys()]).toEqual([5]);
  });

  it("orders each review's threads by first-comment createdAt ascending", () => {
    const early = { commentId: 'c1', author: 'a', createdAt: '2026-01-01T00:00:00Z', body: 'b', editedAt: null };
    const late = { commentId: 'c2', author: 'a', createdAt: '2026-02-01T00:00:00Z', body: 'b', editedAt: null };
    const { result } = renderHook(() =>
      useThreadsByReview([
        thread({ threadId: 'late', reviewDatabaseId: 1, comments: [late] }),
        thread({ threadId: 'early', reviewDatabaseId: 1, comments: [early] }),
      ]),
    );
    expect(result.current.get(1)?.map((t) => t.threadId)).toEqual(['early', 'late']);
  });
});
