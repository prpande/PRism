import type { CheckConclusion, CheckRun } from '../../api/types';

export type ChecksLeadGlyph = 'in-progress' | 'all-green' | 'none';

// Matches the header chip: the detector counts cancelled/timed_out as failing.
export const FAILING_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>([
  'failure',
  'timed-out',
  'cancelled',
]);

// Conclusions excluded from the all-green decision: a `skipped` check didn't run, so it
// should neither count as a pass nor block the green tick. A PR of [success, skipped]
// is "all green". (Failing conclusions are handled separately; action-required is NOT
// here on purpose — it's a manual gate that must still suppress the green tick.)
const IGNORED_FOR_ALL_GREEN: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>(['skipped']);

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';
const isFailing = (c: CheckRun) => c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion);
const isGreen = (c: CheckRun) => c.conclusion === 'success';
const countsForAllGreen = (c: CheckRun) =>
  c.conclusion == null || !IGNORED_FOR_ALL_GREEN.has(c.conclusion);

export interface ChecksGlyphState {
  lead: ChecksLeadGlyph;
  failingCount: number;
  ariaSummary: string;
}

export function checksGlyphState(checks: CheckRun[]): ChecksGlyphState {
  const failingCount = checks.filter(isFailing).length;
  const anyRunning = checks.some(isNonTerminal);
  // Green tick when every check that ran is a success, ignoring skipped checks (which
  // didn't run). action-required still blocks (it is NOT in IGNORED_FOR_ALL_GREEN), so a
  // manual gate suppresses the tick. Requires ≥1 non-ignored check so a skipped-only PR
  // shows no tick (nothing actually passed).
  const considered = checks.filter(countsForAllGreen);
  const allGreen = considered.length > 0 && considered.every(isGreen);

  let lead: ChecksLeadGlyph;
  if (anyRunning) {
    lead = 'in-progress'; // wins even if some checks already failed
  } else if (allGreen) {
    lead = 'all-green';
  } else {
    lead = 'none'; // incl. failing-only / cancelled-only → red badge is the signal, intentionally
  }

  return {
    lead,
    failingCount,
    ariaSummary: ariaSummary(checks, { anyRunning, failingCount, lead }),
  };
}

function ariaSummary(
  checks: CheckRun[],
  {
    anyRunning,
    failingCount,
    lead,
  }: { anyRunning: boolean; failingCount: number; lead: ChecksLeadGlyph },
): string {
  if (checks.length === 0) return 'Checks';
  if (anyRunning) return 'Checks — running';
  if (lead === 'all-green') return 'Checks — all passing';
  if (failingCount === 0) return 'Checks';
  // Name the dominant failing kind when it's a single homogeneous cause; else "N failing".
  const cancelledOnly = checks.every(
    (c) => c.conclusion === 'cancelled' || c.conclusion === 'success',
  );
  if (cancelledOnly && failingCount > 0) {
    return `Checks — ${failingCount} cancelled`;
  }
  return `Checks — ${failingCount} failing`;
}
