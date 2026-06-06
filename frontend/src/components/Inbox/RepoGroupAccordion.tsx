import { useState } from 'react';
import type { InboxItemEnrichment } from '../../api/types';
import { type RepoGroup, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { InboxCaret } from './InboxCaret';
import styles from './RepoGroupAccordion.module.css';

interface Props {
  group: RepoGroup;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen: boolean;
}

export function RepoGroupAccordion({
  group,
  enrichments,
  showCategoryChip,
  maxDiff,
  defaultOpen,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const count = group.items.length;
  return (
    <div className={styles.group}>
      <button
        className={styles.header}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${group.repo}, ${count} pull request${count === 1 ? '' : 's'}`}
      >
        <InboxCaret open={open} />
        <span className={styles.repo}>{group.repo}</span>
        <span className={styles.count}>{count}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {group.items.map((pr) => (
            <InboxRow
              key={prId(pr)}
              pr={pr}
              enrichment={enrichments[prId(pr)]}
              showCategoryChip={showCategoryChip}
              maxDiff={maxDiff}
              showRepo={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
