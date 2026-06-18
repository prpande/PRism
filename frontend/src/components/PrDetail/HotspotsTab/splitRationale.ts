import { stripMarkdown } from './stripMarkdown';

// A list-item leader (-, *, +, or "1.") at the start of a line. Used to detect
// the non-conforming case where the model led with a bullet instead of a
// dedicated synopsis line.
const LIST_ITEM_LEADER = /^\s*([-*+]|\d+\.)\s+/;

export interface SplitRationale {
  headline: string;
  body: string;
}

/**
 * Split a synopsis-first rationale into a plain-text headline and a markdown
 * body for the expanded panel (#520, design D2).
 *
 * Conforming case — the first non-empty content line is plain prose (the model
 * led with a synopsis as instructed): headline = that line stripped of markdown,
 * body = everything after it. No duplication.
 *
 * Non-conforming case — the first content line is itself a list item (the model
 * reverted to the pre-#520 bulleted shape) or strips to empty (a fence /
 * thematic break): headline = stripMarkdown(rationale) as a preview, and body =
 * the full rationale from its first content line. The first bullet is NEVER
 * removed, so no detail is lost from the panel (a non-duplicating split is the
 * only thing suppressed).
 */
export function splitRationale(rationale: string): SplitRationale {
  const lines = rationale.split('\n');
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { headline: '', body: '' };

  const firstLine = lines[firstIdx];
  const firstHeadline = stripMarkdown(firstLine);
  const isListItem = LIST_ITEM_LEADER.test(firstLine);

  if (firstHeadline.length > 0 && !isListItem) {
    // Conforming: a dedicated synopsis line. Body is everything after it.
    const body = lines
      .slice(firstIdx + 1)
      .join('\n')
      .trim();
    return { headline: firstHeadline, body };
  }

  // Non-conforming: derive a preview headline but keep the full content in body.
  const body = lines.slice(firstIdx).join('\n').trim();
  return { headline: stripMarkdown(rationale), body };
}
