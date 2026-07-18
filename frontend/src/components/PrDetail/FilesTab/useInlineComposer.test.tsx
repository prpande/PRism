import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useInlineComposer, type UseInlineComposerOpts } from './useInlineComposer';
import type { InlineAnchor } from '../Composer/InlineCommentComposer';
import type { DraftCommentDto, ReviewSessionDto } from '../../../api/types';

// Unit coverage for the inline-composer lifecycle extracted from FilesTab
// (#327 slice 2). The FULL FilesTab integration (line click → composer mount →
// draft save/close) lives in FilesTabComposer.test.tsx. This file
// exercises the hook seam itself: open-at-anchor (anchorSha stamping +
// existing-draft resume), the same-anchor no-op, flush-on-line-switch, close
// semantics, and — the one deliberate upgrade over the pre-extraction code —
// the STABLE identity of handleLineClick across rerenders (it crosses the
// memoized DiffPane boundary; an unstable identity would defeat the memo).

function draft(overrides: Partial<DraftCommentDto> = {}): DraftCommentDto {
  return {
    id: 'draft-1',
    filePath: 'src/main.ts',
    lineNumber: 5,
    side: 'right',
    anchoredSha: 'sha-old',
    anchoredLineContent: 'const x = 1;',
    bodyMarkdown: 'existing body',
    status: 'draft',
    isOverriddenStale: false,
    postedCommentId: null,
    ...overrides,
  };
}

// The hook reads only session.draftComments; the rest of ReviewSessionDto is
// irrelevant here (same partial-cast convention as the other FilesTab tests).
function sessionWith(draftComments: DraftCommentDto[]): ReviewSessionDto {
  return { draftComments, draftReplies: [] } as unknown as ReviewSessionDto;
}

function rawAnchor(overrides: Partial<InlineAnchor> = {}): InlineAnchor {
  // DiffPane sends back an empty anchoredSha; the hook stamps the anchorSha
  // it is given (the after-side of the displayed range — head for "All changes").
  return {
    filePath: 'src/main.ts',
    lineNumber: 5,
    side: 'right',
    anchoredSha: '',
    anchoredLineContent: 'const x = 1;',
    ...overrides,
  };
}

function makeOpts(overrides?: {
  session?: ReviewSessionDto | null;
  refetch?: () => Promise<void>;
  anchorSha?: string;
}): UseInlineComposerOpts {
  return {
    draftSession: {
      session: overrides?.session ?? null,
      refetch: overrides?.refetch ?? vi.fn().mockResolvedValue(undefined),
    },
    anchorSha: overrides?.anchorSha ?? 'sha-head',
  };
}

function setup(initialOpts: UseInlineComposerOpts = makeOpts()) {
  return renderHook((opts: UseInlineComposerOpts) => useInlineComposer(opts), {
    initialProps: initialOpts,
  });
}

describe('useInlineComposer', () => {
  it('handleLineClick opens the composer at the anchor, stamping the anchorSha; no existing draft → null draftId', () => {
    const { result } = setup();

    act(() => {
      result.current.handleLineClick(rawAnchor());
    });

    expect(result.current.activeAnchor).toEqual(rawAnchor({ anchoredSha: 'sha-head' }));
    expect(result.current.composerDraftId).toBeNull();
  });

  it('stamps the active iterations afterSha, not head, when an older iteration is displayed (#723)', () => {
    // FilesTab resolves the after-side of the displayed range and passes it as
    // anchorSha; on an older-iteration view that is the iteration's afterSha,
    // NOT the PR head. The composer must stamp exactly what it is given so the
    // post-now commit_id matches the commit whose diff the reviewer clicked.
    const { result } = setup(makeOpts({ anchorSha: 'sha-after-2' }));

    act(() => {
      result.current.handleLineClick(rawAnchor());
    });

    expect(result.current.activeAnchor?.anchoredSha).toBe('sha-after-2');
  });

  it('clicking a line with an existing draft (filePath+lineNumber+side match) resumes that draftId', () => {
    const { result } = setup(
      makeOpts({
        session: sessionWith([
          draft({ id: 'other', lineNumber: 99 }),
          draft({ id: 'match-me', filePath: 'src/main.ts', lineNumber: 5, side: 'right' }),
        ]),
      }),
    );

    act(() => {
      result.current.handleLineClick(rawAnchor());
    });

    expect(result.current.composerDraftId).toBe('match-me');
    expect(result.current.activeAnchor?.anchoredSha).toBe('sha-head');
  });

  it('clicking the SAME anchor while open is a no-op — the composer stays put and no flush fires', () => {
    // Pins today's FilesTab semantics: a same-anchor click returns early
    // (composer already mounted there) — it does NOT toggle/close.
    const { result } = setup();
    const flush = vi.fn().mockResolvedValue(null);

    act(() => {
      result.current.handleLineClick(rawAnchor());
    });
    const anchorAfterOpen = result.current.activeAnchor;
    result.current.flushRef.current = flush;

    act(() => {
      // Same filePath/lineNumber/side — anchoredSha differs on the raw anchor
      // (always '' from DiffPane) but is not part of the same-anchor identity.
      result.current.handleLineClick(rawAnchor());
    });

    expect(result.current.activeAnchor).toBe(anchorAfterOpen);
    expect(flush).not.toHaveBeenCalled();
  });

  it('clicking a DIFFERENT line flushes the current composer first, then moves the anchor', () => {
    const { result } = setup();
    const flush = vi.fn().mockResolvedValue(null);

    act(() => {
      result.current.handleLineClick(rawAnchor());
    });
    result.current.flushRef.current = flush;

    act(() => {
      result.current.handleLineClick(rawAnchor({ lineNumber: 12 }));
    });

    expect(flush).toHaveBeenCalledTimes(1);
    expect(result.current.activeAnchor).toEqual(
      rawAnchor({ lineNumber: 12, anchoredSha: 'sha-head' }),
    );
  });

  it('handleComposerClose clears the anchor and draftId and refetches the draft session', () => {
    const refetch = vi.fn().mockResolvedValue(undefined);
    const { result } = setup(makeOpts({ refetch }));

    act(() => {
      result.current.handleLineClick(rawAnchor());
      result.current.setComposerDraftId('draft-1');
    });
    expect(result.current.activeAnchor).not.toBeNull();

    act(() => {
      result.current.handleComposerClose();
    });

    expect(result.current.activeAnchor).toBeNull();
    expect(result.current.composerDraftId).toBeNull();
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('handleLineClick is referentially identical across rerenders with changed deps — and reads CURRENT deps through the ref', () => {
    const { result, rerender } = setup();
    const firstIdentity = result.current.handleLineClick;

    // State change (open a composer) → rerender.
    act(() => {
      result.current.handleLineClick(rawAnchor());
    });
    expect(result.current.handleLineClick).toBe(firstIdentity);

    // Entirely new opts objects: new draftSession (now holding a matching
    // draft) and a new anchorSha.
    rerender(
      makeOpts({
        session: sessionWith([draft({ id: 'late-draft', lineNumber: 12 })]),
        anchorSha: 'sha-head-2',
      }),
    );
    expect(result.current.handleLineClick).toBe(firstIdentity);

    // The stable handler must NOT see stale closures: clicking line 12 now
    // resumes the late-arriving draft and stamps the NEW anchorSha.
    act(() => {
      result.current.handleLineClick(rawAnchor({ lineNumber: 12 }));
    });
    expect(result.current.composerDraftId).toBe('late-draft');
    expect(result.current.activeAnchor?.anchoredSha).toBe('sha-head-2');
  });

  it('findExistingDraft returns the matching draft id+body, or null', () => {
    const { result } = setup(
      makeOpts({ session: sessionWith([draft({ id: 'd', bodyMarkdown: 'b' })]) }),
    );

    expect(result.current.findExistingDraft(rawAnchor())).toEqual({ id: 'd', bodyMarkdown: 'b' });
    expect(result.current.findExistingDraft(rawAnchor({ side: 'left' }))).toBeNull();
  });
});
