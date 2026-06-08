import type { CiStatus, InboxSection, PrInboxItem, SortKey } from '../../../api/types';
export type { SortKey };

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'updated', label: 'Updated' },
  { key: 'pushed', label: 'Recently pushed' },
  { key: 'diff', label: 'Diff size' },
  { key: 'comments', label: 'Comments' },
];

export interface InboxFilters {
  text: string;
  ci: CiStatus[];
  repos: string[];
  authors: string[];
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
  const cmp = comparators[sort];
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
