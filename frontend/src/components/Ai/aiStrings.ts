/** Single source of truth for AI marker accessible labels — provenance (#489) and working state (#508). */
export const AI_PROVENANCE_LABEL = 'AI-generated';
export const AI_WORKING_LABEL = 'AI is working…';
/** File-tree header idle marker (#508): the persistent "AI ran here" cue is visual-only
 *  (decorative glyph). On the empty result there is no per-row "AI focus" signal either,
 *  so this sr-only label is the only thing announcing that AI analyzed the files. */
export const AI_TREE_ANALYZED_LABEL = 'AI has analyzed these files';
