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
import { Spinner } from '../components/Spinner';
import { ErrorBox } from '../components/ErrorBox';
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
      <main className={styles.loading}>
        <Spinner size="lg" />
      </main>
    );
  if (error && !data)
    return (
      <main className={styles.loading}>
        <ErrorBox>Couldn't load inbox.</ErrorBox>
        <button type="button" className="btn btn-secondary" onClick={() => void reload()}>
          Try again
        </button>
      </main>
    );
  if (!data) return null;

  const onReload = async () => {
    await reload();
    updates.dismiss();
  };

  return (
    <main className={styles.page} data-testid="inbox-page">
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
  );
}
