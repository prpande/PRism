import { useState, useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useLatestRef } from '../../../hooks/useLatestRef';
import type { InlineAnchor } from '../Composer/InlineCommentComposer';
import type { UseDraftSessionResult } from '../../../hooks/useDraftSession';

// #327 slice 2 — the inline-composer lifecycle extracted from FilesTab. Owns
// the active-anchor + draft-id state, the flush ref, the existing-draft
// lookup, and the open/click/close handlers. One deliberate upgrade over the
// pre-extraction code: handleLineClick has a STABLE identity (latest-ref
// pattern, mirroring DiffPane's n/p navRef) because it crosses the memoized
// DiffPane boundary — an identity that changed with every render would defeat
// the memo.

export interface UseInlineComposerOpts {
  // Exactly what the moved closures read: findExistingDraft reads
  // draftSession.session, handleComposerClose calls draftSession.refetch,
  // and openComposerAt stamps anchorSha.
  draftSession: Pick<UseDraftSessionResult, 'session' | 'refetch'>;
  // The commit a NEW inline comment anchors to — the after-side of the diff
  // range currently displayed in the Files tab, resolved by the caller via
  // anchorShaForRange (#723): the PR head on "All changes", the iteration's
  // afterSha on an older-iteration view.
  anchorSha: string;
}

export function useInlineComposer({ draftSession, anchorSha }: UseInlineComposerOpts): {
  activeAnchor: InlineAnchor | null;
  composerDraftId: string | null;
  setComposerDraftId: (id: string | null) => void;
  flushRef: MutableRefObject<(() => Promise<string | null>) | null>;
  findExistingDraft: (anchor: InlineAnchor) => { id: string; bodyMarkdown: string } | null;
  handleLineClick: (rawAnchor: InlineAnchor) => void;
  handleComposerClose: () => void;
} {
  // Active inline composer state. activeAnchor + composerDraftId together
  // describe "the composer the user is currently in".
  const [activeAnchor, setActiveAnchor] = useState<InlineAnchor | null>(null);
  const [composerDraftId, setComposerDraftId] = useState<string | null>(null);
  // #299 — holds the active composer's flush so a line switch can persist a
  // pending debounced edit before the composer is swapped out (the modal that
  // used to bridge that gap is gone). The composer (un)registers it itself.
  const activeComposerFlushRef = useRef<(() => Promise<string | null>) | null>(null);

  function findExistingDraft(anchor: InlineAnchor): { id: string; bodyMarkdown: string } | null {
    const session = draftSession.session;
    if (!session) return null;
    const match = session.draftComments.find(
      (d) =>
        d.filePath === anchor.filePath &&
        d.lineNumber === anchor.lineNumber &&
        d.side === anchor.side,
    );
    return match ? { id: match.id, bodyMarkdown: match.bodyMarkdown } : null;
  }

  function openComposerAt(rawAnchor: InlineAnchor) {
    // DiffPane sends back an empty anchoredSha; stamp the after-side commit of
    // the range on screen (anchorSha). DiffPane only allows right-side clicks,
    // so this is always the commit whose diff the reviewer is looking at — the
    // PR head on "All changes", the iteration's afterSha on an older-iteration
    // view (#723). The post-now path (PrCommentEndpoints) sends this as the
    // GitHub commit_id, so an older-iteration line must anchor to afterSha or
    // GitHub rejects/misplaces it.
    const anchor: InlineAnchor = { ...rawAnchor, anchoredSha: anchorSha };
    const existing = findExistingDraft(anchor);
    setActiveAnchor(anchor);
    setComposerDraftId(existing?.id ?? null);
  }

  // handleLineClick crosses the memoized DiffPane boundary, so it is created
  // ONCE (useCallback with no deps) and reads the current activeAnchor +
  // openComposerAt through a latest ref (mirrors DiffPane's n/p navRef —
  // avoids handing DiffPane a fresh identity on every render).
  const lineClickDepsRef = useLatestRef({ activeAnchor, openComposerAt });
  const handleLineClick = useCallback(
    (rawAnchor: InlineAnchor) => {
      const { activeAnchor, openComposerAt } = lineClickDepsRef.current;
      // Same-anchor click → no-op (composer already mounted there).
      if (
        activeAnchor &&
        activeAnchor.filePath === rawAnchor.filePath &&
        activeAnchor.lineNumber === rawAnchor.lineNumber &&
        activeAnchor.side === rawAnchor.side
      ) {
        return;
      }
      // #299 — drafts auto-save as the author types, so switching lines never
      // needs a "keep or discard?" prompt: whatever was being drafted is already
      // persisted. Flush any pending (sub-debounce) edit of the current composer
      // first so a fast line switch doesn't drop the last keystrokes, then open
      // the composer at the new line. A saved draft left behind stays persisted
      // (and reappears via findExistingDraft when the user clicks back to its
      // line); discarding it is an explicit action on the composer's Discard
      // button. The flush is fire-and-forget — it reads the latest body before
      // the composer unmounts, and onSaved refetches when it lands. We don't
      // block the switch on it, but a rejection is logged rather than swallowed:
      // the unmounted composer has no badge to surface the failure, and the
      // dropped edit is otherwise invisible (the draft's last-saved state stays
      // intact).
      activeComposerFlushRef.current?.().catch((err) => {
        console.error('[FilesTab] flush on line-switch failed; latest edit may be unsaved', err);
      });
      openComposerAt(rawAnchor);
      // Ref-only dep: useLatestRef returns a stable ref object, so the callback
      // identity never changes (the lint rule can't see that a custom hook's ref
      // is stable, so it must be listed).
    },
    [lineClickDepsRef],
  );

  function handleComposerClose() {
    setActiveAnchor(null);
    setComposerDraftId(null);
    // Own-tab mutations are filtered by useStateChangedSubscriber, so the
    // SSE channel won't trigger a refetch for changes this tab made.
    // Refresh on close so the next click at the same anchor sees the
    // just-saved/just-deleted state and avoids creating a duplicate draft.
    void draftSession.refetch();
  }

  return {
    activeAnchor,
    composerDraftId,
    setComposerDraftId,
    flushRef: activeComposerFlushRef,
    findExistingDraft,
    handleLineClick,
    handleComposerClose,
  };
}
