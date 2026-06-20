// Shared geometry for the Prism pyramid glyph (the "made by AI" / "thinking" mark).
//
// The mark is a square-base pyramid (the Prism app icon) modeled in 3D: an apex
// plus four base corners, eight edges, projected at a fixed 26° elevation. At
// rotation 0 the projection reproduces the app icon exactly; PrismThinking spins
// theta on the vertical axis. PrismGlyph freezes at the resting pose (theta = 0).
//
// This module holds the pure math + constants so the static and animated glyphs
// (PrismGlyph, PrismThinking) share one source of truth. Ported from the
// hand-authored prism-glyph-kit (PrismThinking.jsx) to TypeScript.

export interface Vertex {
  x: number;
  y: number;
  z: number;
}
export interface Point {
  x: number;
  y: number;
  z: number;
}
// The five vertex labels (A apex + B/C/D/E base corners). NB: an EDGE is a *pair*
// of these keys (see EDGES) — this type names a vertex, not an edge.
export type VertexKey = 'A' | 'B' | 'C' | 'D' | 'E';

export const VERTS: Record<VertexKey, Vertex> = {
  A: { x: 0, y: 1.84, z: 0 }, // apex
  B: { x: -1, y: 0, z: 0 }, // left
  C: { x: 1, y: 0, z: 0 }, // right
  D: { x: 0, y: 0, z: 1 }, // front
  E: { x: 0, y: 0, z: -1 }, // back
};

// Typed vertex keys, so callers iterate without re-casting `for…in` keys each time.
export const VERT_KEYS = Object.keys(VERTS) as VertexKey[];

export const EDGES: ReadonlyArray<readonly [VertexKey, VertexKey]> = [
  ['A', 'B'],
  ['A', 'C'],
  ['A', 'D'],
  ['A', 'E'],
  ['B', 'D'],
  ['D', 'C'],
  ['C', 'E'],
  ['E', 'B'],
];

export const TILT = (26 * Math.PI) / 180;

// 8-point sparkle that breathes in the top-right corner (currentColor fill).
export const SPARK_PATH =
  'M12 0 C13 7 17 11 24 12 C17 13 13 17 12 24 C11 17 7 13 0 12 C7 11 11 7 12 0 Z';

/** Rotate a vertex by theta about the vertical axis, then project at elevation e
 *  into 2D (with z retained for near/far depth shading). */
export function project(
  v: Vertex,
  theta: number,
  e: number,
  S: number,
  cx: number,
  cy: number,
): Point {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const x = v.x * c + v.z * s;
  const z = -v.x * s + v.z * c;
  const y = v.y;
  const ce = Math.cos(e);
  const se = Math.sin(e);
  return { x: cx + x * S, y: cy - (y * ce - z * se) * S, z: y * se + z * ce };
}

/** Project every vertex at rotation theta / elevation e into one keyed map. Shared by the
 *  resting pose (REST) and PrismThinking's per-frame draw, so both spin the same geometry. */
export function projectAll(
  theta: number,
  e: number,
  S: number,
  cx: number,
  cy: number,
): Record<VertexKey, Point> {
  const P = {} as Record<VertexKey, Point>;
  for (const k of VERT_KEYS) P[k] = project(VERTS[k], theta, e, S, cx, cy);
  return P;
}

// Fit the figure into a 0..100 viewBox once (stable across the full rotation).
export const FIT = (() => {
  const pad = 13;
  let maxAX = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < 60; i++) {
    const th = (i / 60) * Math.PI * 2;
    for (const k of VERT_KEYS) {
      const p = project(VERTS[k], th, TILT, 1, 0, 0);
      maxAX = Math.max(maxAX, Math.abs(p.x));
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  const S = Math.min((100 - 2 * pad) / (2 * maxAX), (100 - 2 * pad) / (maxY - minY));
  return { S, cx: 50, cy: 50 - ((minY + maxY) / 2) * S };
})();

// Resting pose (theta = 0) — this projection is the original Prism icon.
export const REST = projectAll(0, TILT, FIT.S, FIT.cx, FIT.cy);
