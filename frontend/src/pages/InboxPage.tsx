import { useMemo } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useAiGate } from '../hooks/useAiGate';
import { InboxBanner } from '../components/Inbox/InboxBanner';
import { InboxToolbar } from '../components/Inbox/InboxToolbar';
import { InboxSection } from '../components/Inbox/InboxSection';
import { InboxFooter } from '../components/Inbox/InboxFooter';
import { EmptyAllSections } from '../components/Inbox/EmptyAllSections';
import { ActivityRail } from '../components/ActivityRail/ActivityRail';
import { InboxSkeleton } from '../components/Inbox/InboxSkeleton';
import { LoadingBar } from '../components/LoadingBar';
import { ErrorModal } from '../components/ErrorModal';
import styles from './InboxPage.module.css';

export function InboxPage() {
  const { data, error, isLoading, reload } = useInbox();
  const updates = useInboxUpdates();

  const showCategoryChip = useAiGate('inboxEnrichment');
  const showActivityRail = useAiGate('inboxRanking');
  const sections = data?.sections ?? [];
  const allEmpty = sections.length > 0 && sections.every((s) => s.items.length === 0);

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
        <InboxSkeleton showRail={showActivityRail} />
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

  const onReload = async () => {
    await reload();
    updates.dismiss();
  };

  return (
    <>
      {/* Background reload (data present, isLoading): the bar is the non-intrusive
          "refreshing" signal. Kept a sibling ABOVE <main> (not inside it) so it
          spans the same full width as the cold-load bar above <InboxSkeleton> —
          no width/position jump when the skeleton is replaced by content. */}
      <LoadingBar active={isLoading} data-testid="inbox-loading-bar" />
      <main className={styles.page} data-testid="inbox-page" tabIndex={-1}>
        {updates.hasUpdate && (
          <InboxBanner summary={updates.summary} onReload={onReload} onDismiss={updates.dismiss} />
        )}
        <InboxToolbar />
        <div className={styles.grid}>
          <div className={styles.sections}>
            {allEmpty && <EmptyAllSections />}
            {sections.map((s) => (
              <InboxSection
                key={s.id}
                section={s}
                enrichments={data.enrichments}
                showCategoryChip={showCategoryChip}
                maxDiff={maxDiff}
                defaultOpen={s.id !== 'recently-closed'}
              />
            ))}
            {data.tokenScopeFooterEnabled && <InboxFooter />}
          </div>
          {showActivityRail && <ActivityRail />}
        </div>
      </main>
    </>
  );
}
