import { useNavigate } from 'react-router-dom';
import type { PrInboxItem, InboxItemEnrichment } from '../../api/types';
import { useOpenTabs } from '../../contexts/OpenTabsContext';
import { formatAge } from '../../utils/relativeTime';
import { Avatar } from '../Avatar/Avatar';
import { AiMarker } from '../Ai/AiMarker';
import { AI_PROVENANCE_LABEL, AI_INBOX_ENRICHING_LABEL } from '../Ai/aiStrings';
import { prId } from './groupByRepo';
import { DiffBar } from './DiffBar';
import { PrStateGlyph, type GlyphState } from '../shared/prStateGlyph';
import styles from './InboxRow.module.css';

// ---- Leading PR-state octicons (Primer v19, 16-viewBox), every row ----
// The glyph itself is single-sourced from the shared PrStateGlyph component (#530);
// the open/merged/closed taxonomy below maps GitHub's done-flags to a display state.
type PrState = 'open' | 'merged' | 'closed';

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
  settled: ReadonlySet<string>;
}

export function InboxRow({
  pr,
  enrichment,
  showCategoryChip,
  maxDiff,
  showRepo = true,
  grouped = false,
  settled,
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

  // #501 — display discriminant for the status glyph. Drafts only matter while open
  // (merged/closed win via precedence); the PrState type stays open/merged/closed.
  // Same shape as PrHeader's derivation (prState === 'open' ⟺ !isDone here) so the
  // two read identically across surfaces.
  const glyphState: GlyphState = pr.isDraft && prState === 'open' ? 'draft' : prState;

  // CI rides the aria-label (glyph is aria-hidden); open rows only. Reuses
  // CI_GLYPH_LABEL so the suffix and the <title> tooltip never drift.
  const ciSuffix = !isDone && pr.ci !== 'none' ? ` · ${CI_GLYPH_LABEL[pr.ci]}` : '';

  const commitLabel = `${pr.commitCount} ${pr.commitCount === 1 ? 'commit' : 'commits'}`;

  // #489: the chip's sparkle is visual-only (button swallows descendant labels),
  // so the AI provenance rides the row aria-label instead.
  const aiSuffix = showCategoryChip && enrichment?.categoryChip ? ` · ${AI_PROVENANCE_LABEL}` : '';

  // #508/#548: per-row chip state. Draft short-circuits to the draft chip in the render
  // so we gate chipState AFTER that branch wins — a draft open PR must not show a category
  // working marker. The draft-chip branch is `pr.isDraft && !isDone` in the JSX, so we
  // mirror that condition here.
  const id = prId(pr);
  let chipState: 'off' | 'loading' | 'ready' | 'empty';
  if (pr.isDraft && !isDone) {
    chipState = 'off';
  } else if (!showCategoryChip) {
    chipState = 'off';
  } else if (!settled.has(id)) {
    chipState = 'loading';
  } else {
    chipState = enrichment?.categoryChip ? 'ready' : 'empty';
  }

  // Loading suffix rides the aria-label (the marker is decorative when loading so the
  // button's own aria-label is the only SR announcement). Must append to BOTH branches.
  const aiLoadingSuffix = chipState === 'loading' ? ` · ${AI_INBOX_ENRICHING_LABEL}` : '';

  // On an open row the state word is glyphState ('draft' for an open draft, else 'open');
  // merged/closed rows use doneState. Open rows announce commit count — main's commit/changed
  // split replaced V2's iteration metric. Unread / CI / AI suffixes unchanged.
  const ariaLabel = isDone
    ? `${pr.title} · ${pr.repo} · ${doneState}${aiSuffix}${aiLoadingSuffix}`
    : `${pr.title} · ${pr.repo} · ${glyphState} · ${commitLabel}${
        hasUnseenActivity ? ' · unread' : ''
      }${ciSuffix}${aiSuffix}${aiLoadingSuffix}`;

  return (
    <button
      className={styles.row}
      data-unread={hasUnseenActivity ? 'true' : 'false'}
      data-grouped={grouped ? 'true' : 'false'}
      onClick={onClick}
      aria-label={ariaLabel}
    >
      <span className={styles.status}>
        <PrStateGlyph state={glyphState} />
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
            ) : chipState === 'loading' ? (
              <span className={styles.chipWrap}>
                {/* #508/#548 — while enrichment is in flight show ONLY the pulsing AI marker in
                    the chip slot (no chip box); the full category chip box replaces it in place
                    when the categorisation arrives (owner B1 2026-06-19). The slot is not
                    width-reserved, so the meta line settles left when the box appears — accepted.
                    Decorative: the aria-loading suffix on the row button carries the SR announcement. */}
                <AiMarker variant="inline" state="working" decorative />
                <span className={styles.dotsep}>·</span>
              </span>
            ) : chipState === 'ready' && enrichment?.categoryChip ? (
              <span className={styles.chipWrap}>
                {/* #283 visual AI-preview marker. The category is visual-only (the row's
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
            ) : null}
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
            <span className={styles.mono}>{commitLabel}</span>
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
          <span className={styles.filesSlot}>
            {pr.changedFiles > 0 && (
              <span className={styles.files}>
                <svg
                  className={styles.fileIcon}
                  viewBox="0 0 16 16"
                  width="12"
                  height="12"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  {/* Octicon file-16 */}
                  <path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z" />
                </svg>
                {pr.changedFiles}
              </span>
            )}
          </span>
        </span>
      </span>
    </button>
  );
}
