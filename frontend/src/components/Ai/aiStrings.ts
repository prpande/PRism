/** Single source of truth for AI marker accessible labels — provenance (#489) and working state (#508). */
export const AI_PROVENANCE_LABEL = 'AI-generated';
export const AI_WORKING_LABEL = 'AI is working…';
/** Idle/settled marker hover tooltip (#508 follow-up): the at-rest counterpart to
 *  AI_WORKING_LABEL. Surfaced as the native `title` on the idle glyph so a hover over
 *  a finished AI surface confirms the work is done (parallels "AI is working…"). */
export const AI_IDLE_DONE_LABEL = 'AI effort completed';
/** File-tree header idle marker (#508): the persistent "AI ran here" cue is visual-only
 *  (decorative glyph). On the empty result there is no per-row "AI focus" signal either,
 *  so this sr-only label is the only thing announcing that AI analyzed the files. */
export const AI_TREE_ANALYZED_LABEL = 'AI has analyzed these files';
/** Inbox chip slot loading suffix (#508, #548): appended to the row aria-label while
 *  enrichment is in flight so screen readers announce the transient state. */
export const AI_INBOX_ENRICHING_LABEL = 'Categorizing this pull request…';
/** UnresolvedPanel header cue (#508): sr-only label while draft suggestions are loading.
 *  Rendered as a sibling to the aria-live summary span so the marker mount/unmount does
 *  not re-trigger the summary live-region announcement. */
export const AI_DRAFT_REVIEWING_LABEL = 'AI is reviewing your stale drafts…';
