import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../Avatar/Avatar';
import { formatAge } from '../../utils/relativeTime';
import { useActivity } from '../../hooks/useActivity';
import type { ActivityItem, ActivityVerb, WatchedRepoActivity } from '../../api/types';
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
  // actorless verbs — never reached for actor rows (these verbs always arrive
  // actorLogin:null and route through ACTORLESS_PHRASE). Kept complete so the
  // Record<ActivityVerb,…> type stays exhaustive.
  'review-requested': 'review requested on',
  mentioned: 'mentioned you on',
};

// Actorless phrasing — covers EVERY verb (incl. a generic `other` fallback) so
// an actorless row is never a dangling fragment and never leaks literal `null`
// into the accessible name. Each entry takes the PR number and returns a
// complete, self-standing phrase.
const ACTORLESS_PHRASE: Record<ActivityVerb, (pr: number) => string> = {
  'review-requested': (pr) => `Review requested on #${pr}`,
  mentioned: (pr) => `You were mentioned in #${pr}`,
  commented: (pr) => `New comment on #${pr}`,
  opened: (pr) => `Opened #${pr}`,
  reopened: (pr) => `Reopened #${pr}`,
  closed: (pr) => `Closed #${pr}`,
  merged: (pr) => `Merged #${pr}`,
  reviewed: (pr) => `Reviewed #${pr}`,
  other: (pr) => `Activity on #${pr}`,
};

// Parse a github.com PR html_url → the in-app /pr/:owner/:repo/:number path.
// Returns null on any non-PR / malformed url so the caller can fall back to <a>.
function inAppPrPath(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return `/pr/${m[1]}/${m[2]}/${m[3]}`;
}

// Strip the "owner/" prefix for display; full name lives in the title attr.
function shortRepo(repo: string): string {
  return repo.includes('/') ? repo.split('/')[1] : repo;
}

function prRef(item: ActivityItem): string {
  // Repo names from received_events are "owner/repo"; show the short repo + #n,
  // matching the spec phrasing examples ("MindBodyPOS#5436", "#1810").
  return `${shortRepo(item.repo)}#${item.prNumber}`;
}

function Row({ item }: { item: ActivityItem }) {
  const path = inAppPrPath(item.url);
  const actorless = item.actorLogin == null;

  // actorless rows build BOTH the accessible name and the visible text from the
  // actorless phrase — never reference item.actorLogin when it is null so no
  // `null` leaks into the accessible name.
  const label = actorless
    ? `${ACTORLESS_PHRASE[item.verb](item.prNumber)}${item.title ? ` — ${item.title}` : ''}`
    : `${item.actorLogin} ${VERB_PHRASE[item.verb]} #${item.prNumber}${
        item.title ? ` — ${item.title}` : ''
      }`;

  // Avatar self-sets aria-hidden internally, so the row's aria-label is the sole
  // accessible name (no double announcement). Actorless rows render the Avatar
  // placeholder so the avatar column width matches actor rows (text stays aligned).
  const inner = actorless ? (
    <>
      <Avatar src={undefined} login="" size="sm" />
      <span className={styles.actorless}>{ACTORLESS_PHRASE[item.verb](item.prNumber)}</span>{' '}
      <span className={styles.pr}>{prRef(item)}</span>
      <span className={styles.when}> · {formatAge(item.timestamp)}</span>
    </>
  ) : (
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

// External-link octicon, decorative (aria-hidden) — the link's aria-label
// already carries "opens on GitHub".
function ExternalIcon() {
  return (
    <svg
      className={styles.extIcon}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M3.75 2A1.75 1.75 0 0 0 2 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0 0 14 12.25v-3a.75.75 0 0 0-1.5 0v3a.25.25 0 0 1-.25.25h-8.5a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25h3a.75.75 0 0 0 0-1.5h-3Z" />
      <path d="M8.75 2a.75.75 0 0 0 0 1.5h2.69L5.97 8.97a.75.75 0 1 0 1.06 1.06l5.47-5.47v2.69a.75.75 0 0 0 1.5 0V2.75A.75.75 0 0 0 13.25 2h-4.5Z" />
    </svg>
  );
}

function WatchRow({ w }: { w: WatchedRepoActivity }) {
  const display = shortRepo(w.repo);
  const label =
    w.count > 0
      ? `${display} — ${w.count} recent ${w.count === 1 ? 'item' : 'items'}, opens on GitHub`
      : `${display} — no recent activity, opens on GitHub`;
  return (
    <li className={styles.item}>
      <a
        href={w.url}
        className={styles.watchRow}
        aria-label={label}
        title={w.repo}
        target="_blank"
        rel="noreferrer"
      >
        <span className={styles.repo}>{display}</span>
        {w.count > 0 ? (
          <span className={styles.count}>{w.count}</span>
        ) : (
          <span className={styles.idle}>idle</span>
        )}
        <ExternalIcon />
      </a>
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

  // SPLIT degraded gating: the Activity-list "unavailable" state must NOT fire
  // on a watching-only failure. activityDegraded gates ONLY the Activity list;
  // watchingDegraded gates ONLY the Watching section's own inline note.
  const activityDegraded = data
    ? data.degraded.receivedEvents || data.degraded.notifications
    : !!error;
  const watchingDegraded = data?.degraded.watching ?? false;
  const showDegraded = (!data && error) || activityDegraded;

  const hasAnyItems = all.length > 0;
  const allHiddenAreBots = hasAnyItems && visible.length === 0; // every row filtered by the toggle

  const watching = data?.watching ?? [];
  const showWatching = watching.length > 0 || watchingDegraded;

  return (
    <aside className={styles.rail} aria-label="Activity" data-testid="activity-rail">
      <section className={styles.section} aria-label="Activity">
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

      {showWatching && (
        <section className={styles.section} aria-label="Watching">
          {watching.length > 0 && (
            <header className={styles.head}>
              <span className={styles.watchTitle}>Watching</span>
              <span className={styles.muted}>last 24h</span>
            </header>
          )}
          {watching.length > 0 && (
            <ol className={styles.list}>
              {watching.map((w, idx) => (
                <WatchRow key={`${w.repo}:${idx}`} w={w} />
              ))}
            </ol>
          )}
          {watchingDegraded &&
            (watching.length > 0 ? (
              <p className={styles.watchIncomplete}>Subscription list may be incomplete</p>
            ) : (
              <p className={styles.watchIncomplete}>Subscription list unavailable</p>
            ))}
        </section>
      )}
    </aside>
  );
}
