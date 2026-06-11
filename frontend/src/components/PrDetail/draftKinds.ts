import type { DraftCommentDto, DraftReplyDto } from '../../api/types';

// #324 — the single canonical "is this the PR-root draft (the review summary, not a line
// comment)?" predicate, mirroring backend DraftComment.IsPrRoot. FilePath is the discriminator: a
// draft with no file path cannot be anchored to a line, so lineNumber is vestigial when filePath is
// null. Every PR-root-identity site uses this; do not re-spell it inline (the old
// `filePath === null && lineNumber === null` form disagreed with the backend on a half-null draft).
export function isPrRootDraft(d: DraftCommentDto): boolean {
  return d.filePath === null;
}

// Selector for the common `.find(isPrRootDraft) ?? null` shape.
export function prRootDraft(drafts: readonly DraftCommentDto[]): DraftCommentDto | null {
  return drafts.find(isPrRootDraft) ?? null;
}

// Shared discriminated union for drafts in UI lists. Both DraftListItem
// (DraftsTab) and StaleDraftRow (UnresolvedPanel) operate on the same
// shape — keeping a single definition prevents structural drift between
// the two surfaces.
export type DraftLike =
  | { kind: 'comment'; data: DraftCommentDto }
  | { kind: 'reply'; data: DraftReplyDto };
