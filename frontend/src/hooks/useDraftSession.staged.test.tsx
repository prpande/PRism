import { describe, it, expect } from 'vitest';
import { computeAnyOtherDraftsStaged } from './useDraftSession';
import type { DraftCommentDto, DraftReplyDto } from '../api/types';

const c = (id: string): DraftCommentDto => ({
  id,
  filePath: 'a',
  lineNumber: 1,
  side: 'right',
  anchoredSha: 's',
  anchoredLineContent: '',
  bodyMarkdown: 'x',
  status: 'draft',
  isOverriddenStale: false,
  postedCommentId: null,
});

const r = (id: string): DraftReplyDto => ({
  id,
  parentThreadId: 't',
  replyCommentId: null,
  bodyMarkdown: 'x',
  status: 'draft',
  isOverriddenStale: false,
});

describe('computeAnyOtherDraftsStaged', () => {
  it("false when the only draft is the composer's own", () =>
    expect(computeAnyOtherDraftsStaged([c('mine')], [], 'mine', false)).toBe(false));
  it('true when another draft is staged', () =>
    expect(computeAnyOtherDraftsStaged([c('mine'), c('other')], [], 'mine', false)).toBe(true));
  it('false during a post-in-flight (global suppression)', () =>
    expect(computeAnyOtherDraftsStaged([c('mine'), c('other')], [], 'mine', true)).toBe(false));
  it('counts replies too', () =>
    expect(computeAnyOtherDraftsStaged([], [r('reply1')], null, false)).toBe(true));
});
