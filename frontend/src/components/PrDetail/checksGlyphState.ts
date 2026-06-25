import type { CheckConclusion, CheckRun } from '../../api/types';

export type ChecksLeadGlyph = 'in-progress' | 'all-green' | 'none';

// Matches the header chip: the detector counts cancelled/timed_out as failing.
export const FAILING_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>([
  'failure',
  'timed-out',
  'cancelled',
]);

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';
const isFailing = (c: CheckRun) => c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion);
const isGreen = (c: CheckRun) => c.conclusion === 'success';

export interface ChecksGlyphState {
  lead: ChecksLeadGlyph;
  failingCount: number;
  ariaSummary: string;
}

export function checksGlyphState(checks: CheckRun[]): ChecksGlyphState {
  const failingCount = checks.filter(isFailing).length;
  const anyRunning = checks.some(isNonTerminal);
  const allGreen = checks.length > 0 && checks.every(isGreen);

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
