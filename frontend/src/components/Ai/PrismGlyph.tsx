import { EDGES, REST, SPARK_PATH } from './prismGeometry';

export interface PrismGlyphProps {
  /** Pixel size; defaults to 18. A CSS width/height via `className` overrides it
   *  (AiMarker sizes the glyph to 1em through its module CSS). */
  size?: number;
  /** Show the corner sparkle. Default true (pyramid + sparkle = the "AI" mark). */
  sparkle?: boolean;
  className?: string;
}

/** PrismGlyph — the steady Prism pyramid mark (no animation), frozen at its
 *  resting pose, which is exactly the Prism app icon. The static "made by AI"
 *  provenance glyph. Decorative + currentColor so a parent owns colour and
 *  accessible labelling (see AiMarker). Ported from the prism-glyph-kit. */
export function PrismGlyph({ size = 18, sparkle = true, className }: PrismGlyphProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      // overflow:visible lets the sparkle sit just outside the top-right corner.
      style={{ overflow: 'visible', display: 'block' }}
    >
      {EDGES.map((ed, i) => {
        const a = REST[ed[0]];
        const b = REST[ed[1]];
        return (
          <line
            key={i}
            x1={a.x.toFixed(2)}
            y1={a.y.toFixed(2)}
            x2={b.x.toFixed(2)}
            y2={b.y.toFixed(2)}
            stroke="currentColor"
            strokeWidth={3.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {sparkle && (
        <path
          d={SPARK_PATH}
          fill="currentColor"
          transform="translate(80 17) scale(0.72) translate(-12 -12)"
        />
      )}
    </svg>
  );
}
