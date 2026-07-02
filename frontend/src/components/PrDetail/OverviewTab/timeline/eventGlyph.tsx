import { PR_GLYPH_PATH } from '../../../shared/prStateGlyph';
import type { ActivityVerb } from '../../../../api/types';

// #620 — maps a timeline verb to the octicon + colour tone rendered in the rail's node badge.
// The PR-state octicons (opened/closed/merged) are reused from the shared prStateGlyph set so the
// feed never drifts from the inbox/header/tab-strip glyphs; the review/comment/commit/eye/alert
// octicons (Primer 16-viewBox) are declared here, the only place that needs them.
export type GlyphTone = 'success' | 'warning' | 'danger' | 'merged' | 'accent' | 'neutral';

const CHECK =
  'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';
const ALERT =
  'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z';
const COMMENT =
  'M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1Zm0 1.5a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Z';
const EYE =
  'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.831.88 9.577.43 8.899a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.023C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z';
const COMMIT =
  'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z';
const DOT = 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z';

export interface VerbMeta {
  tone: GlyphTone;
  path: string;
}

export function verbMeta(verb: ActivityVerb): VerbMeta {
  switch (verb) {
    case 'opened':
    case 'reopened':
      return { tone: 'success', path: PR_GLYPH_PATH.open };
    case 'closed':
      return { tone: 'danger', path: PR_GLYPH_PATH.closed };
    case 'merged':
      return { tone: 'merged', path: PR_GLYPH_PATH.merged };
    case 'approved':
      return { tone: 'success', path: CHECK };
    case 'changes-requested':
      return { tone: 'warning', path: ALERT };
    case 'review-requested':
      return { tone: 'accent', path: EYE };
    case 'pushed':
      return { tone: 'neutral', path: COMMIT };
    case 'commented':
    case 'reviewed':
      return { tone: 'neutral', path: COMMENT };
    default:
      return { tone: 'neutral', path: DOT };
  }
}

// The comment/commit octicons are also used directly by ActivityFeed (a conversation card always
// reads as a comment bubble; a commit group always reads as a commit node) regardless of the verb's
// own glyph, so they are exported for those fixed-glyph sites.
export const COMMENT_PATH = COMMENT;
export const COMMIT_PATH = COMMIT;

/** The 16-viewBox octicon `<svg>` used inside a rail node badge. Decorative (`aria-hidden`). */
export function GlyphIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
