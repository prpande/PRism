import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../Avatar/Avatar';
import { formatAge } from '../../utils/relativeTime';
import { useActivity } from '../../hooks/useActivity';
import type { ActivityItem, ActivityVerb } from '../../api/types';
import styles from './ActivityRail.module.css';

const MAX_VISIBLE = 12; // must match ActivityFeedBuilder.MaxActivityItems

const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened',
  reopened: 'reopened',
  closed: 'closed',
  merged: 'merged',
  reviewed: 'reviewed',
  commented: 'commented on',
  other: 'updated',
  // actorless — no actor prefix; Task 12 wires the full actorless phrasing
  'review-requested': 'review requested on',
  mentioned: 'you were mentioned on',
};

// Parse a github.com PR html_url → the in-app /pr/:owner/:repo/:number path.
// Returns null on any non-PR / malformed url so the caller can fall back to <a>.
function inAppPrPath(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return `/pr/${m[1]}/${m[2]}/${m[3]}`;
}

function prRef(item: ActivityItem): string {
  // Repo names from received_events are "owner/repo"; show the short repo + #n,
  // matching the spec phrasing examples ("MindBodyPOS#5436", "#1810").
  const shortRepo = item.repo.includes('/') ? item.repo.split('/')[1] : item.repo;
  return `${shortRepo}#${item.prNumber}`;
}

function Row({ item }: { item: ActivityItem }) {
  const path = inAppPrPath(item.url);
  const label = `${item.actorLogin} ${VERB_PHRASE[item.verb]} #${item.prNumber}${
    item.title ? ` — ${item.title}` : ''
  }`;
  // Avatar self-sets aria-hidden internally, so the row's aria-label is the sole
  // accessible name (no double announcement).
  const inner = (
    <>
      <Avatar src={item.actorAvatarUrl} login={item.actorLogin ?? ''} size="sm" />
      <span className={styles.actor}>{item.actorLogin}</span> {VERB_PHRASE[item.verb]}{' '}
      <span className={styles.pr}>{prRef(item)}</span>
      <span className={styles.when}> · {formatAge(item.timestamp)}</span>
    </>
  );
  return (
    <li className={styles.item}>
      {path ? (
        <Link to={path} className={styles.rowLink} aria-label={label}>
          {inner}
        </Link>
      ) : (
        <a
          href={item.url}
          className={styles.rowLink}
          aria-label={label}
          target="_blank"
          rel="noreferrer"
        >
          {inner}
        </a>
      )}
    </li>
  );
}

export function ActivityRail() {
  const { data, isLoading, error } = useActivity();
  const [showBots, setShowBots] = useState(false); // transient; default HIDDEN

  const all = data?.items ?? [];
  const visible = useMemo(
    () => all.filter((i) => showBots || !i.actorIsBot).slice(0, MAX_VISIBLE),
    [all, showBots],
  );

  const degraded = data?.degraded.receivedEvents ?? false;
  const showDegraded = (!data && error) || degraded;
  const hasAnyItems = all.length > 0;
  const allHiddenAreBots = hasAnyItems && visible.length === 0; // every row filtered by the toggle

  return (
    <aside className={styles.rail} aria-label="Activity" data-testid="activity-rail">
      <section className={styles.section}>
        <header className={styles.head}>
          <span className={styles.title}>Activity</span>
          <span className={styles.muted}>last 24h</span>
          <button
            type="button"
            className={styles.botToggle}
            aria-pressed={showBots}
            onClick={() => setShowBots((v) => !v)}
          >
            Show bots
          </button>
        </header>

        {isLoading && !data ? (
          <ol className={styles.list} aria-busy="true" aria-label="Loading activity">
            {Array.from({ length: 4 }, (_, i) => (
              <li key={i} className={styles.skeletonRow} aria-hidden="true" />
            ))}
          </ol>
        ) : showDegraded ? (
          <p className={styles.degraded} role="status">
            Activity unavailable
          </p>
        ) : allHiddenAreBots ? (
          <p className={styles.empty}>
            No human activity in the last 24h — turn on &quot;Show bots&quot; to see bot activity
          </p>
        ) : visible.length === 0 ? (
          <p className={styles.empty}>No pull-request activity in the last 24h</p>
        ) : (
          <ol className={styles.list}>
            {visible.map((it, idx) => (
              // idx tiebreaker: two distinct events can share url+verb+timestamp (sub-second
              // precision isn't guaranteed); the list is sorted + display-only so index keys are safe.
              <Row key={`${it.url}:${it.verb}:${it.timestamp}:${idx}`} item={it} />
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}
