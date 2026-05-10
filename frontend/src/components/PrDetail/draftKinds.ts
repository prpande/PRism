import type { DraftCommentDto, DraftReplyDto } from '../../api/types';

// Shared discriminated union for drafts in UI lists. Both DraftListItem
// (DraftsTab) and StaleDraftRow (UnresolvedPanel) operate on the same
// shape — keeping a single definition prevents structural drift between
// the two surfaces.
export type DraftLike =
  | { kind: 'comment'; data: DraftCommentDto }
  | { kind: 'reply'; data: DraftReplyDto };
