import { useEffect, useMemo, useState } from 'react';
import type { InboxSection as InboxSectionDto, InboxItemEnrichment } from '../../api/types';
// Aliased: the `groupByRepo` prop (#219 toggle) would otherwise shadow this fold helper.
import { groupByRepo as buildRepoGroups, prId } from './groupByRepo';
import { InboxRow } from './InboxRow';
import { InboxCaret } from './InboxCaret';
import { RepoGroupAccordion } from './RepoGroupAccordion';
import { RecentlyClosedFooter } from './RecentlyClosedFooter';
import styles from './InboxSection.module.css';

const RECENTLY_CLOSED = 'recently-closed';

// #671 — a module-level empty set shared as the `settled` default. Using
// `= new Set()` as a default *parameter* re-evaluates on every render where the
// prop is omitted, minting a fresh identity that flows into the rows and defeats
// InboxRow's React.memo. One frozen-by-convention instance keeps the identity stable.
const EMPTY_SETTLED: ReadonlySet<string> = new Set();

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
  // #219 when false, render flat InboxRows instead of nested repo accordions.
  // Defaults true so callers/tests that omit it keep the grouped default.
  groupByRepo?: boolean;
  // #508/#548 PRs whose enrichment has settled (chip arrived or chip-less).
  settled?: ReadonlySet<string>;
}

export function InboxSection({
  section,
  enrichments,
  showCategoryChip,
  maxDiff,
  defaultOpen = true,
  forceOpen,
  groupByRepo = true,
  settled = EMPTY_SETTLED,
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
  // #219 skip the grouping allocation entirely when the toggle is off — the flat
  // path renders section.items directly and never reads `groups`.
  // #671 — memoized so an unrelated re-render doesn't re-run the O(n) fold and mint
  // fresh RepoGroup identities that would defeat RepoGroupAccordion's React.memo.
  const groups = useMemo(
    () => (groupByRepo ? buildRepoGroups(section.items) : []),
    [groupByRepo, section.items],
  );
  const repoDefaultOpen = !isRecentlyClosed;
  // group only when the toggle is on AND there's more than one repo to group
  // (a single repo always flattens — a one-child accordion is pointless).
  const grouped = groupByRepo && groups.length > 1;

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
          ) : grouped ? (
            groups.map((g) => (
              <RepoGroupAccordion
                key={g.repo}
                group={g}
                enrichments={enrichments}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
                defaultOpen={repoDefaultOpen}
                settled={settled}
              />
            ))
          ) : (
            section.items.map((pr) => {
              const id = prId(pr);
              return (
                <InboxRow
                  key={id}
                  pr={pr}
                  enrichment={enrichments[id]}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                  settled={settled}
                />
              );
            })
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
