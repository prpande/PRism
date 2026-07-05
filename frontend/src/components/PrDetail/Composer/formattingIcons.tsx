import type { JSX } from 'react';
import type { FormatAction } from './markdownFormatting';

const SVG = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  'aria-hidden': true as const,
  focusable: 'false' as const,
};

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.4,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function BoldIcon() {
  return (
    <svg {...SVG}>
      <text x="3" y="12" fontSize="12" fontWeight="700" fill="currentColor">
        B
      </text>
    </svg>
  );
}

export function ItalicIcon() {
  return (
    <svg {...SVG}>
      <text x="4" y="12" fontSize="12" fontStyle="italic" fill="currentColor">
        I
      </text>
    </svg>
  );
}

export function StrikethroughIcon() {
  return (
    <svg {...SVG}>
      <text x="3" y="11" fontSize="11" fill="currentColor">
        S
      </text>
      <line x1="2.5" y1="8" x2="13.5" y2="8" {...stroke} />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg {...SVG}>
      <polyline points="6,4 2,8 6,12" {...stroke} />
      <polyline points="10,4 14,8 10,12" {...stroke} />
    </svg>
  );
}

export function LinkIcon() {
  return (
    <svg {...SVG}>
      <path d="M6.5 9.5a2.5 2.5 0 0 1 0-3.5l2-2a2.5 2.5 0 0 1 3.5 3.5l-1 1" {...stroke} />
      <path d="M9.5 6.5a2.5 2.5 0 0 1 0 3.5l-2 2a2.5 2.5 0 0 1-3.5-3.5l1-1" {...stroke} />
    </svg>
  );
}

export function HeadingIcon() {
  return (
    <svg {...SVG}>
      <text x="2" y="12" fontSize="11" fontWeight="700" fill="currentColor">
        H
      </text>
    </svg>
  );
}

export function QuoteIcon() {
  return (
    <svg {...SVG}>
      <line x1="3" y1="3" x2="3" y2="13" {...stroke} strokeWidth={2} />
      <line x1="6" y1="5" x2="13" y2="5" {...stroke} />
      <line x1="6" y1="8" x2="13" y2="8" {...stroke} />
      <line x1="6" y1="11" x2="11" y2="11" {...stroke} />
    </svg>
  );
}

export function BulletListIcon() {
  return (
    <svg {...SVG}>
      <circle cx="3" cy="5" r="1" fill="currentColor" />
      <circle cx="3" cy="11" r="1" fill="currentColor" />
      <line x1="6" y1="5" x2="14" y2="5" {...stroke} />
      <line x1="6" y1="11" x2="14" y2="11" {...stroke} />
    </svg>
  );
}

export function NumberedListIcon() {
  return (
    <svg {...SVG}>
      <text x="1.5" y="6.5" fontSize="5" fill="currentColor">
        1
      </text>
      <text x="1.5" y="12.5" fontSize="5" fill="currentColor">
        2
      </text>
      <line x1="6" y1="5" x2="14" y2="5" {...stroke} />
      <line x1="6" y1="11" x2="14" y2="11" {...stroke} />
    </svg>
  );
}

export function TaskListIcon() {
  return (
    <svg {...SVG}>
      <rect x="2" y="3" width="5" height="5" rx="1" {...stroke} />
      <polyline points="3,5.5 4,6.5 6,4" {...stroke} />
      <line x1="9" y1="5.5" x2="14" y2="5.5" {...stroke} />
      <line x1="9" y1="11" x2="14" y2="11" {...stroke} />
      <rect x="2" y="9" width="5" height="5" rx="1" {...stroke} />
    </svg>
  );
}

export function MoreIcon() {
  return (
    <svg {...SVG}>
      <circle cx="3.5" cy="8" r="1.2" fill="currentColor" />
      <circle cx="8" cy="8" r="1.2" fill="currentColor" />
      <circle cx="12.5" cy="8" r="1.2" fill="currentColor" />
    </svg>
  );
}

export const ICONS: Record<FormatAction, () => JSX.Element> = {
  bold: BoldIcon,
  italic: ItalicIcon,
  strikethrough: StrikethroughIcon,
  code: CodeIcon,
  link: LinkIcon,
  heading: HeadingIcon,
  quote: QuoteIcon,
  bulleted: BulletListIcon,
  numbered: NumberedListIcon,
  task: TaskListIcon,
};
