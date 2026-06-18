import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { formatAge } from '../../utils/relativeTime';
import { Avatar } from '../Avatar/Avatar';
import { AiMarker } from '../Ai/AiMarker';
import { AI_PROVENANCE_LABEL } from '../Ai/aiStrings';
import { DiffBar } from './DiffBar';
import styles from './InboxRow.module.css';

// ---- Leading PR-state octicons (Primer v19, 16-viewBox), every row ----
type PrState = 'open' | 'merged' | 'closed';
const PR_GLYPH_PATH: Record<PrState, string> = {
  open: 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
  merged:
    'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0-8a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5 4a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
  closed:
    'M10.72 1.227a.75.75 0 0 1 1.06 0l.97.97.97-.97a.75.75 0 1 1 1.06 1.061l-.97.97.97.97a.75.75 0 1 1-1.06 1.06l-.97-.97-.97.97a.75.75 0 1 1-1.06-1.06l.97-.97-.97-.97a.75.75 0 0 1 0-1.06Zm-9.22 2.02a2.25 2.25 0 1 1 3 2.123v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm10.5 7.503a2.25 2.25 0 1 1-1.5 0V8.755a.75.75 0 0 1 1.5 0ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z',
};
const PR_GLYPH_CLASS: Record<PrState, string> = {
  open: 'prOpen',
  merged: 'prMerged',
  closed: 'prClosed',
};

// ---- CI title-suffix octicons (bare check / cross, no enclosing circle) ----
type VisibleCi = 'passing' | 'failing' | 'pending';
const CI_GLYPH_PATH: Record<VisibleCi, string> = {
  passing:
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  failing:
    'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
  pending: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
};
const CI_GLYPH_CLASS: Record<VisibleCi, string> = {
  passing: 'ciPassing',
  failing: 'ciFailing',
  pending: 'ciPending',
};
// Single source of truth for the CI label — used for both the aria suffix and the <title>.
const CI_GLYPH_LABEL: Record<VisibleCi, string> = {
  passing: 'CI passing',
  failing: 'CI failing',
  pending: 'CI pending',
};

interface Props {
  pr: PrInboxItem;
  enrichment?: InboxItemEnrichment;
  showCategoryChip: boolean;
  maxDiff: number;
  showRepo?: boolean;
  grouped?: boolean;
}

export function InboxRow({
  pr,
  enrichment,
  showCategoryChip,
  maxDiff,
  showRepo = true,
  grouped = false,
}: Props) {
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const doneState: 'merged' | 'closed' | null =
    pr.mergedAt != null ? 'merged' : pr.closedAt != null ? 'closed' : null;
  const isDone = doneState != null;
  // "Unread" = the PR's current head differs from the head the user last saw
  // (#121/#122). This covers both a never-opened PR (lastViewedHeadSha == null,
  // so it can't equal headSha → unread) and one whose head moved since it was
  // last viewed. Seen + unchanged → not unread. Done PRs are terminal, never
  // flagged. Commits-only: the inbox payload has no latest-comment id, so
  // comment-unread isn't derivable here.
  const hasUnseenActivity = !isDone && pr.lastViewedHeadSha !== pr.headSha;
  const onClick = () => {
    addTab(pr.reference, pr.title);
    navigate(`/pr/${pr.reference.owner}/${pr.reference.repo}/${pr.reference.number}`);
  };

  const prState: PrState = doneState ?? 'open';

  // CI rides the aria-label (glyph is aria-hidden); open rows only. Reuses
  // CI_GLYPH_LABEL so the suffix and the <title> tooltip never drift.
  const ciSuffix = !isDone && pr.ci !== 'none' ? ` · ${CI_GLYPH_LABEL[pr.ci]}` : '';

  // #489: the chip's sparkle is visual-only (button swallows descendant labels),
  // so the AI provenance rides the row aria-label instead.
  const aiSuffix = showCategoryChip && enrichment?.categoryChip ? ` · ${AI_PROVENANCE_LABEL}` : '';

  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}${aiSuffix}`
    : `${pr.title} · ${pr.repo} · open · iteration ${pr.iterationNumber}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}${aiSuffix}`;

  return (
    <button
      className={styles.row}
      data-unread={hasUnseenActivity ? 'true' : 'false'}
      data-grouped={grouped ? 'true' : 'false'}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <span className={styles.status}>
        <svg
          className={`${styles.prState} ${styles[PR_GLYPH_CLASS[prState]]}`}
          data-pr-state={prState}
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="currentColor"
          aria-hidden="true"
        >
          <title>{`PR ${prState}`}</title>
          <path d={PR_GLYPH_PATH[prState]} />
        </svg>
      </span>
      <span className={styles.midCol}>
        <span className={styles.main}>
          <span className={styles.titleRow}>
            <span className={styles.title} title={pr.title}>
              {pr.title}
            </span>
          </span>
          <span className={styles.meta}>
            {pr.isDraft && !isDone ? (
              <span className={styles.chipWrap}>
                <span className={styles.draftChip}>Draft</span>
                <span className={styles.dotsep}>·</span>
              </span>
            ) : (
              showCategoryChip &&
              enrichment?.categoryChip && (
                <span className={styles.chipWrap}>
                  {/* #283 visual AI-preview marker. The fake category is visual-only (the row's
                    aria-label omits it and the button swallows descendant labels), so this is a
                    sighted-user cue, not an a11y mechanism. The marker is fixed-width (flex:none)
                    so the category text — not the marker — absorbs any width pressure, and it
                    hides together with the chip below the 560px breakpoint. */}
                  <span className={styles.chip}>
                    <AiMarker variant="inline" decorative className={styles.chipMarker} />
                    {enrichment.categoryChip}
                  </span>
                  <span className={styles.dotsep}>·</span>
                </span>
              )
            )}
            {showRepo && (
              <>
                <span className={styles.mono}>{pr.repo}</span>
                <span className={styles.dotsep}>·</span>
              </>
            )}
            <span className={styles.author} data-testid="inbox-author">
              <Avatar src={pr.avatarUrl} login={pr.author} size="sm" />
              <span className={styles.authorName}>{pr.author}</span>
            </span>
            <span className={styles.dotsep}>·</span>
            <span className={styles.mono}>iter {pr.iterationNumber}</span>
            <span className={styles.dotsep}>·</span>
            <span>{formatAge(pr.updatedAt)}</span>
          </span>
        </span>
        {/* CI glyph — sibling of .main inside the row-centering .midCol so it sits on
            the row's vertical center, in line with the right-side metrics it reads with,
            rather than pinned to the title's first line (#345). */}
        {!isDone && pr.ci !== 'none' && (
          <svg
            className={`${styles.ciSuffix} ${styles[CI_GLYPH_CLASS[pr.ci]]}`}
            data-ci={pr.ci}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            fill="currentColor"
            aria-hidden="true"
          >
            <title>{CI_GLYPH_LABEL[pr.ci]}</title>
            <path d={CI_GLYPH_PATH[pr.ci]} />
          </svg>
        )}
      </span>
      <span className={styles.tail}>
        <span className={styles.metrics}>
          <span className={styles.diffSlot}>
            <DiffBar additions={pr.additions} deletions={pr.deletions} max={maxDiff} />
          </span>
          <span className={`${styles.counts} ${styles.countsSlot}`}>
            <span className={styles.add}>+{pr.additions}</span>
            <span className={styles.del}>−{pr.deletions}</span>
          </span>
          <span className={styles.commentSlot}>
            {pr.commentCount > 0 && (
              <span className={styles.comments}>
                <svg
                  className={styles.commentIcon}
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  {/* Octicon comment-16 — signals the number is a comment count */}
                  <path d="M1.75 1h12.5c.966 0 1.75.784 1.75 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.061l-2.574 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25v-9.5C0 1.784.784 1 1.75 1ZM1.5 2.75v8.5a.25.25 0 0 0 .25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25H1.75a.25.25 0 0 0-.25.25Z" />
                </svg>
                {pr.commentCount}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
