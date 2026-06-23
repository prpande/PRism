// Shared PR-state octicons (Primer v19, 16-viewBox). Extracted from InboxRow (#501)
// so InboxRow and PrHeader render the identical glyph set. The `draft` entry is new.
//
// #530 — this module also exports the `PrStateGlyph` component (below) so the inbox
// rows, PR detail header, and the open-PR tab strip render the identical SVG, not just
// the identical path data. Kept in this one file (lowercase `prStateGlyph`) rather than
// a separate `PrStateGlyph.tsx` to avoid a case-only filename collision that resolves
// inconsistently between case-insensitive Windows and case-sensitive Linux CI.
import styles from './prStateGlyph.module.css';

export type GlyphState = 'open' | 'merged' | 'closed' | 'draft';

/**
 * Canonical PR-flags → GlyphState precedence (#530): merged/closed win over draft;
 * draft only applies while the PR is still open. Co-located with the glyph it drives
 * so the tab strip, header, and inbox can share ONE precedence rule instead of
 * hand-copying the ternary and relying on a comment to keep them in sync.
 */
export function glyphStateFor(pr: {
  isMerged?: boolean;
  isClosed?: boolean;
  isDraft?: boolean;
}): GlyphState {
  return pr.isMerged ? 'merged' : pr.isClosed ? 'closed' : pr.isDraft ? 'draft' : 'open';
}

export const PR_GLYPH_PATH: Record<GlyphState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged:
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
  closed:
    'M10.72 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.75.75 0 1 1 1.06 1.061l-.97.97.97.97a.75.75 0 1 1-1.06 1.06l-.97-.97-.97.97a.75.75 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Zm-9.22 2.02a2.25 2.25 0 1 1 3 2.123v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm10.5 7.503a2.25 2.25 0 1 1-1.5 0V8.755a.75.75 0 0 1 1.5 0ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  draft:
    'M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM12.75 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z',
};

export const PR_GLYPH_CLASS: Record<GlyphState, string> = {
  open: 'prOpen',
  merged: 'prMerged',
  closed: 'prClosed',
  draft: 'prDraft',
};

// Single source for both the SVG <title> tooltip and the aria state word (mirrors
// CI_GLYPH_LABEL). NOTE: the inbox aria-label uses a lowercased state token ("· draft")
// derived separately; this label is the human-readable tooltip/title text.
export const PR_GLYPH_LABEL: Record<GlyphState, string> = {
  open: 'PR open',
  merged: 'PR merged',
  closed: 'PR closed',
  draft: 'Draft PR',
};

interface PrStateGlyphProps {
  state: GlyphState;
  /** Extra class for the host's layout context (e.g. the inbox status slot). */
  className?: string;
}

/**
 * Shared PR-state octicon (#530). Single source of the rendered glyph so the inbox
 * rows, PR detail header, and the open-PR tab strip never drift in shape, colour, or
 * tooltip — they previously hand-rolled three copies of this SVG over the same path
 * data.
 *
 * Decorative by design: `aria-hidden` so the glyph never announces — every host already
 * carries the state word in its accessible name (the inbox row / header status text and
 * the tab `aria-label`). The `<title>` is a pointer-hover tooltip only.
 */
export function PrStateGlyph({ state, className }: PrStateGlyphProps) {
  const cls = [styles.prState, styles[PR_GLYPH_CLASS[state]], className].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      data-pr-state={state}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <title>{PR_GLYPH_LABEL[state]}</title>
      <path d={PR_GLYPH_PATH[state]} />
    </svg>
  );
}
