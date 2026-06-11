import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

export interface DraftBackedDisclosure {
  /** Whether the composer is mounted/open. */
  composerOpen: boolean;
  /** The id of the backing draft, or null when none has been persisted yet. */
  draftId: string | null;
  /** Setter handed to the composer's `onDraftIdChange` so a freshly-persisted draft reports back. */
  setDraftId: Dispatch<SetStateAction<string | null>>;
  /** Open the composer. */
  open: () => void;
  /** Close the composer. Resets `composerOpen` only — `draftId` persists across a close/reopen. */
  close: () => void;
}

/**
 * Disclosure state for a draft-backed composer (#363, carved from #326).
 *
 * The composer auto-mounts when a saved draft already exists; otherwise the user
 * opens it. The resync `useEffect` re-opens it when a draft arrives *after* mount —
 * e.g. another tab creates a draft, `useStateChangedSubscriber` refetches the
 * session, and the owning tab re-passes the hydrated draft. Without it the
 * `useState` initializer would be frozen at its first-render value and a cross-tab
 * arrival would be silently dropped. This path is live on both the inline (FilesTab)
 * and the PR-root (OverviewTab) composers today.
 *
 * `existingDraft` is structural (`{ id: string }`) so it accepts both `DraftReplyDto`
 * and `DraftCommentDto`; the hook only reads `.id`, and `null`/`undefined` are
 * treated identically as "no draft".
 */
export function useDraftBackedDisclosure(
  existingDraft: { id: string } | null | undefined,
): DraftBackedDisclosure {
  const [composerOpen, setComposerOpen] = useState<boolean>(!!existingDraft);
  const [draftId, setDraftId] = useState<string | null>(existingDraft?.id ?? null);

  useEffect(() => {
    if (!existingDraft) return;
    setDraftId(existingDraft.id);
    setComposerOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on existingDraft?.id; re-syncs only when the draft id changes, not on every object identity change (#331)
  }, [existingDraft?.id]);

  const open = useCallback(() => setComposerOpen(true), []);
  const close = useCallback(() => setComposerOpen(false), []);

  return { composerOpen, draftId, setDraftId, open, close };
}
