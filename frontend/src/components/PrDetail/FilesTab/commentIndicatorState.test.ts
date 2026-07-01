import { describe, it, expect } from 'vitest';
import { deriveCommentStateByPath } from './commentIndicatorState';
import type { ReviewThreadDto } from '../../../api/types';

const thread = (filePath: string, isResolved: boolean): ReviewThreadDto => ({
  threadId: `${filePath}:${isResolved}`,
  filePath,
  lineNumber: 1,
  anchorSha: 'sha',
  isResolved,
  comments: [],
});

describe('deriveCommentStateByPath', () => {
  it('omits paths with no threads', () => {
    expect(deriveCommentStateByPath([]).size).toBe(0);
  });

  it('marks a path unresolved when it has an open thread', () => {
    const m = deriveCommentStateByPath([thread('a.ts', false)]);
    expect(m.get('a.ts')).toBe('unresolved');
  });

  it('marks a path resolved when all its threads are resolved', () => {
    const m = deriveCommentStateByPath([thread('a.ts', true), thread('a.ts', true)]);
    expect(m.get('a.ts')).toBe('resolved');
  });

  it('unresolved wins on a mixed path regardless of order', () => {
    expect(
      deriveCommentStateByPath([thread('a.ts', true), thread('a.ts', false)]).get('a.ts'),
    ).toBe('unresolved');
    expect(
      deriveCommentStateByPath([thread('a.ts', false), thread('a.ts', true)]).get('a.ts'),
    ).toBe('unresolved');
  });

  it('keys each path independently', () => {
    const m = deriveCommentStateByPath([thread('a.ts', false), thread('b.ts', true)]);
    expect(m.get('a.ts')).toBe('unresolved');
    expect(m.get('b.ts')).toBe('resolved');
  });
});
