import { useCallback, useEffect, useRef, useState } from 'react';
import { sendPatch, type SendPatchResult } from '../api/draft';
import type {
  DraftSide,
  PrReference,
  ReviewSessionPatch,
} from '../api/types';

export type ComposerSaveBadge = 'saved' | 'saving' | 'unsaved' | 'rejected';

export type ComposerAnchor =
  | {
      kind: 'inline-comment';
      filePath: string;
      lineNumber: number;
      side: DraftSide;
      anchoredSha: string;
      anchoredLineContent: string;
    }
  | { kind: 'pr-root' }
  | { kind: 'reply'; parentThreadId: string };

export interface UseComposerAutoSaveProps {
  prRef: PrReference;
  prState: 'open' | 'closed' | 'merged';
  body: string;
  draftId: string | null;
  anchor: ComposerAnchor;
  // Fired exactly once per composer session, when the first PUT
  // (newDraftComment / newPrRootDraftComment / newDraftReply) returns its
  // server-assigned id. Parent uses this to bind composer → draft id.
  onAssignedId?: (id: string) => void;
  // Fired when an update PUT returns 404. Composer surfaces a recovery modal
  // ("Re-create" / "Discard") per Task 39 Step 4. The hook clears its
  // internal draftId so a subsequent flush re-creates the draft.
  onDraftDeletedByServer?: () => void;
  // Fired when the user empties the composer and the resulting delete patch
  // succeeds. Composer uses this to unmount (per spec § 5.4 "no confirmation
  // — instant delete").
  onLocalDelete?: () => void;
}

export interface UseComposerAutoSaveResult {
  badge: ComposerSaveBadge;
  flush: () => Promise<void>;
}

export const COMPOSER_DEBOUNCE_MS = 250;
export const COMPOSER_CREATE_THRESHOLD = 3;

export function useComposerAutoSave(
  props: UseComposerAutoSaveProps,
): UseComposerAutoSaveResult {
  const [badge, setBadge] = useState<ComposerSaveBadge>('saved');

  // In-flight create promise. Subsequent debounces await it rather than
  // firing a duplicate create (spec § 5.3 "in-flight create promise").
  const inFlightCreate = useRef<Promise<string | null> | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mirrors the latest known draftId in a ref so save flows can read the
  // freshest value without waiting for a parent re-render after onAssignedId.
  const draftIdRef = useRef<string | null>(props.draftId);
  useEffect(() => {
    draftIdRef.current = props.draftId;
  }, [props.draftId]);

  // Latest props mirrored in a ref so flush() and the debounced callback
  // never read stale values from a closure.
  const propsRef = useRef(props);
  useEffect(() => {
    propsRef.current = props;
  });

  const performSave = useCallback(async (currentBody: string): Promise<void> => {
    const p = propsRef.current;
    if (p.prState !== 'open') return;
    const trimmed = currentBody.trim();

    // Drain any in-flight create first. The next save needs the assigned id
    // before deciding create-vs-update; queueing here also dedupes the
    // simultaneous-debounces-during-create race.
    if (inFlightCreate.current !== null) {
      const id = await inFlightCreate.current;
      if (id !== null) {
        draftIdRef.current = id;
      }
    }

    const id = draftIdRef.current;

    if (id === null) {
      // No persisted draft yet. Below the create threshold → silent no-op.
      // Empty composer also lands here — never creates a zero-body draft.
      if (trimmed.length < COMPOSER_CREATE_THRESHOLD) return;

      const promise: Promise<string | null> = (async () => {
        setBadge('saving');
        const result = await sendPatch(p.prRef, makeCreatePatch(currentBody, p.anchor));
        if (result.ok && result.assignedId) {
          draftIdRef.current = result.assignedId;
          setBadge('saved');
          p.onAssignedId?.(result.assignedId);
          return result.assignedId;
        }
        applyErrorBadge(result, setBadge);
        return null;
      })();
      inFlightCreate.current = promise;
      try {
        await promise;
      } finally {
        if (inFlightCreate.current === promise) inFlightCreate.current = null;
      }
      return;
    }

    // Existing draft. Spec § 5.4 — empty body fires instant delete.
    if (trimmed.length === 0) {
      setBadge('saving');
      const result = await sendPatch(p.prRef, makeDeletePatch(id, p.anchor));
      if (result.ok) {
        draftIdRef.current = null;
        setBadge('saved');
        p.onLocalDelete?.();
        return;
      }
      applyErrorBadge(result, setBadge);
      return;
    }

    // 1, 2, or 3+ chars — fire update. The threshold gate is for *creation*
    // only; a user mid-edit at 2 chars on an existing draft is trusted.
    setBadge('saving');
    const result = await sendPatch(p.prRef, makeUpdatePatch(id, currentBody, p.anchor));
    if (result.ok) {
      setBadge('saved');
      return;
    }
    if (result.kind === 'draft-not-found') {
      // 404: the draft was deleted elsewhere. Composer's recovery modal.
      draftIdRef.current = null;
      setBadge('unsaved');
      p.onDraftDeletedByServer?.();
      return;
    }
    applyErrorBadge(result, setBadge);
  }, []);

  const flush = useCallback(async () => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    await performSave(propsRef.current.body);
  }, [performSave]);

  useEffect(() => {
    if (props.prState !== 'open') return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      void performSave(props.body);
    }, COMPOSER_DEBOUNCE_MS);
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [props.body, props.prState, performSave]);

  return { badge, flush };
}

function applyErrorBadge(
  result: SendPatchResult,
  setBadge: (b: ComposerSaveBadge) => void,
): void {
  if (result.ok) return;
  if (result.kind === 'invalid-body') {
    // 422 — semantic rejection (body too large, file path invalid, etc.).
    // No retry; user must edit and try again.
    setBadge('rejected');
    return;
  }
  // 5xx, network errors, 409 conflicts, draft-not-found (handled separately
  // by caller before this fn) → keep local body, retry on next keystroke.
  setBadge('unsaved');
}

function makeCreatePatch(body: string, anchor: ComposerAnchor): ReviewSessionPatch {
  switch (anchor.kind) {
    case 'inline-comment':
      return {
        kind: 'newDraftComment',
        payload: {
          filePath: anchor.filePath,
          lineNumber: anchor.lineNumber,
          side: anchor.side,
          anchoredSha: anchor.anchoredSha,
          anchoredLineContent: anchor.anchoredLineContent,
          bodyMarkdown: body,
        },
      };
    case 'pr-root':
      return { kind: 'newPrRootDraftComment', payload: { bodyMarkdown: body } };
    case 'reply':
      return {
        kind: 'newDraftReply',
        payload: { parentThreadId: anchor.parentThreadId, bodyMarkdown: body },
      };
  }
}

function makeUpdatePatch(
  id: string,
  body: string,
  anchor: ComposerAnchor,
): ReviewSessionPatch {
  if (anchor.kind === 'reply') {
    return { kind: 'updateDraftReply', payload: { id, bodyMarkdown: body } };
  }
  return { kind: 'updateDraftComment', payload: { id, bodyMarkdown: body } };
}

function makeDeletePatch(id: string, anchor: ComposerAnchor): ReviewSessionPatch {
  if (anchor.kind === 'reply') {
    return { kind: 'deleteDraftReply', payload: { id } };
  }
  return { kind: 'deleteDraftComment', payload: { id } };
}
