import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewSessionDto,
} from '../../../api/types';
import type { DraftSessionStatus } from '../../../hooks/useDraftSession';
import { DraftsTabSkeleton } from './DraftsTabSkeleton';
import { DraftsTabError } from './DraftsTabError';
import { DraftListEmpty } from './DraftListEmpty';
import { DraftListItem, type DraftLike } from './DraftListItem';
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
  // Replies have no file anchor — group under a synthetic "PR-root replies"
  // entry per spec § 5.4 ("…or under a file-less PR-root replies group when
  // the parent thread is on the PR conversation"). PoC simplification:
  // group ALL replies under the file-less bucket; mapping replies back to
  // their parent thread's file requires the PR detail loader's review-thread
  // index, which the Drafts tab does not currently consume.
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

  const handleEdit = (draft: DraftLike) => {
    const base = `/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
    if (draft.kind === 'comment' && draft.data.filePath != null) {
      navigate(`${base}/files/${draft.data.filePath}?line=${draft.data.lineNumber ?? ''}`);
      return;
    }
    // PR-root drafts (filePath null) and replies (no file anchor in their
    // own DTO) navigate to the Overview tab. The Files-tab Edit mechanic
    // for replies-on-file-threads is deferred — replies need a thread → file
    // index that the Drafts tab does not currently load.
    navigate(base);
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
          {summary.total} draft{summary.total === 1 ? '' : 's'} on {summary.files} file
          {summary.files === 1 ? '' : 's'}
        </span>
        {summary.staleCount > 0 && (
          <span className="chip chip-status-stale">{summary.staleCount} stale</span>
        )}
        {(staleComments.length > 0 || staleReplies.length > 0) && (
          <DiscardAllStaleButton
            prRef={prRef}
            staleComments={staleComments}
            staleReplies={staleReplies}
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
}: {
  group: FileGroup;
  prRef: PrReference;
  onEdit: (draft: DraftLike) => void;
}) {
  const heading = group.filePath ?? 'PR-root replies';
  return (
    <section className="drafts-tab-file-group">
      <h3 className="drafts-tab-file-heading">{heading}</h3>
      {group.comments.map((c) => (
        <DraftListItem
          key={c.id}
          prRef={prRef}
          draft={{ kind: 'comment', data: c }}
          onEdit={onEdit}
        />
      ))}
      {group.replies.map((r) => (
        <DraftListItem
          key={r.id}
          prRef={prRef}
          draft={{ kind: 'reply', data: r }}
          onEdit={onEdit}
        />
      ))}
    </section>
  );
}
