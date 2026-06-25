import { useCallback, useEffect, useRef, useState } from 'react';
import { sendPatch, type SendPatchResult } from '../api/draft';
import type { DraftSide, PrReference, ReviewSessionPatch } from '../api/types';

export type ComposerSaveBadge = 'saved' | 'saving' | 'unsaved' | 'rejected';

export function badgeLabel(badge: ComposerSaveBadge): string {
  switch (badge) {
    case 'saved':
      return 'Saved';
    case 'saving':
      return 'Saving…';
    case 'unsaved':
      return 'Unsaved';
    case 'rejected':
      return 'Save failed';
    default: {
      // Exhaustiveness backstop: a new ComposerSaveBadge member becomes a
      // compile error here instead of silently returning undefined.
      const _exhaustive: never = badge;
      return _exhaustive;
    }
  }
}

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
  // Spec § 5.7a — cross-tab take-over yields this tab to read-only. The
  // hook skips creates / updates / deletes when set so the OTHER tab's
  // composer is the only one writing. The debounce timer is also
  // suppressed to avoid a deferred save firing after the flag flips.
  disabled?: boolean;
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
  // Fired after any successful persist (create / update / delete). #299 — the
  // parent uses this to refetch the shared draft session so the Drafts tab
  // reflects the just-saved draft live, rather than waiting for composer close.
  onSaved?: () => void;
}

export interface UseComposerAutoSaveResult {
  badge: ComposerSaveBadge;
  // Returns the (possibly just-assigned) draft id after the save completes.
  // Callers that post-now need the fresh id because the captured `draftId` prop
  // is stale until the next render. (#302 Task 8.)
  flush: () => Promise<string | null>;
}

export const COMPOSER_DEBOUNCE_MS = 250;
export const COMPOSER_CREATE_THRESHOLD = 3;

export function useComposerAutoSave(props: UseComposerAutoSaveProps): UseComposerAutoSaveResult {
  const [badge, setBadge] = useState<ComposerSaveBadge>('saved');

  // All saves are serialized through one in-flight promise chain (#602 Defect
  // C). A new save awaits the chain tail before dispatching, so overlapping
  // update/delete saves resolve in submission order. This also subsumes the
  // old create-dedup `inFlightCreate` ref: a second save now awaits the first
  // create, by which point `draftIdRef` is set (synchronously, see doSave), so
  // it fires an update rather than a duplicate create (spec § 5.3).
  const saveChain = useRef<Promise<void>>(Promise.resolve());
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

  // The core save. Runs one create/update/delete based on the current body and
  // the freshest draftId. Serialization (ordering, create-dedup) is owned by
  // performSave's chain — doSave assumes it is the only save running.
  //
  // #602 Defect B: after each `await sendPatch`, re-read the LIVE
  // `propsRef.current.disabled` and bail BEFORE applying any effect — including
  // the local `draftIdRef` write. A cross-tab take-over that flips `disabled`
  // mid-PUT must leave this now-read-only tab with no state change and no
  // notification (spec § 5.7a). The PUT already dispatched can't be recalled,
  // but everything observable downstream is suppressed.
  const doSave = useCallback(async (currentBody: string): Promise<void> => {
    const p = propsRef.current;
    if (p.disabled) return;
    const trimmed = currentBody.trim();
    const id = draftIdRef.current;

    if (id === null) {
      // No persisted draft yet. Below the create threshold → silent no-op.
      // Empty composer also lands here — never creates a zero-body draft.
      if (trimmed.length < COMPOSER_CREATE_THRESHOLD) return;

      setBadge('saving');
      const result = await sendPatch(p.prRef, makeCreatePatch(currentBody, p.anchor));
      if (propsRef.current.disabled) return;
      if (result.ok && result.assignedId) {
        // Must be written synchronously here (no await between the resolve
        // above and this assignment): the next chained save reads draftIdRef
        // to choose create-vs-update. This is the create-dedup obligation that
        // moved off `inFlightCreate` onto the chain (#602 Defect C).
        draftIdRef.current = result.assignedId;
        setBadge('saved');
        propsRef.current.onAssignedId?.(result.assignedId);
        propsRef.current.onSaved?.();
        return;
      }
      applyErrorBadge(result, setBadge);
      return;
    }

    // Existing draft. Spec § 5.4 — empty body fires instant delete.
    if (trimmed.length === 0) {
      setBadge('saving');
      const result = await sendPatch(p.prRef, makeDeletePatch(id, p.anchor));
      if (propsRef.current.disabled) return;
      if (result.ok) {
        draftIdRef.current = null;
        setBadge('saved');
        propsRef.current.onLocalDelete?.();
        return;
      }
      applyErrorBadge(result, setBadge);
      return;
    }

    // 1, 2, or 3+ chars — fire update. The threshold gate is for *creation*
    // only; a user mid-edit at 2 chars on an existing draft is trusted.
    setBadge('saving');
    const result = await sendPatch(p.prRef, makeUpdatePatch(id, currentBody, p.anchor));
    if (propsRef.current.disabled) return;
    if (result.ok) {
      setBadge('saved');
      propsRef.current.onSaved?.();
      return;
    }
    if (result.kind === 'draft-not-found') {
      // 404: the draft was deleted elsewhere. Composer's recovery modal.
      draftIdRef.current = null;
      setBadge('unsaved');
      propsRef.current.onDraftDeletedByServer?.();
      return;
    }
    applyErrorBadge(result, setBadge);
  }, []);

  // Serialize every save through one tail-chained promise (#602 Defect C). The
  // next save cannot dispatch its `sendPatch` until the prior save resolves, so
  // server writes land in submission order and the terminal badge reflects the
  // latest write.
  const performSave = useCallback(
    (currentBody: string): Promise<void> => {
      const next = saveChain.current.then(() => doSave(currentBody));
      // Swallow rejections on the STORED tail so one failed save can't poison
      // later links; the returned `next` still surfaces the real result. doSave
      // never throws under the current contract (sendPatch returns a result),
      // so this is defense-in-depth against a future throw path.
      saveChain.current = next.catch(() => undefined);
      return next;
    },
    [doSave],
  );

  const flush = useCallback(async (): Promise<string | null> => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
      debounceTimer.current = null;
    }
    await performSave(propsRef.current.body);
    return draftIdRef.current;
  }, [performSave]);

  // #602 Defect A — flush a pending debounced edit on unmount. Without this, an
  // unmount within COMPOSER_DEBOUNCE_MS of the last keystroke that bypasses the
  // explicit flush handlers (PR navigation tearing the tree down, file-tree
  // collapse, sub-tab switch) silently drops that keystroke. The body-keyed
  // debounce effect below cannot flush in its cleanup — that runs on every
  // keystroke — so this empty-dep effect's cleanup, which runs only at unmount,
  // owns it. `performSave` is stable, so the dependency never re-fires the
  // cleanup before unmount.
  useEffect(() => {
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
        // Fire-and-forget (cleanups cannot await). doSave re-checks `disabled`
        // at entry, so a taken-over tab still no-ops; setBadge after unmount is
        // a React no-op, but the PUT still lands.
        void performSave(propsRef.current.body);
      }
    };
  }, [performSave]);

  useEffect(() => {
    if (props.disabled) {
      // Cancel any pending debounce. Without this an in-flight timer
      // queued just before the flag flipped would still fire after the
      // take-over, racing with the other tab.
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
      return;
    }
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
  }, [props.body, props.disabled, performSave]);

  return { badge, flush };
}

function applyErrorBadge(result: SendPatchResult, setBadge: (b: ComposerSaveBadge) => void): void {
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

function makeUpdatePatch(id: string, body: string, anchor: ComposerAnchor): ReviewSessionPatch {
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
