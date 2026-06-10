import type { CiStatus, InboxSection, PrInboxItem, SortKey } from '../../../api/types';
export type { SortKey };

// #300 — direction-encoding labels: each conveys its fixed (descending) sort
// direction in words, so the control reads consistently with no asc/desc toggle.
// Keys are unchanged — persisted inbox.defaultSort values keep working.
export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Recently updated' },
  { key: 'pushed', label: 'Recently pushed' },
  { key: 'diff', label: 'Largest diff' },
  { key: 'comments', label: 'Most comments' },
];

export interface InboxFilters {
  text: string;
  ci: CiStatus[];
  repos: string[];
  authors: string[];
}

// Is the value ANY http(s) URL? Used to strip a pasted URL out of the EFFECTIVE
// text filter (so a non-PR URL — issue/commit/repo — doesn't filter the inbox to a
// fake empty zero-state). Broader than looksLikePrUrl by design.
export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\//i.test(s.trim());
}

// Cheap, client-side disambiguation between a free-text filter term and a pasted
// single-PR URL. TIGHTENED to mirror the server parser's owner/repo/pull/{number}
// shape (GitHubReviewService requires segment-2 == "pull" + a numeric id): singular
// `pull`, anchored at the scheme, numeric PR id. This REJECTS the plural list
// endpoint `…/pulls/42`, a branch path like `…/tree/feat/pull/x`, and a bare term;
// it ACCEPTS `…/pull/42` and a deep link `…/pull/42/files`. The AUTHORITATIVE parse
// still happens server-side via parsePrUrl — this only gates the merged input's
// "open this PR" affordance / action.
//
// Deliberately NOT anchored after `\d+` (no `(?:[/?#]|$)`): a trailing-junk id like
// `…/pull/42abc` stays accepted here even though the server's int.TryParse rejects
// it (bounded cost — the user just gets the "That doesn't look like a PR link" pill
// from the server). An end-anchor was tried and reverted: InboxQueryInput's
// staleness guard calls looksLikePrUrl on the LIVE value mid-paste, and a stricter
// match flips a transient settling value to "not a PR URL", making a legitimate
// paste-to-open bail. Tolerance for the settling value is worth more than rejecting
// a near-zero trailing-junk shape the server already catches.
export function looksLikePrUrl(s: string): boolean {
  return /^https?:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/\d+/i.test(s.trim());
}

export interface FilterResult {
  sections: InboxSection[];
  filterActive: boolean;
  matchCount: number;
  totalCount: number;
}

export function isFilterActive(f: InboxFilters): boolean {
  return f.text.trim() !== '' || f.ci.length > 0 || f.repos.length > 0 || f.authors.length > 0;
}

const comparators: Record<SortKey, (a: PrInboxItem, b: PrInboxItem) => number> = {
  updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
  pushed: (a, b) => b.pushedAt.localeCompare(a.pushedAt),
  diff: (a, b) => b.additions + b.deletions - (a.additions + a.deletions),
  comments: (a, b) => b.commentCount - a.commentCount,
};

function matches(pr: PrInboxItem, f: InboxFilters): boolean {
  const text = f.text.trim().toLowerCase();
  if (text && !pr.title.toLowerCase().includes(text) && !pr.repo.toLowerCase().includes(text))
    return false;
  if (f.ci.length > 0 && !f.ci.includes(pr.ci)) return false;
  if (f.repos.length > 0 && !f.repos.includes(pr.repo)) return false;
  if (f.authors.length > 0 && !f.authors.includes(pr.author)) return false;
  return true;
}

export function applyInboxFilters(
  sections: InboxSection[],
  filters: InboxFilters,
  sort: SortKey,
): FilterResult {
  const active = isFilterActive(filters);
  // Clamp an out-of-set sort to 'updated' rather than crashing. `sort` is typed
  // SortKey, but it can arrive from JSON the type system doesn't police — a
  // hand-edited / version-skewed inbox.defaultSort in config.json reaches here as
  // an arbitrary string. Without this, comparators[sort] is undefined and the
  // tiebreak's cmp(a, b) throws, taking down the whole inbox render.
  const cmp = comparators[sort] ?? comparators.updated;
  const tiebreak = (a: PrInboxItem, b: PrInboxItem) => {
    const c = cmp(a, b);
    return c !== 0 ? c : b.reference.number - a.reference.number;
  };

  let matchCount = 0;
  let totalCount = 0;
  const out: InboxSection[] = [];
  for (const s of sections) {
    totalCount += s.items.length;
    const kept = (active ? s.items.filter((p) => matches(p, filters)) : [...s.items]).sort(
      tiebreak,
    );
    matchCount += kept.length;
    if (active && kept.length === 0) continue; // hide emptied sections while filtering
    out.push({ ...s, items: kept });
  }
  return { sections: out, filterActive: active, matchCount, totalCount };
}
