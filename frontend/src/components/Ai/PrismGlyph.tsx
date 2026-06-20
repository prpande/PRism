import { EDGES, REST, SPARK_PATH } from './prismGeometry';

export interface PrismGlyphProps {
  /** Pixel size; defaults to 18. A CSS width/height via `className` overrides it
   *  (AiMarker sizes the glyph to 1em through its module CSS). */
  size?: number;
  /** Show the corner sparkle. Default true (pyramid + sparkle = the "AI" mark). */
  sparkle?: boolean;
  /** Edge stroke width in the 100-unit viewBox. Default 5 (the inline AiMarker
   *  render weight). Override heavier when the glyph sits as a larger decorative
   *  mark — e.g. the /welcome benefit row or the AI modal titles, which pass
   *  DECORATIVE_PRISM_STROKE. */
  strokeWidth?: number;
  className?: string;
}

/** The stroke the sparkle scale (0.72) was originally calibrated against. The sparkle
 *  grows linearly from here, so changing the render default (DEFAULT_STROKE) below does
 *  not disturb the decorative-weight sparkle approved for /welcome. */
const SPARKLE_REF_STROKE = 3.2;
const BASE_SPARKLE_SCALE = 0.72;

/** Default edge weight for the inline AiMarker glyph. The geometry renders into a
 *  100-unit viewBox at ~16px (1em), so this lands the edges at ~0.8 device-px. The
 *  former 3.2 scaled to a ~0.5px hairline that antialiased to half-coverage and read
 *  far paler than its (already accent-saturated) colour token — the "AI glyph looks
 *  too light" report (#10). The heavier default also enlarges the sparkle (#7). */
const DEFAULT_STROKE = 5;

/** Stroke weight for the prism when it stands alone as a decorative ~18px glyph
 *  (the /welcome benefit row, the AI onboarding modal title) rather than as the
 *  inline-text AiMarker. The SPARKLE_REF_STROKE of 3.2 is tuned for AiMarker's 1em flow;
 *  at a fixed 18px it scales to a sub-pixel hairline that reads thinner and paler
 *  than the bold text / sibling line-icons next to it. 7.5 lands the edges at
 *  ~1.35 device px — sitting at the same visual weight — and proportionally
 *  enlarges the sparkle so it stays a sparkle, not a dot. */
export const DECORATIVE_PRISM_STROKE = 7.5;

/** PrismGlyph — the steady Prism pyramid mark (no animation), frozen at its
 *  resting pose, which is exactly the Prism app icon. The static "made by AI"
 *  provenance glyph. Decorative + currentColor so a parent owns colour and
 *  accessible labelling (see AiMarker). Ported from the prism-glyph-kit. */
export function PrismGlyph({
  size = 18,
  sparkle = true,
  strokeWidth = DEFAULT_STROKE,
  className,
}: PrismGlyphProps) {
  // The sparkle is a filled path, so a heavier strokeWidth alone leaves it the same
  // tiny dot while the pyramid edges thicken — it stops reading as a sparkle. Scale
  // it with the stroke (against SPARKLE_REF_STROKE) so the mark stays proportionate at
  // any weight: the inline default (5) and the decorative weight (7.5) each get a
  // sparkle sized to their edges.
  const sparkleScale = BASE_SPARKLE_SCALE * (strokeWidth / SPARKLE_REF_STROKE);
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
            strokeWidth={strokeWidth}
            strokeLinecap="round"
          />
        );
      })}
      {sparkle && (
        <path
          d={SPARK_PATH}
          fill="currentColor"
          transform={`translate(80 17) scale(${sparkleScale.toFixed(3)}) translate(-12 -12)`}
        />
      )}
    </svg>
  );
}
