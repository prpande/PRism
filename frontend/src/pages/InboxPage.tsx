import { useMemo, useState } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useInboxRefresh } from '../hooks/useInboxRefresh';
import { useToast } from '../components/Toast/useToast';
import { useAiGate } from '../hooks/useAiGate';
import { usePreferences } from '../hooks/usePreferences';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { INBOX_RAIL_MIN_WIDTH } from '../components/Inbox/inboxLayout';
import { orderInboxSections } from '../components/Inbox/sectionOrder';
import { InboxToolbar } from '../components/Inbox/InboxToolbar';
import { InboxSection } from '../components/Inbox/InboxSection';
import { InboxFooter } from '../components/Inbox/InboxFooter';
import { EmptyAllSections } from '../components/Inbox/EmptyAllSections';
import { ActivityRail } from '../components/ActivityRail/ActivityRail';
import { SampleBadge } from '../components/Ai/SampleBadge';
import { InboxSkeleton } from '../components/Inbox/InboxSkeleton';
import { LoadingBar } from '../components/LoadingBar';
import { ErrorModal } from '../components/ErrorModal';
import { NoFilterMatches } from '../components/Inbox/filters/NoFilterMatches';
import type { FilterBarState } from '../components/Inbox/filters/FilterBar';
import styles from './InboxPage.module.css';

export function InboxPage() {
  const { data, error, isLoading, reload } = useInbox();
  // #450 — an inbox-updated frame now silently auto-refreshes (debounced) instead of
  // surfacing the old reload banner. `announce` carries the screen-reader signal the
  // removed banner's role=status region used to provide.
  const autoRefresh = useInboxUpdates({ onUpdate: reload });
  const toast = useToast();
  const { isRefreshing, justRefreshed, announce, refresh } = useInboxRefresh({
    reload,
    onError: (message) => toast.show({ kind: 'error', message }),
  });
  const { preferences } = usePreferences();
  const initialSort = preferences?.inbox.defaultSort ?? 'updated';

  const showCategoryChip = useAiGate('inboxEnrichment');
  // #283 the activity rail is a fabricated, non-AI mockup — decoupled from the AI-preview
  // toggle onto a dedicated inbox flag (default false).
  // #300 the rail also requires a wide-enough viewport: below INBOX_RAIL_MIN_WIDTH it is
  // not rendered at all (genuinely hidden, no background fetch), giving the single-column
  // Layout B. One `showRail` drives both the rail render and the cold-load skeleton.
  const wideEnoughForRail = useMediaQuery(`(min-width: ${INBOX_RAIL_MIN_WIDTH}px)`);
  const showRail = (preferences?.inbox.showActivityRail ?? false) && wideEnoughForRail;
  // #331 — memoize so `sections` is referentially stable across renders where the
  // fetched sections don't change, keeping the `maxDiff` memo (and the derived
  // filter state) from recomputing on unrelated re-renders.
  const sections = useMemo(() => data?.sections ?? [], [data?.sections]);
  const allEmpty = sections.length > 0 && sections.every((s) => s.items.length === 0);

  const [filterState, setFilterState] = useState<FilterBarState | null>(null);
  const result = filterState?.result ?? null;
  const filterActive = result?.filterActive ?? false;
  const visibleSections = result ? result.sections : sections;
  const zeroMatch = filterActive && result?.matchCount === 0;

  const maxDiff = useMemo(() => {
    let m = 1;
    for (const s of sections) {
      for (const p of s.items) {
        const t = p.additions + p.deletions;
        if (t > m) m = t;
      }
    }
    return m;
  }, [sections]);

  if (isLoading && !data)
    return (
      <>
        {/* Per-surface loading bar pinned to the inbox content top (self-contained,
            no layout shift) + the content-shaped skeleton. */}
        <LoadingBar active data-testid="inbox-loading-bar" />
        <InboxSkeleton showRail={showRail} />
      </>
    );
  if (error && !data)
    return (
      <ErrorModal
        open
        title="Couldn't load inbox"
        actions={
          <button
            type="button"
            className="btn btn-primary"
            data-modal-role="primary"
            onClick={() => void reload()}
          >
            Try again
          </button>
        }
        onClose={() => {}}
      />
    );
  if (!data) return null;

  return (
    <>
      {/* Background reload (data present, isLoading): the bar is the non-intrusive
          "refreshing" signal. Kept a sibling ABOVE <main> (not inside it) so it
          spans the same full width as the cold-load bar above <InboxSkeleton> —
          no width/position jump when the skeleton is replaced by content. */}
      <LoadingBar active={isLoading || isRefreshing} data-testid="inbox-loading-bar" />
      <main className={styles.page} data-testid="inbox-page" tabIndex={-1}>
        {/* Two independent live regions. The manual-refresh announce is sticky
            ('Inbox refreshed' until the next error), so OR-ing the two into one
            region would let it permanently mask the auto-refresh signal (#450).
            Keeping them separate guarantees each is announced on its own. */}
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="inbox-refresh-status"
        >
          {announce}
        </div>
        <div
          className="sr-only"
          role="status"
          aria-live="polite"
          data-testid="inbox-autorefresh-status"
        >
          {autoRefresh.announce}
        </div>
        <InboxToolbar
          sections={sections}
          initialSort={initialSort}
          ciProbeComplete={data.ciProbeComplete}
          onState={setFilterState}
          refresh={refresh}
          isRefreshing={isRefreshing}
          justRefreshed={justRefreshed}
        />
        <div className={styles.grid} data-has-rail={showRail || undefined}>
          <div className={styles.sections}>
            {showCategoryChip && <SampleBadge variant="region" />}
            {!filterActive && allEmpty && <EmptyAllSections />}
            {zeroMatch && <NoFilterMatches onClear={() => filterState?.clear()} />}
            {!zeroMatch &&
              orderInboxSections(visibleSections, preferences?.inbox.sectionOrder).map((s) => (
                <InboxSection
                  key={s.id}
                  section={s}
                  enrichments={data.enrichments}
                  showCategoryChip={showCategoryChip}
                  maxDiff={maxDiff}
                  defaultOpen={s.id !== 'recently-closed'}
                  forceOpen={filterActive && s.id !== 'recently-closed'}
                  groupByRepo={preferences?.inbox.groupByRepo ?? true}
                />
              ))}
            {data.tokenScopeFooterEnabled && <InboxFooter />}
          </div>
          {showRail && <ActivityRail />}
        </div>
      </main>
    </>
  );
}
