import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Avatar } from '../Avatar/Avatar';
import { formatAge } from '../../utils/relativeTime';
import { useActivity } from '../../hooks/useActivity';
import type { ActivityItem, ActivityVerb, WatchedRepoActivity } from '../../api/types';
import styles from './ActivityRail.module.css';

// Verb phrasing for ACTOR rows ("{actor} {verb} #n"). received_events always carry
// an actor; these read as "alice reviewed #12", "bot commented on #5".
const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened',
  reopened: 'reopened',
  closed: 'closed',
  merged: 'merged',
  reviewed: 'reviewed',
  commented: 'commented on',
  other: 'updated',
  'review-requested': 'requested review on',
  mentioned: 'mentioned you on',
  'ci-activity': 'ran checks on',
  authored: 'updated',
  approved: 'approved',
  'changes-requested': 'requested changes on',
  pushed: 'pushed to',
};

// Actorless leads for NOTIFICATION rows. GitHub notifications carry no actor and,
// for reason=subscribed, no specific action — so each verb gets a straightforward,
// human lead instead of a repeated "Activity on …". Each is a self-standing phrase
// that reads naturally followed by "#<pr>".
const ACTORLESS_LEAD: Record<ActivityVerb, string> = {
  'review-requested': 'Review requested on',
  mentioned: 'You were mentioned in',
  commented: 'New comment on',
  opened: 'Opened',
  reopened: 'Reopened',
  closed: 'Closed',
  merged: 'Merged',
  reviewed: 'New review on',
  'ci-activity': 'Checks ran on',
  authored: 'Update on your PR',
  approved: 'Approved',
  'changes-requested': 'Changes requested on',
  pushed: 'New commits on',
  other: 'New update on',
};

// Parse a github.com PR html_url → the in-app /pr/:owner/:repo/:number path.
// Returns null on any non-PR / malformed url so the caller can fall back to <a>.
function inAppPrPath(url: string): string | null {
  const m = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(url);
  if (!m) return null;
  return `/pr/${m[1]}/${m[2]}/${m[3]}`;
}

// Hover tooltip (title attr): full repo name + PR title — the detail kept OUT of the
// visible single-line row so the rail stays narrow and unambiguous.
function rowTooltip(item: ActivityItem): string {
  return item.title ? `${item.repo} — ${item.title}` : item.repo;
}

// Bell octicon for actorless (notification) rows — fills the avatar slot so rows stay
// aligned, and signals "subscription update" rather than a specific person's action.
function NotifIcon() {
  return (
    <span className={styles.notifIcon} aria-hidden="true">
      <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
        <path d="M8 16a2 2 0 0 0 1.985-1.75c.017-.137-.097-.25-.235-.25h-3.5c-.138 0-.252.113-.235.25A2 2 0 0 0 8 16ZM3 5a5 5 0 0 1 10 0v2.947c0 .05.015.098.042.139l1.703 2.555A1.519 1.519 0 0 1 13.482 13H2.518a1.516 1.516 0 0 1-1.263-2.36l1.703-2.554A.255.255 0 0 0 3 7.947Zm5-3.5A3.5 3.5 0 0 0 4.5 5v2.947c0 .346-.102.683-.294.97l-1.703 2.556a.017.017 0 0 0-.003.01l.001.006c0 .002.002.004.004.006l.006.004.007.001h10.964l.007-.001.006-.004.004-.006.001-.007a.017.017 0 0 0-.003-.01l-1.703-2.554a1.745 1.745 0 0 1-.294-.97V5A3.5 3.5 0 0 0 8 1.5Z" />
      </svg>
    </span>
  );
}

function Row({ item }: { item: ActivityItem }) {
  const path = inAppPrPath(item.url);
  const actorless = item.actorLogin == null;
  const ageText = formatAge(item.timestamp);
  const tip = rowTooltip(item);

  // Accessible name carries the full detail (incl. title) that the visible row keeps
  // in the tooltip; never reference item.actorLogin when null so no `null` leaks.
  const label = actorless
    ? `${ACTORLESS_LEAD[item.verb]} #${item.prNumber}${item.title ? ` — ${item.title}` : ''}`
    : `${item.actorLogin} ${VERB_PHRASE[item.verb]} #${item.prNumber}${
        item.title ? ` — ${item.title}` : ''
      }`;

  const inner = (
    <>
      {actorless ? (
        <NotifIcon />
      ) : (
        <Avatar src={item.actorAvatarUrl} login={item.actorLogin ?? ''} size="sm" />
      )}
      <span className={styles.lead}>
        {actorless ? (
          <span className={styles.actorless}>{ACTORLESS_LEAD[item.verb]}</span>
        ) : (
          <>
            <span className={styles.actor} title={item.actorLogin ?? undefined}>
              {item.actorLogin}
            </span>{' '}
            <span className={styles.verb}>{VERB_PHRASE[item.verb]}</span>
          </>
        )}
      </span>
      <span className={styles.pr}>#{item.prNumber}</span>
      <span className={styles.when}>· {ageText}</span>
    </>
  );

  return (
    <li className={styles.item}>
      {path ? (
        <Link to={path} className={styles.rowLink} aria-label={label} title={tip}>
          {inner}
        </Link>
      ) : (
        <a
          href={item.url}
          className={styles.rowLink}
          aria-label={label}
          title={tip}
          target="_blank"
          rel="noreferrer"
        >
          {inner}
        </a>
      )}
    </li>
  );
}

function WatchRow({ w }: { w: WatchedRepoActivity }) {
  const display = w.repo.includes('/') ? w.repo.split('/')[1] : w.repo;
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
        title={`Open ${w.repo} on GitHub`}
        target="_blank"
        rel="noreferrer"
      >
        <span className={styles.repo}>{display}</span>
        {w.count > 0 ? (
          <span className={styles.count}>{w.count}</span>
        ) : (
          <span className={styles.idle}>idle</span>
        )}
      </a>
    </li>
  );
}

export function ActivityRail() {
  const { data, isLoading, error } = useActivity();
  const [showBots, setShowBots] = useState(false); // transient; default HIDDEN

  // #331 — memoize so `all` is referentially stable across renders where the
  // fetched items don't change, keeping the `visible` memo below from recomputing
  // on unrelated re-renders (the bare `data?.items ?? []` produced a new array ref
  // each render).
  const all = useMemo(() => data?.items ?? [], [data?.items]);
  // No client-side count cap: the server already ceilings at MaxRawItems and the list
  // is scrollable, so render every (bot-filtered) row and let the user scroll.
  const visible = useMemo(() => all.filter((i) => showBots || !i.actorIsBot), [all, showBots]);

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
          <span className={styles.titleGroup}>
            <span className={styles.title}>Activity</span>
          </span>
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
          <ol className={`${styles.list} ${styles.scroll}`}>
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
