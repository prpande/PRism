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

  it('Cmd+Enter (submit) is inert while a post-now is in flight (#601 Defect C — keyboard sibling)', async () => {
    // The submit shortcut does flush()+onClose() — the keyboard sibling of Save.
    // During a post it must fire no update PUT and must not unmount mid-post.
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
    act(() => {
      result.current.editor.handleKeyDown({
        metaKey: true,
        key: 'Enter',
        preventDefault: () => {},
      } as unknown as KeyboardEvent<HTMLTextAreaElement>);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(sendSpy.mock.calls.length).toBe(callsAfterPostFlush);
    expect(p.onClose).not.toHaveBeenCalled();
    await act(async () => {
      resolvePost({ ok: true, postedCommentId: 1 });
      await Promise.resolve();
    });
  });

  it('recovery cancel resets recoveryModalOpenRef so post-now works again (#601 review finding)', async () => {
    // handlePostNow/handleKeyDown short-circuit on recoveryModalOpenRef. If
    // onRecoveryCancel only clears the state and not the ref, post-now stays
    // silently broken after the modal is dismissed.
    const sendSpy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: {},
    });
    const postSpy = vi
      .spyOn(commentApi, 'postComment')
      .mockResolvedValue({ ok: true, postedCommentId: 7 } as never);
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => {
      result.current.editor.setBody('an updated body');
    });
    // 1. Trigger recovery (404 mid-flush) — sets the ref true.
    await act(async () => {
      await result.current.actions.onPostNow();
    });
    expect(result.current.modals.recoveryModalOpen).toBe(true);
    expect(postSpy).not.toHaveBeenCalled();
    // 2. Cancel the recovery modal.
    act(() => {
      result.current.modals.onRecoveryCancel();
    });
    expect(result.current.modals.recoveryModalOpen).toBe(false);
    // 3. A subsequent successful post-now must NOT be short-circuited by a stale ref.
    sendSpy.mockResolvedValue({ ok: true, assignedId: 'd2' });
    await act(async () => {
      await result.current.actions.onPostNow();
    });
    expect(postSpy).toHaveBeenCalled();
  });

  it('discard-confirm is inert while a post is in flight (#601 review finding — defensive)', async () => {
    // Unreachable via the UI today (the modal can't be open during a post), but
    // the guard makes the delete-must-not-race-the-post invariant explicit.
    // Invoked in isolation here, as guard tests should be.
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
    await act(async () => {
      await result.current.modals.onDiscardConfirm();
    });
    // No delete PUT fired against the draft the post is shipping.
    expect(sendSpy.mock.calls.length).toBe(callsAfterPostFlush);
    await act(async () => {
      resolvePost({ ok: true, postedCommentId: 1 });
      await Promise.resolve();
    });
  });

  // #571 B1 fix — the reply composer's Resolve / "Comment and resolve conversation" button.
  describe('comment-and-resolve control', () => {
    const resolveControl = (over: Record<string, unknown> = {}) => ({
      onResolve: vi.fn(),
      isResolved: false,
      pending: false,
      readOnly: false,
      ...over,
    });

    it('exposes no resolve descriptor when resolveControl is absent (inline comments)', () => {
      const { result } = renderHook(() => useDraftComposer(params()));
      expect(result.current.actions.resolve).toBeUndefined();
    });

    it('labels the button "Comment and resolve conversation" when the composer has a postable reply', () => {
      const { result } = renderHook(() =>
        useDraftComposer(
          params({ draftId: 'd1', initialBody: 'a reply', resolveControl: resolveControl() }),
        ),
      );
      expect(result.current.actions.resolve?.label).toBe('Comment and resolve conversation');
      expect(result.current.actions.resolve?.disabled).toBe(false);
    });

    it('posts the reply THEN resolves and closes when clicked with a postable draft', async () => {
      vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
      const postSpy = vi
        .spyOn(commentApi, 'postComment')
        .mockResolvedValue({ ok: true, postedCommentId: 42 } as never);
      const rc = resolveControl();
      const p = params({ draftId: 'd1', initialBody: 'a reply', resolveControl: rc });
      const { result } = renderHook(() => useDraftComposer(p));

      await act(async () => {
        await result.current.actions.resolve!.onClick();
      });

      expect(postSpy).toHaveBeenCalledTimes(1); // the comment posted
      expect(rc.onResolve).toHaveBeenCalledTimes(1); // then resolved
      expect(p.onClose).toHaveBeenCalledTimes(1);
      expect(result.current.actions.postError).toBeNull();
    });

    it('does NOT resolve or close when the post fails — the comment is never silently dropped', async () => {
      vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
      vi.spyOn(commentApi, 'postComment').mockResolvedValue({
        ok: false,
        message: 'boom',
      } as never);
      const rc = resolveControl();
      const p = params({ draftId: 'd1', initialBody: 'a reply', resolveControl: rc });
      const { result } = renderHook(() => useDraftComposer(p));

      await act(async () => {
        await result.current.actions.resolve!.onClick();
      });

      expect(rc.onResolve).not.toHaveBeenCalled(); // a failed post must NOT resolve-and-drop
      expect(p.onClose).not.toHaveBeenCalled();
      expect(result.current.actions.postError).toBe('boom');
    });

    it('resolves WITHOUT posting when the composer is empty (plain "Resolve conversation")', async () => {
      const postSpy = vi.spyOn(commentApi, 'postComment');
      const rc = resolveControl();
      const p = params({ draftId: null, initialBody: '', resolveControl: rc });
      const { result } = renderHook(() => useDraftComposer(p));

      expect(result.current.actions.resolve?.label).toBe('Resolve conversation');
      await act(async () => {
        await result.current.actions.resolve!.onClick();
      });

      expect(postSpy).not.toHaveBeenCalled();
      expect(rc.onResolve).toHaveBeenCalledTimes(1);
      expect(p.onClose).not.toHaveBeenCalled(); // resolve-only leaves the composer as-is
    });

    it('on a resolved thread the button is a plain "Unresolve conversation" and never posts', async () => {
      const postSpy = vi.spyOn(commentApi, 'postComment');
      const rc = resolveControl({ isResolved: true });
      const p = params({ draftId: 'd1', initialBody: 'a reply', resolveControl: rc });
      const { result } = renderHook(() => useDraftComposer(p));

      expect(result.current.actions.resolve?.label).toBe('Unresolve conversation');
      await act(async () => {
        await result.current.actions.resolve!.onClick();
      });

      expect(postSpy).not.toHaveBeenCalled();
      expect(rc.onResolve).toHaveBeenCalledTimes(1);
    });
  });
});
