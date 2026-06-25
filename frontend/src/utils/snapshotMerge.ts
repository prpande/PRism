// Snapshot-merge a live field against a fallback: take the primary value whenever it is DEFINED —
// including an explicit `null`, which a live SSE event sends to CLEAR a now-empty category (e.g. the
// last approval was dismissed). Only when the primary is genuinely absent (`undefined`) do we keep
// the fallback. `??` would be wrong here: it treats a `null` clear as "no value" and falls back to
// the stale prior/full-load value, leaving the cleared list or count on screen (#621 review).
export function snapshot<T>(primary: T | undefined, fallback: T | undefined): T | undefined {
  return primary !== undefined ? primary : fallback;
}
