import { useEffect, useMemo, useRef, useState } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useActivationTransition } from '../hooks/useActivationTransition';
import { useInboxRefresh } from '../hooks/useInboxRefresh';
import { useToast } from '../components/Toast/useToast';
import { useAiGate } from '../hooks/useAiGate';
import { usePreferences } from '../hooks/usePreferences';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useActivity } from '../hooks/useActivity';
import { INBOX_RAIL_MIN_WIDTH } from '../components/Inbox/inboxLayout';
import { orderInboxSections } from '../components/Inbox/sectionOrder';
import { InboxToolbar } from '../components/Inbox/InboxToolbar';
import { StalePill } from '../components/Inbox/StalePill/StalePill';
import { InboxSection } from '../components/Inbox/InboxSection';
import { InboxFooter } from '../components/Inbox/InboxFooter';
import { EmptyAllSections } from '../components/Inbox/EmptyAllSections';
import { ActivityRail } from '../components/ActivityRail/ActivityRail';
import { AiOnboardingDialog } from '../components/Ai/AiOnboardingDialog';
import { InboxSkeleton } from '../components/Inbox/InboxSkeleton';
import { LoadingBar } from '../components/LoadingBar';
import { ErrorModal } from '../components/ErrorModal';
import { NoFilterMatches } from '../components/Inbox/filters/NoFilterMatches';
import type { FilterBarState } from '../components/Inbox/filters/FilterBar';
import styles from './InboxPage.module.css';

// `active` reflects whether the keep-alive host (InboxHost) currently shows this
// page (#563). It gates the page's Modal-based dialogs so a hidden-but-mounted
// Inbox does not hold live document-level keydown handlers (Modal registers
// Escape/Tab on `document` keyed on `open`, not on CSS visibility). Defaults true
// so direct mounts (tests, any non-host caller) behave exactly as before.
export function InboxPage({ active = true }: { active?: boolean } = {}) {
  const { data, error, isLoading, isFetching, reload } = useInbox();
  // #563 — under keep-alive the Inbox is no longer remounted on return from a PR,
  // so its mount-effect GET /api/inbox doesn't re-fire. Refetch when the host
  // re-shows this page (active false→true) so freshness that does NOT ride an
  // `inbox-updated` SSE frame — e.g. a PR's unread bar clearing after mark-viewed
  // (#285) — is picked up, exactly as the old remount-on-return did. Mirrors
  // PrDetailView's refetch-on-activation. useActivationTransition never fires on
  // first mount (useInbox's own mount fetch covers that) and is a no-op for direct
  // callers where `active` is the default-true constant.
  useActivationTransition(active, () => void reload());
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

  // #485 first-run onboarding overlay: show iff preferences resolved AND not yet seen.
  // `onboardingDismissed` keeps the dialog gone after the user closes it without depending
  // on the dialog's internal open state. Multi-window auto-dismiss is automatic: if
  // preferences.ui.onboardingSeen flips to true via a focus-refetch, showOnboarding
  // becomes false and the overlay unmounts.
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const showOnboarding =
    active &&
    !onboardingDismissed &&
    preferences != null &&
    preferences.ui.onboardingSeen === false;
  const onboarding = showOnboarding ? (
    <AiOnboardingDialog onDismiss={() => setOnboardingDismissed(true)} />
  ) : null;

  const showCategoryChip = useAiGate('inboxEnrichment');
  // The activity rail renders real GitHub activity (#137 wired it to /api/activity:
  // received_events + notifications + watching). It is decoupled from the AI-preview
  // toggle onto a dedicated inbox flag, which defaults ON since #439.
  // #300 the rail also requires a wide-enough viewport: below INBOX_RAIL_MIN_WIDTH it is
  // not rendered at all (genuinely hidden, no background fetch), giving the single-column
  // Layout B. One `showRail` drives both the rail render and the cold-load skeleton.
  // The `?? false` is the pre-preferences-load fallback (not the default): keeping it
  // false means an opted-out user never sees a rail flash before preferences resolve.
  const wideEnoughForRail = useMediaQuery(`(min-width: ${INBOX_RAIL_MIN_WIDTH}px)`);
  const showRail = (preferences?.inbox.showActivityRail ?? false) && wideEnoughForRail;
  // #507 — hoist the activity fetch to InboxPage so /api/activity starts in parallel
  // with the inbox fetch on cold load, instead of waiting for the rail to mount after
  // the inbox resolves. `showRail` gates the fetch (#300/#283 no-fetch-when-hidden);
  // called unconditionally here (above the loading/error early returns) per Rules of Hooks.
  const activity = useActivity(showRail);
  // #331 — memoize so `sections` is referentially stable across renders where the
  // fetched sections don't change, keeping the `maxDiff` memo (and the derived
  // filter state) from recomputing on unrelated re-renders.
  const sections = useMemo(() => data?.sections ?? [], [data?.sections]);
  // #508/#548 — settled set: PRs whose enrichment has resolved (chip arrived OR chip-less).
  // Belt-and-suspenders: type is non-optional, but guard a stale-backend deploy that
  // predates aiEnrichmentSettled (older snapshot served while FE is fresh).
  const settled = useMemo(
    () => new Set(data?.aiEnrichmentSettled ?? []),
    [data?.aiEnrichmentSettled],
  );
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

  // #619 — one-shot stale-onset announcement. Fires 'Showing saved inbox' on the
  // false→true edge (rehydrated data arrived before revalidation finished) and
  // 'Inbox updated' on the true→false edge (fresh data resolved). A ref guards
  // the previous value so the effect only sets text when the edge actually flips —
  // identical to the always-mounted sr-only pattern used by the auto-refresh region.
  // This is a third independent live region so it never masks the other two (#450).
  const [staleAnnounce, setStaleAnnounce] = useState('');
  const wasStale = useRef(false);
  useEffect(() => {
    const stale = !!data?.stale;
    if (stale && !wasStale.current) setStaleAnnounce('Showing saved inbox');
    if (!stale && wasStale.current) setStaleAnnounce('Inbox updated');
    wasStale.current = stale;
  }, [data?.stale]);

  if (isLoading && !data)
    return (
      <>
        {/* Per-surface loading bar pinned to the inbox content top (self-contained,
            no layout shift) + the content-shaped skeleton. The onboarding overlay
            renders over the skeleton so a fresh user sees it immediately (#485). */}
        {onboarding}
        <LoadingBar active data-testid="inbox-loading-bar" />
        <InboxSkeleton showRail={showRail} />
      </>
    );
  if (error && !data)
    return (
      <ErrorModal
        open={active}
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
      {/* #485 first-run onboarding overlay — renders over the loaded inbox. */}
      {onboarding}
      {/* Background reload (data present, fetch in-flight): the bar is the non-intrusive
          "refreshing" signal. Driven by `isFetching` (any reload() attempt in progress)
          OR the manual-refresh flag, NOT by `data.stale` — so an offline launch with a
          failing revalidation does not spin the bar forever once the retry loop exits.
          Kept a sibling ABOVE <main> (not inside it) so it spans the same full width as
          the cold-load bar above <InboxSkeleton> — no width/position jump when the
          skeleton is replaced by content. */}
      <LoadingBar active={isFetching || isRefreshing} data-testid="inbox-loading-bar" />
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
        {/* #619 — stale-onset / stale-cleared announcement. A third independent
            live region so the one-shot edge announcement is never masked by the
            sticky manual-refresh or auto-refresh regions. Always mounted so the
            AT change-event fires on text update, not on node insertion. */}
        <div className="sr-only" role="status" aria-live="polite" data-testid="inbox-stale-status">
          {staleAnnounce}
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
        {/* #619 — "Updated <age>" pill. Reserve-space slot always in DOM (min-height) so
            show/hide does not reflow the toolbar. Exact placement finalized at Task 14
            visual sign-off; toolbar-inline is the default (candidate a, §9). */}
        <StalePill lastRefreshedAt={data.lastRefreshedAt} />
        <div className={styles.grid} data-has-rail={showRail || undefined}>
          <div className={styles.sections}>
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
                  settled={settled}
                />
              ))}
            {data.tokenScopeFooterEnabled && <InboxFooter />}
          </div>
          {showRail && <ActivityRail {...activity} />}
        </div>
      </main>
    </>
  );
}
