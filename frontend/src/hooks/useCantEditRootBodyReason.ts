import type { ComposerOwnerKey } from './useDraftSession';

/**
 * Discriminated reason value explaining why the current composer cannot edit
 * the PR-root body. null means editing is permitted.
 *
 * - 'editing-in-overview-composer' — the reply-composer surface on the
 *   Overview tab holds the draft open.
 * - 'editing-in-submit-dialog'     — the Submit dialog holds the draft open.
 * - 'editing-in-other-tab'         — the session is readOnly (cross-tab lock).
 * - null                           — no blocker; editing is allowed.
 */
export type CantEditRootBodyReason =
  | 'editing-in-overview-composer'
  | 'editing-in-submit-dialog'
  | 'editing-in-other-tab'
  | null;

interface Args {
  /** True when the session is cross-tab locked (another tab owns this PR). */
  readOnly: boolean;
  /** The ownerKey of the current composer surface. */
  ownerKey: ComposerOwnerKey;
  /** The ownerKey of whoever currently holds the PR-root draft, or null. */
  prRootHolder: ComposerOwnerKey | null;
}

/**
 * Pure hook-named function — no useState/useEffect. Named as a hook because
 * it is intended to be called at hook level inside components and anticipates
 * future reactive dependencies.
 *
 * Returns the reason the current composer surface cannot edit the PR-root body,
 * or null if editing is permitted.
 */
export function useCantEditRootBodyReason({
  readOnly,
  ownerKey,
  prRootHolder,
}: Args): CantEditRootBodyReason {
  if (readOnly) return 'editing-in-other-tab';
  if (prRootHolder === null || prRootHolder === ownerKey) return null;
  if (prRootHolder === 'reply-composer') return 'editing-in-overview-composer';
  if (prRootHolder === 'submit-dialog') return 'editing-in-submit-dialog';
  // The remaining ownerKeys ('files-tab'/'drafts-tab') never anchor a PR-root
  // draft — those surfaces require a file path — so reaching here means a
  // non-root surface holds it. Treat as unblocked (the registration would be
  // suspect, but this is a pure read, not the place to assert).
  return null;
}
