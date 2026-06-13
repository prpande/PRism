// Nav-bar "Send feedback" glyph (#430): a bug silhouette — owner-chosen semantics,
// biasing the affordance toward "report a problem." 16×16 / currentColor / stroke-only,
// matching HelpIcon's SVG_PROPS contract and strokeWidth (1.2) so it carries the same
// visual weight as its Help / Settings neighbors in the .gear cluster.
//
// Shape: an upright oval body with a vertical wing seam, two antennae splaying up-out,
// and three legs per side. No interior stroke below 1.0 (the antennae/legs are the thin
// elements most at risk of sub-pixel loss in dark theme at --text-2). If this reads
// cluttered at 16px, the documented fallback is two legs per side (see the #430 spec).
const SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
  fill: 'none' as const,
};

export function FeedbackIcon() {
  return (
    <svg {...SVG_PROPS}>
      {/* Body + wing seam */}
      <ellipse cx="8" cy="8.9" rx="3.8" ry="4.6" stroke="currentColor" strokeWidth="1.2" />
      <line x1="8" y1="4.8" x2="8" y2="13.2" stroke="currentColor" strokeWidth="1.2" />
      {/* Antennae */}
      <path
        d="M6.5 4.8 5 2.8 M9.5 4.8 11 2.8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      {/* Legs — three per side */}
      <path
        d="M4.3 6.9 1.9 5.6 M4.1 9 1.7 9 M4.3 11.1 2 12.7 M11.7 6.9 14.1 5.6 M11.9 9 14.3 9 M11.7 11.1 14 12.7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
