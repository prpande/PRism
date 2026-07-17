import { describe, it, expect } from 'vitest';
import {
  deriveCommentStateByPath,
  deriveCommentCountsByPath,
  commentTooltip,
} from './commentIndicatorState';
import type { ReviewThreadDto } from '../../../api/types';

const thread = (filePath: string, isResolved: boolean): ReviewThreadDto => ({
  threadId: `${filePath}:${isResolved}`,
  filePath,
  lineNumber: 1,
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

describe('deriveCommentCountsByPath', () => {
  it('omits paths with no threads', () => {
    expect(deriveCommentCountsByPath([]).size).toBe(0);
  });

  it('tallies open and resolved threads per path', () => {
    const m = deriveCommentCountsByPath([
      thread('a.ts', false),
      thread('a.ts', false),
      thread('a.ts', true),
      thread('b.ts', true),
    ]);
    expect(m.get('a.ts')).toEqual({ open: 2, resolved: 1 });
    expect(m.get('b.ts')).toEqual({ open: 0, resolved: 1 });
  });
});

describe('commentTooltip', () => {
  it('shows both halves when a file has open and resolved threads', () => {
    expect(commentTooltip({ open: 2, resolved: 1 })).toBe('2 unresolved · 1 resolved');
  });

  it('drops the resolved half when there are no resolved threads', () => {
    expect(commentTooltip({ open: 3, resolved: 0 })).toBe('3 unresolved');
  });

  it('shows only the resolved count when all threads are resolved', () => {
    expect(commentTooltip({ open: 0, resolved: 3 })).toBe('3 resolved');
  });
});
