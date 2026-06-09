import { useState } from 'react';
import { usePreferences, type PreferenceKey } from '../../../hooks/usePreferences';
import type { InboxSectionsPreferences } from '../../../api/types';
import { SORT_OPTIONS } from '../../Inbox/filters/applyInboxFilters';
import {
  CANONICAL_DEFAULT_ORDER_STRING,
  orderedWorkSectionIds,
  type WorkSectionId,
} from '../../Inbox/sectionOrder';
import { Switch } from '../../controls/Switch';
import pane from './Pane.module.css';

const WORK_LABELS: Record<WorkSectionId, string> = {
  'review-requested': 'Review requested',
  'awaiting-author': 'Needs re-review',
  'authored-by-me': 'Authored by me',
  mentioned: 'Mentioned',
};
const RECENTLY_CLOSED_LABEL = 'Recently closed';
const HELP_ID = 'inbox-section-help';

function Chevron({ dir }: { dir: 'up' | 'down' }) {
  // Decorative — the button's aria-label carries the meaning.
  return (
    <svg aria-hidden viewBox="0 0 16 16" width="14" height="14" fill="none">
      <path
        d={dir === 'up' ? 'M4 10l4-4 4 4' : 'M4 6l4 4 4-4'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function InboxPane() {
  const { preferences, set } = usePreferences();
  const [pending, setPending] = useState(false);
  if (!preferences) return null;

  const sections = preferences.inbox.sections;
  const order = orderedWorkSectionIds(preferences.inbox.sectionOrder);
  const isDefaultOrder = order.join(',') === CANONICAL_DEFAULT_ORDER_STRING;

  const defaultSort = SORT_OPTIONS.some((o) => o.key === preferences.inbox.defaultSort)
    ? preferences.inbox.defaultSort
    : 'updated';

  // Apply-on-success model (PreferencesContext.set is NOT optimistic): disable all
  // reorder controls while a move POST is pending so order-dependent moves serialize
  // and a rapid second click can't compute from a stale order (#275 spec, Unit 4).
  const writeOrder = (next: WorkSectionId[]) => {
    setPending(true);
    set('inbox.sectionOrder', next.join(','))
      .catch(() => {})
      .finally(() => setPending(false));
  };
  const move = (index: number, delta: -1 | 1) => {
    const j = index + delta;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[index], next[j]] = [next[j], next[index]];
    writeOrder(next);
  };

  const renderSwitch = (id: keyof InboxSectionsPreferences, label: string) => (
    <Switch
      id={`inbox-section-${id}`}
      label={label}
      describedById={HELP_ID}
      checked={sections[id]}
      onChange={(next) => set(`inbox.sections.${id}` as PreferenceKey, next).catch(() => {})}
    />
  );

  return (
    <section aria-labelledby="inbox-heading">
      <div className={pane.head}>
        <div>
          <h2 id="inbox-heading" className={pane.title}>
            Inbox
          </h2>
          <p className={pane.sub}>Choose which inbox sections appear and in what order</p>
        </div>
      </div>
      <p id={HELP_ID} className={pane.help}>
        Changes apply on the next inbox refresh (within 2 minutes).
      </p>

      <div role="group" aria-label="Inbox section order">
        {order.map((id, index) => (
          <div key={id} className={pane.row}>
            <label className={pane.label} htmlFor={`inbox-section-${id}`}>
              {WORK_LABELS[id]}
            </label>
            <div className={pane.spring} />
            <div className={pane.moveGroup}>
              <button
                type="button"
                className={pane.moveBtn}
                aria-label={`Move ${WORK_LABELS[id]} up`}
                disabled={pending || index === 0}
                onClick={() => move(index, -1)}
              >
                <Chevron dir="up" />
              </button>
              <button
                type="button"
                className={pane.moveBtn}
                aria-label={`Move ${WORK_LABELS[id]} down`}
                disabled={pending || index === order.length - 1}
                onClick={() => move(index, 1)}
              >
                <Chevron dir="down" />
              </button>
            </div>
            {renderSwitch(id, WORK_LABELS[id])}
          </div>
        ))}

        {/* recently-closed: pinned archive — on/off stays, no reorder controls. */}
        <div className={pane.row}>
          <label className={pane.label} htmlFor="inbox-section-recently-closed">
            {RECENTLY_CLOSED_LABEL}
          </label>
          <div className={pane.spring} />
          <span className={pane.pinnedTag}>Pinned</span>
          {renderSwitch('recently-closed', RECENTLY_CLOSED_LABEL)}
        </div>
      </div>

      <div className={pane.row}>
        <button
          type="button"
          className="btn btn-ghost"
          aria-label="Restore default order"
          disabled={pending || isDefaultOrder}
          onClick={() => writeOrder([...orderedWorkSectionIds(CANONICAL_DEFAULT_ORDER_STRING)])}
        >
          Restore default order
        </button>
      </div>

      <div className={pane.row}>
        <label className={pane.label} htmlFor="inbox-default-sort">
          Default sort
        </label>
        <div className={pane.spring} />
        <select
          id="inbox-default-sort"
          value={defaultSort}
          onChange={(e) => set('inbox.defaultSort', e.target.value).catch(() => {})}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </section>
  );
}
