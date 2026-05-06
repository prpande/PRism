import { useMemo } from 'react';
import { useInbox } from '../hooks/useInbox';
import { useInboxUpdates } from '../hooks/useInboxUpdates';
import { useCapabilities } from '../hooks/useCapabilities';
import { usePreferences } from '../hooks/usePreferences';
import { InboxBanner } from '../components/Inbox/InboxBanner';
import { InboxToolbar } from '../components/Inbox/InboxToolbar';
import { InboxSection } from '../components/Inbox/InboxSection';
import { InboxFooter } from '../components/Inbox/InboxFooter';
import { EmptyAllSections } from '../components/Inbox/EmptyAllSections';
import { ActivityRail } from '../components/ActivityRail/ActivityRail';
import styles from './InboxPage.module.css';

export function InboxPage() {
  const { data, error, isLoading, reload } = useInbox();
  const updates = useInboxUpdates();
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();

  const showCategoryChip = capabilities?.inboxEnrichment === true;
  const showActivityRail = preferences?.aiPreview === true;
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

  if (isLoading && !data) return <main aria-busy="true">Loading…</main>;
  if (error && !data)
    return (
      <main role="alert">
        <p>Couldn't load inbox.</p>
        <button onClick={() => void reload()}>Try again</button>
      </main>
    );
  if (!data) return null;

  const onReload = async () => {
    await reload();
    updates.dismiss();
  };

  return (
    <main className={styles.page}>
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
            />
          ))}
          {data.tokenScopeFooterEnabled && <InboxFooter />}
        </div>
        {showActivityRail && <ActivityRail />}
      </div>
    </main>
  );
}
