import { useId } from 'react';

// Shared Octicon comment-16. Single source for the inbox PR-row comment-count
// glyph (#501) and the file-tree per-file comment indicator (#513) so the two
// sites cannot drift in shape. Colour comes from the consumer via currentColor;
// the consumer attaches sizing/layout through className.

// The octicon comment-16 is TWO subpaths: the outer silhouette, then an inner
// counter that hollows it into an outline. Splitting them lets us render the same
// bubble either filled (outer only) or as an outline (both). #513.
const BUBBLE_OUTER =
  'M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1Z';
const BUBBLE_COUNTER =
  'M1.5 2.75v8.5a.25.25 0 0 0 .25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z';
const BUBBLE_OUTLINE = `${BUBBLE_OUTER}${BUBBLE_COUNTER}`;

// The bare check octicon the inbox uses for a passing CI run (InboxRow CI_GLYPH_PATH.passing),
// reused verbatim so "resolved comment" reads as the same success mark. #513.
const CHECK_PATH =
  'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z';

/**
 * - `outline` (default): hollow bubble. The inbox comment-count pill and the
 *   base shape both sites share.
 * - `filled`: solid bubble — the file tree's "has open/unresolved threads" state,
 *   so open reads as a heavier mark than resolved. #513.
 * - `resolved`: hollow bubble + the CI-passing check (in --success-fg) knocked
 *   into its bottom-right corner. The file tree's "all threads resolved" state;
 *   reads by SHAPE, not just the dimmed colour. #513.
 */
type CommentGlyphVariant = 'outline' | 'filled' | 'resolved';

interface CommentGlyphProps {
  /** Layout/sizing class for the host (e.g. the inbox pill-icon class). */
  className?: string;
  variant?: CommentGlyphVariant;
}

export function CommentGlyph({ className, variant = 'outline' }: CommentGlyphProps) {
  // Unique per instance so the many resolved rows don't collide on one mask id.
  const maskId = useId();
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="currentColor"
      aria-hidden="true"
    >
      {variant === 'filled' && <path data-comment-fill="" d={BUBBLE_OUTER} />}
      {variant === 'outline' && <path d={BUBBLE_OUTLINE} />}
      {variant === 'resolved' && (
        <>
          <mask id={maskId}>
            <rect width="16" height="16" fill="white" />
            {/* transparent hole where the check sits — row surface shows through */}
            <circle cx="11.6" cy="11.6" r="4.7" fill="black" />
          </mask>
          <path d={BUBBLE_OUTLINE} mask={`url(#${maskId})`} />
          <path
            data-resolved-tick=""
            d={CHECK_PATH}
            fill="var(--success-fg)"
            transform="translate(6.7 6.5) scale(0.6)"
          />
        </>
      )}
    </svg>
  );
}
