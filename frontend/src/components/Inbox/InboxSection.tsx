import { useEffect, useState } from 'react';
import type { InboxSection as InboxSectionDto, InboxItemEnrichment } from '../../api/types';
import { groupByRepo, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { InboxCaret } from './InboxCaret';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';
import styles from './InboxSection.module.css';

const RECENTLY_CLOSED = 'recently-closed';

const EmptyCopy: Record<string, string> = {
  'review-requested': 'No reviews requested right now.',
  'awaiting-author': 'Nothing needs re-review.',
  'authored-by-me': "You haven't opened any PRs.",
  mentioned: "You aren't @-mentioned on any open PRs.",
  'recently-closed': 'No PRs closed recently.',
};

interface Props {
  section: InboxSectionDto;
  enrichments: Record<string, InboxItemEnrichment>;
  showCategoryChip: boolean;
  maxDiff: number;
  defaultOpen?: boolean;
  forceOpen?: boolean;
}

export function InboxSection({
  section,
  enrichments,
  showCategoryChip,
  maxDiff,
  defaultOpen = true,
  forceOpen,
}: Props) {
  // A filter-revealed section opens expanded (forceOpen), but a manual collapse
  // during the session still wins. Once the filter releases the section
  // (forceOpen → false), the session's manual-toggle memory is dropped so the
  // section returns to its pre-filter default on the next reveal.
  const [userToggled, setUserToggled] = useState(false);
  const [userOpen, setUserOpen] = useState(defaultOpen);
  // `forceOpen` is a force-OPEN signal only: it never force-collapses. The page
  // wires it as `filterActive && id !== 'recently-closed'`, a concrete boolean —
  // so we OR with defaultOpen (not `??`), otherwise an explicit `forceOpen={false}`
  // would override a `defaultOpen={true}` section and wrongly collapse it.
  const open = userToggled ? userOpen : forceOpen || defaultOpen;
  // Flip relative to the CURRENTLY DISPLAYED state, not `userOpen`. On the first
  // toggle after a forceOpen reveal, `userOpen` still holds `defaultOpen` (e.g.
  // false) while the section shows expanded — a functional flip of `userOpen`
  // would leave it open. Inverting `open` makes a manual collapse always win.
  const onToggle = () => {
    setUserToggled(true);
    setUserOpen(!open);
  };
  useEffect(() => {
    if (!forceOpen) setUserToggled(false);
  }, [forceOpen]);
  const isRecentlyClosed = section.id === RECENTLY_CLOSED;
  const groups = groupByRepo(section.items);
  const repoDefaultOpen = !isRecentlyClosed;

  return (
    <section className={styles.section}>
      <button className={styles.header} onClick={onToggle} aria-expanded={open}>
        <InboxCaret open={open} />
        <span className={styles.label}>{section.label}</span>
        <span className={styles.count}>{section.items.length}</span>
      </button>
      {open && (
        <div className={styles.body}>
          {section.items.length === 0 ? (
            <div className={styles.empty}>{EmptyCopy[section.id] ?? 'Nothing here.'}</div>
          ) : groups.length <= 1 ? (
            section.items.map((pr) => {
              const id = prId(pr);
              return (
                <InboxRow
                  key={id}
                  pr={pr}
                  enrichment={enrichments[id]}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                />
              );
            })
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
