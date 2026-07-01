import { useEffect, useId, useMemo, useState } from 'react';
import { Avatar } from '../../../Avatar/Avatar';
import { Skeleton } from '../../../Skeleton/Skeleton';
import { formatAge } from '../../../../utils/relativeTime';
import { CommentCard } from '../../Comment/CommentCard'; // lives under PrDetail/Comment/, not PrDetail/CommentCard/
import type { PrReference, TimelineEvent, ActivityVerb } from '../../../../api/types';
import { useTimelineFeed } from './useTimelineFeed';
import { groupCommitRuns, type FeedNode } from './groupCommitRuns';
import styles from './ActivityFeed.module.css';

const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened',
  reopened: 'reopened',
  closed: 'closed',
  merged: 'merged',
  reviewed: 'reviewed',
  commented: 'commented',
  approved: 'approved',
  'changes-requested': 'requested changes',
  'review-requested': 'requested review from',
  pushed: 'pushed',
  mentioned: 'mentioned',
  'ci-activity': 'CI',
  authored: 'authored',
  other: 'updated',
};

// A review that carries a body renders as ONE card; when it is an approval / changes-requested the
// review outcome shows as a band-end badge on that same card (never a separate duplicate marker).
// CommentCard renders `bandEnd` inside a <Badge> only when non-null, so a plain comment stays plain.
function stateBand(verb: ActivityVerb): string | undefined {
  return verb === 'approved' || verb === 'changes-requested' ? VERB_PHRASE[verb] : undefined;
}

function Marker({ event }: { event: TimelineEvent }) {
  const phrase = VERB_PHRASE[event.verb];
  const tail = event.verb === 'review-requested' && event.subject ? ` ${event.subject}` : '';
  return (
    <li className={styles.marker} data-testid="timeline-marker">
      <Avatar src={event.actor.avatarUrl} login={event.actor.login ?? ''} size="sm" />
      <span className={styles.lead}>
        <span className={styles.actor}>{event.actor.login}</span>{' '}
        <span className={styles.verb}>
          {phrase}
          {tail}
        </span>
      </span>
      <span className={styles.when}>· {formatAge(event.timestamp)}</span>
    </li>
  );
}

function CommitGroup({
  commits,
  collapsedByDefault,
}: {
  commits: TimelineEvent[];
  collapsedByDefault: boolean;
}) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const n = commits.length;
  const listId = `${useId()}-commit-list`;
  return (
    <li className={styles.marker} data-testid="timeline-commit-group">
      <button
        type="button"
        className={styles.accordion}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        pushed {n} {n === 1 ? 'commit' : 'commits'}
      </button>
      {open && (
        <ul id={listId} className={styles.commitList}>
          {commits.map((c) => (
            <li key={c.id} className={styles.commitRow}>
              <span className={styles.actor}>{c.actor.login}</span>
              <span className={styles.when}>· {formatAge(c.timestamp)}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function ActivityFeed({
  prRef,
  prUpdatedSignal,
  composerSlot,
  onRegisterRefetch,
}: {
  prRef: PrReference;
  prUpdatedSignal: number;
  composerSlot: React.ReactNode;
  onRegisterRefetch?: (fn: () => void) => void; // OverviewTab wires the composer's post→refetch through this
}) {
  const {
    events,
    status,
    hasOlder,
    loadOlder,
    loadingOlder,
    refetchNewest,
    reload,
    liveAnnouncement,
  } = useTimelineFeed(prRef, { prUpdatedSignal });
  useEffect(() => {
    onRegisterRefetch?.(refetchNewest);
  }, [onRegisterRefetch, refetchNewest]);
  // Bot toggle persists per session (spec: matches ActivityRail). Global key, not per-PR — the
  // user's "show bots" preference is a viewing mode, not PR state.
  const [showBots, setShowBots] = useState(
    () => sessionStorage.getItem('prism.activityFeed.showBots') === '1',
  );
  useEffect(() => {
    sessionStorage.setItem('prism.activityFeed.showBots', showBots ? '1' : '0');
  }, [showBots]);

  const nodes: FeedNode[] = useMemo(
    () => groupCommitRuns(events.filter((e) => showBots || !e.actor.isBot)),
    [events, showBots],
  );

  return (
    <section className="overview-card" data-testid="activity-feed" aria-label="PR activity">
      <div className={styles.srOnly} role="status" aria-live="polite">
        {liveAnnouncement}
      </div>
      {composerSlot}
      <div className={styles.toolbar}>
        <button type="button" aria-pressed={showBots} onClick={() => setShowBots((v) => !v)}>
          {showBots ? 'Hide bots' : 'Show bots'}
        </button>
      </div>

      {status === 'loading' && <Skeleton height="4rem" data-testid="timeline-skeleton" />}
      {status === 'error' && (
        <div className={styles.error} data-testid="timeline-error">
          Couldn’t load activity.{' '}
          <button type="button" onClick={reload}>
            Retry
          </button>
        </div>
      )}
      {status === 'ready' && nodes.length === 0 && (
        <p className={styles.empty} data-testid="timeline-empty">
          No activity yet.
        </p>
      )}

      {status === 'ready' && nodes.length > 0 && (
        <ol className={styles.rail}>
          {nodes.map((node) =>
            node.kind === 'commit-group' ? (
              <CommitGroup
                key={node.commits[0].id}
                commits={node.commits}
                collapsedByDefault={node.collapsedByDefault}
              />
            ) : node.event.body != null ? (
              <li key={node.event.id} className={styles.card}>
                <CommentCard
                  density="comfortable"
                  author={node.event.actor.login ?? ''}
                  avatarUrl={node.event.actor.avatarUrl ?? undefined}
                  createdAt={node.event.timestamp}
                  body={node.event.body}
                  bandEnd={stateBand(node.event.verb)}
                  data-testid="timeline-comment"
                />
              </li>
            ) : (
              <Marker key={node.event.id} event={node.event} />
            ),
          )}
        </ol>
      )}

      {status === 'ready' && hasOlder && (
        <button type="button" className={styles.older} onClick={loadOlder} disabled={loadingOlder}>
          {loadingOlder ? 'Loading…' : 'Show older activity'}
        </button>
      )}
    </section>
  );
}
