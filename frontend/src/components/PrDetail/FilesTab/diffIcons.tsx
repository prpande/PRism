// diffIcons.tsx
// Inline SVG reproductions of Azure DevOps PR-compare diff icons
// (bowtie-diff-inline / bowtie-diff-side-by-side) + a settings gear.
// Monochrome currentColor so selection/theme is driven by CSS, not fills.

const SVG_PROPS = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

export function InlineDiffIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect
        x="1.5"
        y="2"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line
        x1="4"
        y1="5.5"
        x2="12"
        y2="5.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="4"
        y1="8"
        x2="12"
        y2="8"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="4"
        y1="10.5"
        x2="12"
        y2="10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function SideBySideDiffIcon() {
  return (
    <svg {...SVG_PROPS}>
      <rect
        x="1.5"
        y="2"
        width="13"
        height="12"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <line x1="8" y1="2" x2="8" y2="14" stroke="currentColor" strokeWidth="1.2" />
      <line
        x1="3.5"
        y1="6"
        x2="6.5"
        y2="6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="3.5"
        y1="9.5"
        x2="6.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="9.5"
        y1="6"
        x2="12.5"
        y2="6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <line
        x1="9.5"
        y1="9.5"
        x2="12.5"
        y2="9.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function GearIcon() {
  return (
    <svg {...SVG_PROPS}>
      <circle cx="8" cy="8" r="2.1" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M8 1.5l1 1.6 1.9-.4.6 1.8 1.8.6-.4 1.9 1.6 1-1.6 1 .4 1.9-1.8.6-.6 1.8-1.9-.4-1 1.6-1-1.6-1.9.4-.6-1.8-1.8-.6.4-1.9-1.6-1 1.6-1-.4-1.9 1.8-.6.6-1.8 1.9.4z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  );
}
