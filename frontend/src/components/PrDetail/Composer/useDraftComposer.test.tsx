import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useDraftComposer } from './useDraftComposer';
import * as draftApi from '../../../api/draft';
import * as commentApi from '../../../api/comment';
import type { ComposerAnchor } from '../../../hooks/useComposerAutoSave';

const inlineAnchor: ComposerAnchor = {
  kind: 'inline-comment',
  filePath: 'a.ts',
  lineNumber: 1,
  side: 'right',
  anchoredSha: 'sha',
  anchoredLineContent: 'x',
};

function params(overrides: Partial<Parameters<typeof useDraftComposer>[0]> = {}) {
  return {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prState: 'open' as const,
    draftId: 'd1',
    onDraftIdChange: vi.fn(),
    registerOpenComposer: vi.fn(() => () => {}),
    ownerKey: 'files-tab' as const,
    onClose: vi.fn(),
    anchor: inlineAnchor,
    deletePatchKind: 'deleteDraftComment' as const,
    ...overrides,
  };
}

describe('useDraftComposer', () => {
  // useComposerAutoSave schedules a debounce timer on mount — fake timers keep
  // it from firing stray sendPatch calls mid-test (matches the existing suite).
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes grouped editor/actions/modals slices', () => {
    const { result } = renderHook(() => useDraftComposer(params()));
    expect(result.current.editor).toBeDefined();
    expect(result.current.actions).toBeDefined();
    expect(result.current.modals).toBeDefined();
    expect(typeof result.current.editor.handleKeyDown).toBe('function');
  });

  it('discard confirm sends the parameterized delete kind and closes on ok', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const p = params({
      deletePatchKind: 'deleteDraftReply',
      anchor: { kind: 'reply', parentThreadId: 't1' },
    });
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => {
      await result.current.modals.onDiscardConfirm();
    });
    expect(spy).toHaveBeenCalledWith(p.prRef, { kind: 'deleteDraftReply', payload: { id: 'd1' } });
    expect(p.onClose).toHaveBeenCalled();
  });

  it('discard confirm stays in the modal on a non-ok (network) result', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 0,
      kind: 'network',
      body: 'x',
    });
    const p = params();
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => {
      await result.current.modals.onDiscardConfirm();
    });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onDraftIdChange).not.toHaveBeenCalledWith(null);
  });

  it('save is disabled below the create threshold for a new draft', () => {
    const { result } = renderHook(() =>
      useDraftComposer(params({ draftId: null, initialBody: 'a' })),
    );
    expect(result.current.actions.saveDisabled).toBe(true);
  });

  it('registers the open composer with the provided ownerKey', () => {
    const register = vi.fn(() => () => {});
    renderHook(() =>
      useDraftComposer(params({ registerOpenComposer: register, ownerKey: 'drafts-tab' })),
    );
    expect(register).toHaveBeenCalledWith('d1', 'drafts-tab');
  });

  it('Cmd+Enter does NOT close when a 404 recovery opened mid-flush', async () => {
    // Existing draft + update → 404 draft-not-found fires onDraftDeletedByServer,
    // which sets recoveryModalOpenRef; the submit IIFE must then skip onClose().
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: {},
    });
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => {
      result.current.editor.setBody('an updated body');
    });
    await act(async () => {
      result.current.editor.handleKeyDown({
        metaKey: true,
        key: 'Enter',
        preventDefault: () => {},
      } as unknown as KeyboardEvent<HTMLTextAreaElement>);
      // Submit IIFE chain is 3 awaits deep (flush → performSave → sendPatch);
      // drain three microtasks, matching the existing settle() helper.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.modals.recoveryModalOpen).toBe(true);
    expect(p.onClose).not.toHaveBeenCalled();
  });

  it('post-now does NOT post (nor surfaces an inline error) when a 404 recovery opened mid-flush (#601 Defect A)', async () => {
    // Existing draft + update → 404 fires onDraftDeletedByServer, which opens the
    // recovery modal and clears draftId. handlePostNow must short-circuit on that
    // transition — never falling back to the stale `draftId` prop and posting
    // against the deleted draft (which would double-surface a recovery modal AND
    // an inline post error).
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: {},
    });
    const postSpy = vi
      .spyOn(commentApi, 'postComment')
      .mockResolvedValue({ ok: false, message: 'draft not found' } as never);
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => {
      result.current.editor.setBody('an updated body');
    });
    await act(async () => {
      await result.current.actions.onPostNow();
    });
    expect(postSpy).not.toHaveBeenCalled();
    expect(result.current.modals.recoveryModalOpen).toBe(true);
    expect(result.current.actions.postError).toBeNull();
  });

  it('discard is inert while a post-now is in flight (#601 Defect C)', async () => {
    // A pending post owns the draft. Opening the discard modal mid-post would let
    // the user confirm a delete that races the in-flight post.
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    let resolvePost: (v: unknown) => void = () => {};
    vi.spyOn(commentApi, 'postComment').mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }) as never,
    );
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => {
      result.current.editor.setBody('body to post');
    });
    // Start the post; drain flush so we sit inside the pending postComment.
    await act(async () => {
      void result.current.actions.onPostNow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.actions.posting).toBe(true);
    // Attempt to discard mid-post — must be a no-op.
    act(() => {
      result.current.actions.onDiscardClick();
    });
    expect(result.current.modals.discardModalOpen).toBe(false);
    // Let the post settle so no act() warning leaks.
    await act(async () => {
      resolvePost({ ok: true, postedCommentId: 1 });
      await Promise.resolve();
    });
  });

  it('save is inert while a post-now is in flight (#601 Defect C — Save sibling)', async () => {
    // handleSaveClick fires flush()→update PUT against the same draft the post is
    // shipping. It must no-op during a post so the update can't race the post.
    const sendSpy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      assignedId: null,
    });
    let resolvePost: (v: unknown) => void = () => {};
    vi.spyOn(commentApi, 'postComment').mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }) as never,
    );
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => {
      result.current.editor.setBody('body to post');
    });
    await act(async () => {
      void result.current.actions.onPostNow();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.actions.posting).toBe(true);
    const callsAfterPostFlush = sendSpy.mock.calls.length;
    // Saving mid-post must NOT fire another sendPatch (update) against the draft.
    act(() => {
      result.current.actions.onSaveClick();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendSpy.mock.calls.length).toBe(callsAfterPostFlush);
    await act(async () => {
      resolvePost({ ok: true, postedCommentId: 1 });
      await Promise.resolve();
    });
  });
});
