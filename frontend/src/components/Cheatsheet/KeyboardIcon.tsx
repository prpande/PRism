// Decorative keyboard glyph for the cheatsheet header. Mirrors the inline-SVG
// convention used by the header icons (HelpIcon/FeedbackIcon): currentColor
// strokes/fills so it inherits the heading colour, aria-hidden + focusable=false
// so assistive tech ignores it (the adjacent <h2> carries the accessible name).
const SVG_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

export function KeyboardIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect
        x="1.4"
        y="4.3"
        width="13.2"
        height="7.4"
        rx="1.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      {/* Two rows of keys + a spacebar. */}
      <g fill="currentColor">
        <circle cx="4.2" cy="6.8" r="0.55" />
        <circle cx="6.4" cy="6.8" r="0.55" />
        <circle cx="8.6" cy="6.8" r="0.55" />
        <circle cx="10.8" cy="6.8" r="0.55" />
        <circle cx="4.2" cy="8.7" r="0.55" />
        <circle cx="6.4" cy="8.7" r="0.55" />
        <circle cx="8.6" cy="8.7" r="0.55" />
        <circle cx="10.8" cy="8.7" r="0.55" />
        <rect x="5" y="9.9" width="6" height="1.1" rx="0.55" />
      </g>
    </svg>
  );
}
