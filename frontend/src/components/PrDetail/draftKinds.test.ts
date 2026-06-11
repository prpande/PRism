import { describe, it, expect } from 'vitest';
import { isPrRootDraft } from './draftKinds';
import type { DraftCommentDto } from '../../api/types';

function draft(overrides: Partial<DraftCommentDto>): DraftCommentDto {
  return {
    id: 'd1',
    filePath: 'src/Foo.ts',
    lineNumber: 10,
    side: 'right',
    anchoredSha: 'sha',
    anchoredLineContent: 'line',
    bodyMarkdown: 'body',
    status: 'draft',
    isOverriddenStale: false,
    postedCommentId: null,
    ...overrides,
  };
}

describe('isPrRootDraft', () => {
  it('is true for a both-null PR-root draft', () => {
    expect(isPrRootDraft(draft({ filePath: null, lineNumber: null }))).toBe(true);
  });

  it('is false for a fully-anchored line comment', () => {
    expect(isPrRootDraft(draft({ filePath: 'src/Foo.ts', lineNumber: 10 }))).toBe(false);
  });

  // #324 — FilePath is the discriminator: a draft with no file path is the PR-root regardless of
  // lineNumber. The old `filePath === null && lineNumber === null` spelling returned false here,
  // disagreeing with the backend and stranding the draft.
  it('is true for a half-null draft (filePath null, lineNumber set)', () => {
    expect(isPrRootDraft(draft({ filePath: null, lineNumber: 5 }))).toBe(true);
  });
});
