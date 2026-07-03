import type { PrInboxItem } from '../../api/types';

export interface RepoGroup {
  repo: string; // "owner/name"
  items: PrInboxItem[];
}

/** Stable id for a PR row — also the enrichment map key. */
export function prId(pr: PrInboxItem): string {
  return `${pr.reference.owner}/${pr.reference.repo}#${pr.reference.number}`;
}

// #671 — shared stable empty `settled` default. A `= new Set()` default *parameter*
// re-evaluates every render where the prop is omitted, minting a fresh identity that
// flows into the rows and defeats InboxRow's React.memo. One shared instance (the set
// is never mutated) keeps that identity stable across InboxSection and RepoGroupAccordion.
export const EMPTY_SETTLED: ReadonlySet<string> = new Set<string>();

/**
 * Fold a flat PR list into per-repo groups, preserving first-seen repo order and
 * within-repo order. No timestamp sort — the backend's emission order is authoritative
 * (recently-closed arrives close-desc, so first-seen yields most-recent-close repo order).
 */
export function groupByRepo(items: PrInboxItem[]): RepoGroup[] {
  const groups: RepoGroup[] = [];
  const byRepo = new Map<string, RepoGroup>();
  for (const item of items) {
    let g = byRepo.get(item.repo);
    if (!g) {
      g = { repo: item.repo, items: [] };
      byRepo.set(item.repo, g);
      groups.push(g);
    }
    g.items.push(item);
  }
  return groups;
}
