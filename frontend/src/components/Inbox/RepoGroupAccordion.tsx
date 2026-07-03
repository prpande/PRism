import { memo, useState } from 'react';
import type { InboxItemEnrichment } from '../../api/types';
import { type RepoGroup, prId, EMPTY_SETTLED } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { InboxCaret } from './InboxCaret';
import styles from './RepoGroupAccordion.module.css';

interface Props {
  group: RepoGroup;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen: boolean;
  // #508/#548 PRs whose enrichment has settled (chip arrived or chip-less).
  settled?: ReadonlySet<string>;
}

// #671 — memoized so an unrelated InboxSection re-render (SSE frame / rail poll)
// skips the accordion subtree when its props are unchanged. Effective now that
// InboxSection memoizes `groups`, so the `group` identity is stable.
export const RepoGroupAccordion = memo(function RepoGroupAccordion({
  group,
  enrichments,
  showCategoryChip,
  maxDiff,
  defaultOpen,
  settled = EMPTY_SETTLED,
}: Props) {
  // defaultOpen seeds the initial state only — it derives from a static
  // !isRecentlyClosed flag that can't change at runtime, so the snapshot
  // semantics of useState (later parent changes ignored) are intentional.
  const [open, setOpen] = useState(defaultOpen);
  const count = group.items.length;
  return (
    <div className={styles.group}>
      <button
        className={styles.header}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${group.repo}, ${count} pull request${count === 1 ? '' : 's'}`}
      >
        <InboxCaret open={open} />
        <svg
          className={styles.repoIcon}
          viewBox="0 0 16 16"
          width="15"
          height="15"
          aria-hidden="true"
        >
          {/* GitHub repo glyph (Octicon repo-16) — signals the grouping is per-repository,
              mirroring the file-tree folder icon. */}
          <path
            fill="currentColor"
            d="M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z"
          />
        </svg>
        <span className={styles.repo}>{group.repo}</span>
        <span className={styles.count}>{count}</span>
      </button>
      {open && (
        <div>
          {group.items.map((pr) => {
            const id = prId(pr);
            return (
              <InboxRow
                key={id}
                pr={pr}
                enrichment={enrichments[id]}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
                showRepo={false}
                grouped
                settled={settled}
              />
            );
          })}
        </div>
      )}
    </div>
  );
});
