interface DangerGlyphProps {
  /** Extra classes — lets the consumer size/position the glyph. */
  className?: string;
}

/**
 * Decorative danger/alert glyph (a circled exclamation). Purely presentational
 * and `aria-hidden` — the surrounding dialog/alert text carries the meaning.
 * Shared so `ErrorModal` (and any future danger surface) can reuse the exact
 * same mark. See #182.
 */
export function DangerGlyph({ className }: DangerGlyphProps) {
  return (
    <svg
      className={className}
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="currentColor"
    >
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.75 3.5a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-1.5 0v-4zM8 12.25A.875.875 0 1 1 8 10.5a.875.875 0 0 1 0 1.75z" />
    </svg>
  );
}
