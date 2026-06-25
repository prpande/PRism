import type { CheckConclusion, CheckRun } from '../../api/types';

export type ChecksLeadGlyph = 'in-progress' | 'failing' | 'all-green' | 'none';

// Matches the header chip: the detector counts cancelled/timed_out as failing.
export const FAILING_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>([
  'failure',
  'timed-out',
  'cancelled',
]);

// Conclusions ignored UNIFORMLY across all three lead-glyph decisions (in-progress,
// failing, all-green): a `skipped` check didn't run, so it never counts toward running,
// failing, or passing. A PR of [success, skipped] is "all green"; [failure, skipped] is
// failing. action-required is intentionally NOT here — it's a manual gate that must still
// suppress the green tick. Skipped is already neither non-terminal nor failing, so today
// this only affects the all-green decision; filtering once keeps the rule uniform and
// future-proof if the ignore set grows (e.g. neutral/stale).
const IGNORED_CONCLUSIONS: ReadonlySet<CheckConclusion> = new Set<CheckConclusion>(['skipped']);

const isNonTerminal = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';
const isFailing = (c: CheckRun) => c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion);
const isGreen = (c: CheckRun) => c.conclusion === 'success';
const isConsidered = (c: CheckRun) =>
  c.conclusion == null || !IGNORED_CONCLUSIONS.has(c.conclusion);

export interface ChecksGlyphState {
  lead: ChecksLeadGlyph;
  failingCount: number;
  ariaSummary: string;
}

export function checksGlyphState(checks: CheckRun[]): ChecksGlyphState {
  // Filter the ignored conclusions ONCE so in-progress, failing, and all-green all derive
  // from the same considered set (skipped behavior is common to all three glyphs).
  const considered = checks.filter(isConsidered);
  const failingCount = considered.filter(isFailing).length;
  const anyRunning = considered.some(isNonTerminal);
  const allGreen = considered.length > 0 && considered.every(isGreen);

  let lead: ChecksLeadGlyph;
  if (anyRunning) {
    lead = 'in-progress'; // wins while the verdict isn't final, even if some checks already failed
  } else if (failingCount > 0) {
    // terminal with ≥1 failure/timed-out/cancelled → red cross. A [skipped, failure] PR
    // reads as failing (skipped is ignored everywhere but never masks a real failure).
    lead = 'failing';
  } else if (allGreen) {
    lead = 'all-green';
  } else {
    lead = 'none'; // terminal, no failures, nothing actually passed (e.g. skipped/neutral-only)
  }

  return {
    lead,
    failingCount,
    ariaSummary: ariaSummary(considered, { anyRunning, failingCount, lead }),
  };
}

function ariaSummary(
  considered: CheckRun[],
  {
    anyRunning,
    failingCount,
    lead,
  }: { anyRunning: boolean; failingCount: number; lead: ChecksLeadGlyph },
): string {
  if (considered.length === 0) return 'Checks';
  if (anyRunning) return 'Checks — running';
  if (lead === 'all-green') return 'Checks — all passing';
  if (failingCount === 0) return 'Checks';
  // Name the dominant failing kind when it's a single homogeneous cause; else "N failing".
  const cancelledOnly = considered.every(
    (c) => c.conclusion === 'cancelled' || c.conclusion === 'success',
  );
  if (cancelledOnly && failingCount > 0) {
    return `Checks — ${failingCount} cancelled`;
  }
  return `Checks — ${failingCount} failing`;
}
