// Accent-colored inline-SVG icons for each HelpModal accordion section.
// Convention: width/height 18, viewBox '0 0 18 18', aria-hidden, focusable="false",
// stroke/fill currentColor so a parent .sectionIcon { color: var(--accent) } wrapper
// renders them in the user's chosen accent and tracks it automatically.

const SVG_PROPS = {
  width: 18,
  height: 18,
  viewBox: '0 0 18 18',
  'aria-hidden': true as const,
  focusable: 'false' as const,
  fill: 'none' as const,
};

/** What PRism is — spark / info circle */
export function InfoSparkIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.5" />
      <line
        x1="9"
        y1="8"
        x2="9"
        y2="13"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="9" cy="5.5" r="0.75" fill="currentColor" />
    </svg>
  );
}

/** The review loop — refresh / cycle arrows */
export function RefreshIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path
        d="M14.5 9A5.5 5.5 0 0 1 4.2 12.8"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M3.5 9A5.5 5.5 0 0 1 13.8 5.2"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <polyline
        points="12,3.5 14,5.2 12.2,7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <polyline
        points="6,14.5 4,12.8 5.8,11"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

/** The main surfaces — layout / panels */
export function LayoutIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <line
        x1="2"
        y1="6.5"
        x2="16"
        y2="6.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <line
        x1="8"
        y1="6.5"
        x2="8"
        y2="16"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Connecting your token — key */
export function KeyIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="7" cy="8" r="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.8 10.2 L15 15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="12.5"
        y1="13"
        x2="14"
        y2="11.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="14"
        y1="14"
        x2="15.5"
        y2="12.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Keyboard shortcuts — keyboard */
export function KeyboardIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect
        x="1.5"
        y="4.5"
        width="15"
        height="9"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <line
        x1="4.5"
        y1="7.5"
        x2="4.5"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="7.5"
        y1="7.5"
        x2="7.5"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="10.5"
        y1="7.5"
        x2="10.5"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="13.5"
        y1="7.5"
        x2="13.5"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <line
        x1="6"
        y1="10.5"
        x2="12"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Send feedback — chat bubble */
export function ChatIcon() {
  return (
    <svg {...SVG_PROPS}>
      <path
        d="M3 3.5h12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 15 13.5H6.5L3 16V5A1.5 1.5 0 0 1 4.5 3.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <line
        x1="6"
        y1="7.5"
        x2="12"
        y2="7.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <line
        x1="6"
        y1="10"
        x2="10"
        y2="10"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
