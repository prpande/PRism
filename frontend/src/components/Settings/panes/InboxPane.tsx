import { usePreferences, type PreferenceKey } from '../../../hooks/usePreferences';
import type { InboxSectionsPreferences } from '../../../api/types';
import { Switch } from '../../controls/Switch';
import pane from './Pane.module.css';

type InboxSectionId = keyof InboxSectionsPreferences;
const ROWS: readonly { id: InboxSectionId; label: string }[] = [
  { id: 'review-requested', label: 'Review requested' },
  { id: 'awaiting-author', label: 'Needs re-review' },
  { id: 'authored-by-me', label: 'Authored by me' },
  { id: 'mentioned', label: 'Mentioned' },
  { id: 'recently-closed', label: 'Recently closed' },
];
const HELP_ID = 'inbox-section-help';

export function InboxPane() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;
  const sections = preferences.inbox.sections;
  return (
    <section aria-labelledby="inbox-heading">
      <div className={pane.head}>
        <div>
          <h2 id="inbox-heading" className={pane.title}>
            Inbox
          </h2>
          <p className={pane.sub}>Choose which lists appear in your inbox</p>
        </div>
      </div>
      <p id={HELP_ID} className={pane.help}>
        Changes apply on the next inbox refresh (within 2 minutes).
      </p>
      {ROWS.map(({ id, label }) => (
        <div key={id} className={pane.row}>
          <label className={pane.label} htmlFor={`inbox-section-${id}`}>
            {label}
          </label>
          <div className={pane.spring}>
            <Switch
              id={`inbox-section-${id}`}
              label={label}
              describedById={HELP_ID}
              checked={sections[id]}
              onChange={(next) =>
                set(`inbox.sections.${id}` as PreferenceKey, next).catch(() => {})
              }
            />
          </div>
        </div>
      ))}
    </section>
  );
}
