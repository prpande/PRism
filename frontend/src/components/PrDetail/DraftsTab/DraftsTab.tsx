import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewSessionDto,
} from '../../../api/types';
import type { DraftSessionStatus } from '../../../hooks/useDraftSession';
import type { DraftLike } from '../draftKinds';
import { DraftsTabSkeleton } from './DraftsTabSkeleton';
import { DraftsTabError } from './DraftsTabError';
import { DraftListEmpty } from './DraftListEmpty';
import { DraftListItem } from './DraftListItem';
import { DiscardAllStaleButton } from './DiscardAllStaleButton';

interface DraftsTabProps {
  prRef: PrReference;
  session: ReviewSessionDto | null;
  status: DraftSessionStatus;
  refetch: () => Promise<void>;
}

interface CountSummary {
  total: number;
  files: number;
  staleCount: number; // excludes overridden
}

function summarize(session: ReviewSessionDto): CountSummary {
  const total = session.draftComments.length + session.draftReplies.length;
  const fileSet = new Set<string>();
  for (const c of session.draftComments) {
    if (c.filePath) fileSet.add(c.filePath);
  }
  let staleCount = 0;
  for (const c of session.draftComments) {
    if (c.status === 'stale' && !c.isOverriddenStale) staleCount++;
  }
  for (const r of session.draftReplies) {
    if (r.status === 'stale' && !r.isOverriddenStale) staleCount++;
  }
  return { total, files: fileSet.size, staleCount };
}

interface FileGroup {
  filePath: string | null;
  comments: DraftCommentDto[];
  replies: DraftReplyDto[];
}

function groupByFile(session: ReviewSessionDto): FileGroup[] {
  const byFile = new Map<string | null, FileGroup>();
  const ensure = (key: string | null): FileGroup => {
    let g = byFile.get(key);
    if (!g) {
      g = { filePath: key, comments: [], replies: [] };
      byFile.set(key, g);
    }
    return g;
  };
  for (const c of session.draftComments) {
    ensure(c.filePath ?? null).comments.push(c);
  }
  // Replies have no file anchor in their DTO. Mapping replies back to
  // their parent thread's file requires the PR detail loader's review-
  // thread index, which the Drafts tab does not currently consume; for
  // the PoC, all replies AND PR-root draft comments share a single
  // file-less group. The heading "PR conversation drafts" reflects that
  // both shapes (PR-root comment + replies on any thread) live there.
  for (const r of session.draftReplies) {
    ensure(null).replies.push(r);
  }
  // Stable order: file paths first (sorted), then PR-root group last.
  const out: FileGroup[] = [];
  const filed = [...byFile.values()].filter((g) => g.filePath !== null);
  filed.sort((a, b) => (a.filePath ?? '').localeCompare(b.filePath ?? ''));
  out.push(...filed);
  const rootGroup = byFile.get(null);
  if (rootGroup) out.push(rootGroup);
  return out;
}

export function DraftsTab({ prRef, session, status, refetch }: DraftsTabProps) {
  const navigate = useNavigate();

  // Hooks must run unconditionally — branch on `session` *after* memoizing.
  const summary = useMemo(() => (session ? summarize(session) : null), [session]);
  const groups = useMemo(() => (session ? groupByFile(session) : []), [session]);

  if (status === 'loading') return <DraftsTabSkeleton />;
  if (status === 'error') return <DraftsTabError onRetry={() => void refetch()} />;
  if (!session || !summary) return <DraftsTabSkeleton />;

  const staleComments = session.draftComments.filter(
    (c) => c.status === 'stale' && !c.isOverriddenStale,
  );
  const staleReplies = session.draftReplies.filter(
    (r) => r.status === 'stale' && !r.isOverriddenStale,
  );

  // FilesTab does not currently consume `:filePath/*` splat or `?line=`
  // (S3's deep-link plumbing was never wired through to selection state),
  // so a precise file-and-line nav would land users on the Files tab with
  // selectedPath=null. For the PoC we navigate to the bare Files tab and
  // let the user pick the file from the tree manually. Tracked in the
  // deferrals doc; lift when FilesTab gains URL→state hydration.
  const handleEdit = (draft: DraftLike) => {
    const base = `/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
    if (draft.kind === 'comment' && draft.data.filePath != null) {
      navigate(`${base}/files`);
      return;
    }
    // PR-root drafts (filePath null) and replies navigate to the Overview tab.
    navigate(base);
  };

  const handleMutated = () => {
    void refetch();
  };

  if (summary.total === 0) {
    return (
      <div className="drafts-tab">
        <div className="drafts-tab-header">
          <span className="drafts-tab-header-title">0 drafts</span>
        </div>
        <DraftListEmpty />
      </div>
    );
  }

  return (
    <div className="drafts-tab">
      <div className="drafts-tab-header row gap-2">
        <span className="drafts-tab-header-title">
          {summary.total} draft{summary.total === 1 ? '' : 's'}
          {summary.files > 0 && (
            <>
              {' '}
              on {summary.files} file{summary.files === 1 ? '' : 's'}
            </>
          )}
        </span>
        {summary.staleCount > 0 && (
          <span className="chip chip-status-stale">{summary.staleCount} stale</span>
        )}
        {(staleComments.length > 0 || staleReplies.length > 0) && (
          <DiscardAllStaleButton
            prRef={prRef}
            staleComments={staleComments}
            staleReplies={staleReplies}
            onMutated={handleMutated}
          />
        )}
      </div>
      <div className="drafts-tab-body">
        {groups.map((g) => (
          <FileGroupSection
            key={g.filePath ?? '__pr-root__'}
            group={g}
            prRef={prRef}
            onEdit={handleEdit}
            onMutated={handleMutated}
          />
        ))}
      </div>
    </div>
  );
}

function FileGroupSection({
  group,
  prRef,
  onEdit,
  onMutated,
}: {
  group: FileGroup;
  prRef: PrReference;
  onEdit: (draft: DraftLike) => void;
  onMutated: () => void;
}) {
  // The null-key bucket holds both PR-root draft comments AND all
  // (file-anchored) replies. "PR conversation drafts" covers both shapes
  // without misleading users that the section is replies-only.
  const heading = group.filePath ?? 'PR conversation drafts';
  return (
    <section className="drafts-tab-file-group">
      <h3 className="drafts-tab-file-heading">{heading}</h3>
      {group.comments.map((c) => (
        <DraftListItem
          key={c.id}
          prRef={prRef}
          draft={{ kind: 'comment', data: c }}
          onEdit={onEdit}
          onMutated={onMutated}
        />
      ))}
      {group.replies.map((r) => (
        <DraftListItem
          key={r.id}
          prRef={prRef}
          draft={{ kind: 'reply', data: r }}
          onEdit={onEdit}
          onMutated={onMutated}
        />
      ))}
    </section>
  );
}
