import { useEffect, useMemo, useState } from 'react';
import { Avatar } from '../../../Avatar/Avatar';
import { Skeleton } from '../../../Skeleton/Skeleton';
import { formatAge } from '../../../../utils/relativeTime';
import { CommentCard } from '../../Comment/CommentCard'; // lives under PrDetail/Comment/, not PrDetail/CommentCard/
import type { PrReference, TimelineEvent, ActivityVerb } from '../../../../api/types';
import { useTimelineFeed } from './useTimelineFeed';
import { groupCommitRuns, type FeedNode } from './groupCommitRuns';
import { verbMeta, GlyphIcon, COMMENT_PATH, COMMIT_PATH, type GlyphTone } from './eventGlyph';
import styles from './ActivityFeed.module.css';

const VERB_PHRASE: Record<ActivityVerb, string> = {
  opened: 'opened this pull request',
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
function stateBand(verb: ActivityVerb): string | undefined {
  return verb === 'approved' || verb === 'changes-requested' ? VERB_PHRASE[verb] : undefined;
}

// A conversation card always reads as a comment bubble on the rail; its tone tracks the review
// outcome so a bodied approval/changes-requested is colour-coded without a separate marker.
function commentTone(verb: ActivityVerb): GlyphTone {
  return verb === 'approved' ? 'success' : verb === 'changes-requested' ? 'warning' : 'neutral';
}

/** The circular node badge sitting on the accent rail — a colour-toned octicon per event type. */
function NodeBadge({ tone, path }: { tone: GlyphTone; path: string }) {
  return (
    <span className={styles.badge} data-tone={tone}>
      <GlyphIcon path={path} />
    </span>
  );
}

/** Short-SHA, linked to the commit on GitHub when the PR's html base is known (else plain text). */
function ShaLink({ event, commitBase }: { event: TimelineEvent; commitBase: string | null }) {
  const short = event.id.slice(0, 7);
  if (!commitBase) return <span className={styles.sha}>{short}</span>;
  return (
    <a
      className={styles.sha}
      href={`${commitBase}/commit/${event.id}`}
      target="_blank"
      rel="noreferrer"
    >
      {short}
    </a>
  );
}

function Marker({ event }: { event: TimelineEvent }) {
  const { tone, path } = verbMeta(event.verb);
  const phrase =
    event.verb === 'review-requested' && !event.subject
      ? 'requested a review' // no reviewer parsed — avoid a dangling "requested review from"
      : VERB_PHRASE[event.verb];
  const tail = event.verb === 'review-requested' && event.subject ? ` ${event.subject}` : '';
  return (
    <li className={styles.node} data-testid="timeline-marker">
      <NodeBadge tone={tone} path={path} />
      <span className={styles.line}>
        <Avatar src={event.actor.avatarUrl} login={event.actor.login ?? ''} size="sm" />
        <span className={styles.lineText}>
          {event.actor.login && <span className={styles.actor}>{event.actor.login} </span>}
          <span className={styles.verb}>
            {phrase}
            {tail}
          </span>
          <span className={styles.when}> · {formatAge(event.timestamp)}</span>
        </span>
      </span>
    </li>
  );
}

function CommentNode({ event }: { event: TimelineEvent }) {
  return (
    <li className={styles.node}>
      <NodeBadge tone={commentTone(event.verb)} path={COMMENT_PATH} />
      <div className={styles.cardWrap}>
        <CommentCard
          density="comfortable"
          avatarSize="sm"
          author={event.actor.login ?? ''}
          avatarUrl={event.actor.avatarUrl ?? undefined}
          createdAt={event.timestamp}
          body={event.body ?? ''}
          bandEnd={stateBand(event.verb)}
          data-testid="timeline-comment"
        />
      </div>
    </li>
  );
}

const COMMIT_ROW_LIMIT = 5;

function CommitGroup({
  commits,
  commitBase,
}: {
  commits: TimelineEvent[]; // newest-first
  commitBase: string | null;
}) {
  const [showAll, setShowAll] = useState(false);

  // A lone push reads as one inline line — no group container or disclosure chrome.
  if (commits.length === 1) {
    const c = commits[0];
    return (
      <li className={styles.node} data-testid="timeline-commit-group">
        <NodeBadge tone="neutral" path={COMMIT_PATH} />
        <span className={styles.line}>
          <Avatar src={c.actor.avatarUrl} login={c.actor.login ?? ''} size="sm" />
          <span className={styles.lineText}>
            {c.actor.login && <span className={styles.actor}>{c.actor.login} </span>}
            <span className={styles.verb}>pushed </span>
            <ShaLink event={c} commitBase={commitBase} />
            {c.subject && <span className={styles.commitTitle}> {c.subject}</span>}
            <span className={styles.when}> · {formatAge(c.timestamp)}</span>
          </span>
        </span>
      </li>
    );
  }

  const shown = showAll ? commits : commits.slice(0, COMMIT_ROW_LIMIT);
  const hidden = commits.length - shown.length;
  const pusher = commits[0].actor; // newest pusher heads the group

  return (
    <li className={styles.node} data-testid="timeline-commit-group">
      <NodeBadge tone="neutral" path={COMMIT_PATH} />
      <div className={styles.commitGroup}>
        <div className={styles.commitHead}>
          <Avatar src={pusher.avatarUrl} login={pusher.login ?? ''} size="sm" />
          <span className={styles.lineText}>
            {pusher.login && <span className={styles.actor}>{pusher.login} </span>}
            <span className={styles.verb}>pushed {commits.length} commits</span>
            <span className={styles.when}> · {formatAge(commits[0].timestamp)}</span>
          </span>
        </div>
        <ul className={styles.commits}>
          {shown.map((c) => (
            <li key={c.id} className={styles.commitRow}>
              <ShaLink event={c} commitBase={commitBase} />
              <span className={styles.commitTitle}>{c.subject ?? ''}</span>
            </li>
          ))}
        </ul>
        {hidden > 0 && (
          <button type="button" className={styles.showOlder} onClick={() => setShowAll(true)}>
            Show {hidden} older {hidden === 1 ? 'commit' : 'commits'}
          </button>
        )}
      </div>
    </li>
  );
}

export function ActivityFeed({
  prRef,
  prUpdatedSignal,
  composerSlot,
  onRegisterRefetch,
  prHtmlUrl,
}: {
  prRef: PrReference;
  prUpdatedSignal: number;
  composerSlot: React.ReactNode;
  onRegisterRefetch?: (fn: () => void) => void; // OverviewTab wires the composer's post→refetch through this
  prHtmlUrl?: string | null; // the PR's github html_url — the commit-link base is derived from it
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

  // The commit-link base is the PR html_url with the trailing "/pull/<n>" stripped, so a commit row
  // links to "<host>/<owner>/<repo>/commit/<sha>" host-correctly (github.com or GHES) without a wire
  // field. Null when the html_url is absent → ShaLink degrades to plain text.
  const commitBase = useMemo(
    () => (prHtmlUrl ? prHtmlUrl.replace(/\/pull\/\d+.*$/, '') : null),
    [prHtmlUrl],
  );

  // Bot toggle persists for this feed for the session (sessionStorage). Global key, not per-PR —
  // the user's "show bots" preference is a viewing mode, not PR state.
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
      {/* Separator sits AFTER the composer: the composer is the first element of the card and the
          timeline follows below it. */}
      <div className={styles.composerDivider} aria-hidden="true" />
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
                commitBase={commitBase}
              />
            ) : node.event.body != null ? (
              <CommentNode key={node.event.id} event={node.event} />
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
