import { useRef, useEffect } from 'react';
import { EDGES, TILT, SPARK_PATH, FIT, VERT_KEYS, projectAll } from './prismGeometry';

export interface PrismThinkingProps {
  /** Pixel size; defaults to 18. A CSS width/height via `className` overrides it
   *  (AiMarker sizes the glyph to 1em through its module CSS). */
  size?: number;
  /** Spin speed multiplier. Default 1. */
  speed?: number;
  /** Show the breathing corner sparkle. Default true. */
  sparkle?: boolean;
  className?: string;
}

/** PrismThinking — the animated "AI is thinking / generating" mark.
 *
 *  The Prism pyramid (PrismGlyph) modeled in 3D and spun on its vertical axis,
 *  with a sparkle that breathes in the top-right corner. At rest (or under
 *  prefers-reduced-motion) it reads exactly as the static PrismGlyph.
 *
 *  Decorative + currentColor: a parent (AiMarker) owns colour and the accessible
 *  label / tooltip. Motion runs on a single requestAnimationFrame loop that writes
 *  SVG attributes directly (no React re-render per frame); the loop is cancelled on
 *  unmount. Ported from the hand-authored prism-glyph-kit (PrismThinking.jsx). */
export function PrismThinking({
  size = 18,
  speed = 1,
  sparkle = true,
  className,
}: PrismThinkingProps) {
  const lineRefs = useRef<Array<SVGLineElement | null>>([]);
  const sparkRef = useRef<SVGPathElement | null>(null);

  useEffect(() => {
    // Read prefers-reduced-motion once at mount. Known limitation: toggling the OS
    // setting mid-mount won't take effect until the component remounts — accepted
    // here (the same trade-off React Spring / Framer Motion make for rAF loops), and
    // these markers remount frequently as AI state flips working↔idle. Not worth a
    // change-listener + rAF-restart for that edge case.
    const mq = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)');
    const reduced = mq ? mq.matches : false;
    const { S, cx, cy } = FIT;
    const t0 = performance.now();
    let raf = 0;

    const draw = (now: number) => {
      const t = reduced ? 0 : ((now - t0) / 1000) * speed;
      let theta = t * Math.PI;
      theta += 0.1 * Math.sin(theta); // gentle organic ease
      const e = TILT + 0.04 * Math.sin(t * 0.9); // subtle tilt breathing

      const P = projectAll(theta, e, S, cx, cy);

      let zmin = Infinity;
      let zmax = -Infinity;
      for (const k of VERT_KEYS) {
        zmin = Math.min(zmin, P[k].z);
        zmax = Math.max(zmax, P[k].z);
      }
      const zr = zmax - zmin || 1;

      EDGES.forEach((ed, i) => {
        const a = P[ed[0]];
        const b = P[ed[1]];
        const l = lineRefs.current[i];
        if (!l) return;
        l.setAttribute('x1', a.x.toFixed(2));
        l.setAttribute('y1', a.y.toFixed(2));
        l.setAttribute('x2', b.x.toFixed(2));
        l.setAttribute('y2', b.y.toFixed(2));
        const zc = ((a.z + b.z) / 2 - zmin) / zr; // 0 far .. 1 near
        l.setAttribute('stroke-opacity', (0.45 + 0.55 * zc).toFixed(3));
        // Weight tracks the idle PrismGlyph default (~5): near edges ~5.6, far ~4.2,
        // so the spinning mark reads at the same device weight as the resting glyph
        // (the old 2.5–3.4 range antialiased to a pale hairline — #7/#10).
        l.setAttribute('stroke-width', (4.2 + 1.4 * zc).toFixed(2));
      });

      if (sparkRef.current) {
        const ph = reduced ? 0.6 : 0.5 - 0.5 * Math.cos((2 * Math.PI * (t % 2.4)) / 2.4);
        const sc = 0.74 + 0.3 * ph;
        // Base 1.125 matches the idle glyph's sparkle at the heavier default stroke
        // (#7), so the breathing sparkle stays proportionate to the thicker edges.
        sparkRef.current.setAttribute(
          'transform',
          `translate(80 17) scale(${(1.125 * sc).toFixed(3)}) translate(-12 -12)`,
        );
        sparkRef.current.setAttribute('opacity', (0.45 + 0.55 * ph).toFixed(3));
      }

      if (reduced) return; // hold the resting pose; no further frames
      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // `sparkle` is intentionally not a dep: the sparkle branch is guarded by the
    // sparkRef (null when sparkle={false}), so toggling it needs no effect restart.
  }, [speed]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ overflow: 'visible', display: 'block' }}
    >
      {EDGES.map((_, i) => (
        <line
          key={i}
          ref={(el) => {
            lineRefs.current[i] = el;
          }}
          stroke="currentColor"
          strokeWidth={5}
          strokeLinecap="round"
        />
      ))}
      {sparkle && <path ref={sparkRef} d={SPARK_PATH} fill="currentColor" />}
    </svg>
  );
}
