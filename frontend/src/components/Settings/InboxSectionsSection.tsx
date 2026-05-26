import { usePreferences } from '../../hooks/usePreferences';
import type { PreferenceKey } from '../../hooks/usePreferences';
import type { InboxSectionsPreferences } from '../../api/types';
import styles from './SettingsSections.module.css';

type InboxSectionId = keyof InboxSectionsPreferences;

const ROWS: readonly { id: InboxSectionId; label: string }[] = [
  { id: 'review-requested', label: 'Review requested' },
  { id: 'awaiting-author', label: 'Awaiting author' },
  { id: 'authored-by-me', label: 'Authored by me' },
  { id: 'mentioned', label: 'Mentioned' },
  { id: 'ci-failing', label: 'CI failing on my PRs' },
];

const HELP_ID = 'inbox-section-help';

export function InboxSectionsSection() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;
  const sections = preferences.inbox.sections;

  return (
    <section aria-labelledby="inbox-sections-heading" className={styles.section}>
      <h2 id="inbox-sections-heading">Inbox sections</h2>
      <span id={HELP_ID} className={styles.help}>
        Inbox section changes apply on the next inbox refresh (within 2 minutes).
      </span>
      {ROWS.map(({ id, label }) => {
        const inputId = `inbox-section-${id}`;
        return (
          <div key={id} className={styles.row}>
            <label htmlFor={inputId}>{label}</label>
            <input
              id={inputId}
              type="checkbox"
              role="switch"
              aria-describedby={HELP_ID}
              checked={sections[id]}
              onChange={(e) => void set(`inbox.sections.${id}` as PreferenceKey, e.target.checked)}
            />
          </div>
        );
      })}
    </section>
  );
}
