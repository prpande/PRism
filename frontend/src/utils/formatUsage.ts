// #517 — shared usage formatters. A naive 2-dp cost format renders real sub-cent figures as
// "$0.00", reading as "AI is free"; use 4 dp below a cent. Token counts stay well under 10M, so
// no abbreviation — locale thousands separators only.

export function formatCost(usd: number): string {
  const sub = usd !== 0 && Math.abs(usd) < 0.01;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: sub ? 4 : 2,
    maximumFractionDigits: sub ? 4 : 2,
  }).format(usd);
}

export function formatTokens(count: number): string {
  return count.toLocaleString('en-US');
}

// Trend bucket labels. Buckets are UTC-anchored server-side (day buckets key on UTC midnight), so
// the label must name that UTC calendar day — rendering in the viewer's local zone shifts a
// UTC-negative user's labels back a day on both the decorative bar and the sr-only summary.
export function formatBucketDate(bucketStartIso: string): string {
  return new Date(bucketStartIso).toLocaleDateString('en-US', { timeZone: 'UTC' });
}
