import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { KeyboardEvent } from 'react';
import { useDraftComposer } from './useDraftComposer';
import * as draftApi from '../../../api/draft';
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
  beforeEach(() => { vi.restoreAllMocks(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('exposes grouped editor/actions/modals slices', () => {
    const { result } = renderHook(() => useDraftComposer(params()));
    expect(result.current.editor).toBeDefined();
    expect(result.current.actions).toBeDefined();
    expect(result.current.modals).toBeDefined();
    expect(typeof result.current.editor.handleKeyDown).toBe('function');
  });

  it('discard confirm sends the parameterized delete kind and closes on ok', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const p = params({ deletePatchKind: 'deleteDraftReply', anchor: { kind: 'reply', parentThreadId: 't1' } });
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => { await result.current.modals.onDiscardConfirm(); });
    expect(spy).toHaveBeenCalledWith(p.prRef, { kind: 'deleteDraftReply', payload: { id: 'd1' } });
    expect(p.onClose).toHaveBeenCalled();
  });

  it('discard confirm stays in the modal on a non-ok (network) result', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: false, status: 0, kind: 'network', body: 'x' });
    const p = params();
    const { result } = renderHook(() => useDraftComposer(p));
    await act(async () => { await result.current.modals.onDiscardConfirm(); });
    expect(p.onClose).not.toHaveBeenCalled();
    expect(p.onDraftIdChange).not.toHaveBeenCalledWith(null);
  });

  it('save is disabled below the create threshold for a new draft', () => {
    const { result } = renderHook(() => useDraftComposer(params({ draftId: null, initialBody: 'a' })));
    expect(result.current.actions.saveDisabled).toBe(true);
  });

  it('registers the open composer with the provided ownerKey', () => {
    const register = vi.fn(() => () => {});
    renderHook(() => useDraftComposer(params({ registerOpenComposer: register, ownerKey: 'drafts-tab' })));
    expect(register).toHaveBeenCalledWith('d1', 'drafts-tab');
  });

  it('Cmd+Enter does NOT close when a 404 recovery opened mid-flush', async () => {
    // Existing draft + update → 404 draft-not-found fires onDraftDeletedByServer,
    // which sets recoveryModalOpenRef; the submit IIFE must then skip onClose().
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: false, status: 404, kind: 'draft-not-found', body: {} });
    const p = params({ draftId: 'd1' });
    const { result } = renderHook(() => useDraftComposer(p));
    act(() => { result.current.editor.setBody('an updated body'); });
    await act(async () => {
      result.current.editor.handleKeyDown({
        metaKey: true, key: 'Enter', preventDefault: () => {},
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
});
