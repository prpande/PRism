import { useState } from 'react';
import type {
  InboxSection as InboxSectionDto,
  InboxItemEnrichment,
  PrInboxItem,
} from '../../api/types';
import { InboxRow } from './InboxRow';
import styles from './InboxSection.module.css';

const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author': 'Nothing waiting on the author.',
  'authored-by-me': "You haven't opened any PRs.",
  mentioned: "You aren't @-mentioned on any open PRs.",
  'ci-failing': 'No CI failures on your PRs — nice.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
}

function prId(pr: PrInboxItem): string {
  return `${pr.reference.owner}/${pr.reference.repo}#${pr.reference.number}`;
}

export function InboxSection({ section, enrichments, showCategoryChip, maxDiff }: Props) {
  const [open, setOpen] = useState(true);
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
          ) : (
            section.items.map((pr) => (
              <InboxRow
                key={prId(pr)}
                pr={pr}
                enrichment={enrichments[prId(pr)]}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}
