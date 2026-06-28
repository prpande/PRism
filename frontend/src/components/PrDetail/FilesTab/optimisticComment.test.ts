import { describe, it, expect } from 'vitest';
import {
  pruneOptimistic,
  OPTIMISTIC_FALLBACK_MAX_AGE_MS,
  type OptimisticComment,
} from './optimisticComment';

const CREATED_MS = Date.parse('2026-06-28T00:00:00Z');

function opt(over: Partial<OptimisticComment> = {}): OptimisticComment {
  return {
    clientId: 'client-1',
    threadId: 't1',
    body: 'my optimistic comment',
    author: 'You',
    createdAt: new Date(CREATED_MS).toISOString(),
    createdGen: 1,
    postedCommentId: 4242,
    ...over,
  };
}

describe('pruneOptimistic', () => {
  it('fast-path: drops a placeholder whose postedCommentId matches a real databaseId (regardless of age/gen)', () => {
    const prev = [opt()];
    const real = [{ databaseId: 4242 }];
    // currentGen === createdGen (no refetch counted) and nowMs == createdMs (not
    // aged) — the databaseId match alone must evict.
    const next = pruneOptimistic(prev, real, 1, CREATED_MS);
    expect(next).toHaveLength(0);
  });

  it('fallback: evicts a null-databaseId placeholder once a refetch has landed AND it has aged past the bound', () => {
    const prev = [opt({ createdGen: 1 })];
    // Real comment surfaced WITHOUT a databaseId (real GitHub responses ship
    // databaseId: null) — the fast-path can never match it.
    const real = [{ databaseId: null }];
    const next = pruneOptimistic(
      prev,
      real,
      2, // a refetch landed after creation (2 > 1)
      CREATED_MS + OPTIMISTIC_FALLBACK_MAX_AGE_MS + 1, // aged past the bound
    );
    expect(next).toHaveLength(0);
  });

  it('fallback: keeps the placeholder when a refetch has landed but it has NOT yet aged out (no premature eviction / flicker)', () => {
    const prev = [opt({ createdGen: 1 })];
    const real = [{ databaseId: null }];
    const next = pruneOptimistic(
      prev,
      real,
      2, // refetch landed
      CREATED_MS + 1, // but not aged
    );
    expect(next).toBe(prev); // reference identity preserved
    expect(next).toHaveLength(1);
  });

  it('fallback: keeps an aged placeholder when NO refetch has landed since creation', () => {
    const prev = [opt({ createdGen: 5 })];
    const real = [{ databaseId: null }];
    const next = pruneOptimistic(
      prev,
      real,
      5, // same generation → no refetch landed after creation
      CREATED_MS + OPTIMISTIC_FALLBACK_MAX_AGE_MS + 1, // aged
    );
    expect(next).toHaveLength(1);
  });

  it('preserves reference identity when nothing is evicted', () => {
    const prev = [opt()];
    const next = pruneOptimistic(prev, [], 1, CREATED_MS);
    expect(next).toBe(prev);
  });

  it('treats an absent createdGen as generation 0 (any refetch counts as landed-after)', () => {
    const prev = [opt({ createdGen: undefined })];
    const real = [{ databaseId: null }];
    const next = pruneOptimistic(
      prev,
      real,
      1, // 1 > 0 → refetch landed
      CREATED_MS + OPTIMISTIC_FALLBACK_MAX_AGE_MS + 1,
    );
    expect(next).toHaveLength(0);
  });
});
