// The public feedback repo (#211). Pinned literal — mirrors backend FeedbackRepo.Slug.
export const FEEDBACK_REPO_SLUG = 'prpande/PRism-feedback';

const MAX_URL = 6144; // conservative cap; GitHub's issues/new tolerance is undocumented.

function makeUrl(title: string, body: string): URL {
  const u = new URL(`https://github.com/${FEEDBACK_REPO_SLUG}/issues/new`);
  u.searchParams.set('title', title);
  u.searchParams.set('body', body);
  return u;
}

// Builds a github.com issues/new prefill URL. Always https. Two-stage truncation
// (spec §4.4): drop the auto-appended context block first (preserve user details);
// only if details alone still exceed the cap, truncate details with a marker.
export function buildFeedbackIssueUrl({
  title,
  details,
  context,
}: {
  title: string;
  details: string;
  context: string;
}): string {
  const full = context ? `${details}\n\n---\n${context}` : details;
  let u = makeUrl(title, full);

  if (u.toString().length > MAX_URL) {
    // Stage 1: drop the context block.
    u = makeUrl(title, details);
    if (u.toString().length > MAX_URL) {
      // Stage 2: truncate details with a marker. Start with an estimate based on
      // worst-case 3 encoded bytes per codepoint, then tighten in a loop because
      // emoji encode to ~12 bytes, so the /3 estimate can overshoot MAX_URL.
      const marker = '\n\n…(truncated — finish your report in the issue)';
      const overhead = makeUrl(title, marker).toString().length;
      const budget = Math.max(0, Math.floor((MAX_URL - overhead) / 3));
      // Operate on the codepoint array to avoid splitting surrogate pairs.
      const codepoints = [...details];
      let count = Math.min(budget, codepoints.length);
      u = makeUrl(title, codepoints.slice(0, count).join('') + marker);
      // Iteratively trim until the URL fits (handles emoji and other multibyte chars
      // whose percent-encoding expands beyond the /3 worst-case assumption).
      while (u.toString().length > MAX_URL && count > 0) {
        // Drop ~5% of remaining codepoints each iteration for fast convergence.
        const drop = Math.max(1, Math.floor(count * 0.05));
        count -= drop;
        u = makeUrl(title, codepoints.slice(0, count).join('') + marker);
      }
    }
  }

  const out = u.toString();
  if (new URL(out).protocol !== 'https:') throw new Error('feedback URL must be https');
  return out;
}
