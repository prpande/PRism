// frontend/src/components/Ai/SparkIcon.tsx
export interface SparkIconProps {
  /** Pixel size; defaults to 18. CSS width/height on `className` also overrides. */
  size?: number;
  className?: string;
}

/** AI sparkle glyph (relocated from pages/welcomeIcons.tsx). Monochrome, decorative,
 *  currentColor so a parent sets the colour; size via prop or CSS. */
export function SparkIcon({ size = 18, className }: SparkIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
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
