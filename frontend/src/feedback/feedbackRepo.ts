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
      // Stage 2: truncate details. Compute a safe char budget from the headroom
      // left after the base+title (worst-case 3 bytes per char under encoding).
      const marker = '\n\n…(truncated — finish your report in the issue)';
      const overhead = makeUrl(title, marker).toString().length;
      const budget = Math.max(0, Math.floor((MAX_URL - overhead) / 3));
      // Slice by codepoint (spread), not UTF-16 code unit, so a multibyte char
      // (emoji) isn't split into a lone surrogate → replacement-char mojibake.
      const head = [...details].slice(0, budget).join('');
      u = makeUrl(title, head + marker);
    }
  }

  const out = u.toString();
  if (new URL(out).protocol !== 'https:') throw new Error('feedback URL must be https');
  return out;
}
