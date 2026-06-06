import { useState } from 'react';
import type { InboxSection as InboxSectionDto, InboxItemEnrichment } from '../../api/types';
import { groupByRepo, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';
import styles from './InboxSection.module.css';

const RECENTLY_CLOSED = 'recently-closed';

const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author': 'Nothing waiting on the author.',
  'authored-by-me': "You haven't opened any PRs.",
  mentioned: "You aren't @-mentioned on any open PRs.",
  'ci-failing': 'No CI failures on your PRs — nice.',
  'recently-closed': 'No PRs closed in the last 14 days.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen?: boolean;
}

export function InboxSection({
  section,
  enrichments,
  showCategoryChip,
  maxDiff,
  defaultOpen = true,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const isRecentlyClosed = section.id === RECENTLY_CLOSED;
  const groups = groupByRepo(section.items);
  const repoDefaultOpen = !isRecentlyClosed;

  return (
    <section className={styles.section}>
      <button className={styles.header} onClick={() => setOpen(!open)} aria-expanded={open}>
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={styles.label}>{section.label}</span>
        <span className={styles.count}>{section.items.length}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {section.items.length === 0 ? (
            <div className={styles.empty}>{EmptyCopy[section.id] ?? 'Nothing here.'}</div>
          ) : groups.length <= 1 ? (
            section.items.map((pr) => (
              <InboxRow
                key={prId(pr)}
                pr={pr}
                enrichment={enrichments[prId(pr)]}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
              />
            ))
          ) : (
            groups.map((g) => (
              <RepoGroupAccordion
                key={g.repo}
                group={g}
                enrichments={enrichments}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
                defaultOpen={repoDefaultOpen}
              />
            ))
          )}
          {/* "Unconditional" per spec = not gated on truncation (the old >=30 hint). The
              length>0 guard is intentional: an empty recently-closed shows EmptyCopy, not a
              "most recent first" caption over nothing. */}
          {isRecentlyClosed && section.items.length > 0 && <RecentlyClosedFooter />}
        </div>
      )}
    </section>
  );
}
