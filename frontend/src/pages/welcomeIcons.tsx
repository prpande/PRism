// Monochrome inline-SVG icons for the /welcome benefit rows (#222). Same
// convention as components/Help/HelpSectionIcons.tsx: 18×18 viewBox, decorative
// (aria-hidden, focusable=false), stroke/fill currentColor so a parent wrapper
// (.benefitIcon) sets the color. These replace the earlier multicolour emoji
// (🔒/⚡/🤖) with a single, restrained icon language that matches the rest of the
// app's iconography.

const SVG_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  'aria-hidden': true as const,
  focusable: 'false' as const,
  fill: 'none' as const,
};

/** Local-first / token security — padlock. */
export function LockIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect x="3.5" y="8" width="11" height="7" rx="1.75" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M5.75 8V6.25a3.25 3.25 0 0 1 6.5 0V8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9" cy="11.25" r="1" fill="currentColor" />
    </svg>
  );
}

/** A workspace made for reviewing — two-pane layout (file tree + diff). */
export function PanelsIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect
        x="2.5"
        y="3"
        width="13"
        height="12"
        rx="1.75"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line x1="7" y1="3" x2="7" y2="15" stroke="currentColor" strokeWidth="1.25" />
      <line
        x1="9.25"
        y1="6.75"
        x2="13"
        y2="6.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <line
        x1="9.25"
        y1="9.25"
        x2="13"
        y2="9.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <line
        x1="9.25"
        y1="11.75"
        x2="11.75"
        y2="11.75"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** AI (in active development) — sparkle. */
export function SparkIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path
        d="M7.5 3.25 8.85 7.65 13 9 8.85 10.35 7.5 14.75 6.15 10.35 2 9 6.15 7.65 Z"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinejoin="round"
      />
      <path
        d="M13.75 3 14.2 4.3 15.5 4.75 14.2 5.2 13.75 6.5 13.3 5.2 12 4.75 13.3 4.3 Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
