import type { FileChange, ReviewThreadDto } from '../../../../api/types';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import { DiffTruncationBanner } from './DiffTruncationBanner';
import { WordDiffOverlay } from './WordDiffOverlay';

export type DiffMode = 'side-by-side' | 'unified';

export interface DiffPaneProps {
  selectedPath: string | null;
  file: FileChange | null;
  diffMode: DiffMode;
  truncated: boolean;
  reviewThreads: ReviewThreadDto[];
  prUrl: string;
}

interface DiffLine {
  type: 'context' | 'insert' | 'delete' | 'hunk-header';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
}

function parseHunkLines(body: string): DiffLine[] {
  const rawLines = body.split('\n');
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const raw of rawLines) {
    if (raw.startsWith('@@')) {
      const match = /@@ -(\d+),?\d* \+(\d+),?\d* @@/.exec(raw);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      lines.push({ type: 'hunk-header', content: raw, oldLineNum: null, newLineNum: null });
    } else if (raw.startsWith('+')) {
      lines.push({ type: 'insert', content: raw.slice(1), oldLineNum: null, newLineNum: newLine });
      newLine++;
    } else if (raw.startsWith('-')) {
      lines.push({ type: 'delete', content: raw.slice(1), oldLineNum: oldLine, newLineNum: null });
      oldLine++;
    } else if (raw.startsWith(' ')) {
      lines.push({ type: 'context', content: raw.slice(1), oldLineNum: oldLine, newLineNum: newLine });
      oldLine++;
      newLine++;
    }
  }

  return lines;
}

function findAdjacentPair(lines: DiffLine[], idx: number): DiffLine | null {
  const line = lines[idx];
  if (line.type === 'delete') {
    const next = lines[idx + 1];
    if (next?.type === 'insert') return next;
  }
  if (line.type === 'insert') {
    const prev = lines[idx - 1];
    if (prev?.type === 'delete') return prev;
  }
  return null;
}

export function DiffPane({
  selectedPath,
  file,
  diffMode,
  truncated,
  reviewThreads,
  prUrl,
}: DiffPaneProps) {
  if (!selectedPath) {
    return (
      <div className="diff-pane diff-pane--empty">
        <p className="muted">Select a file from the tree to view its diff.</p>
      </div>
    );
  }

  if (!file || file.hunks.length === 0) {
    return (
      <div className="diff-pane">
        <div className="diff-pane-header">
          <span className="diff-pane-path">{selectedPath}</span>
        </div>
        <div className="diff-pane-body muted">Empty file — no changes to display.</div>
      </div>
    );
  }

  const fileThreads = reviewThreads.filter((t) => t.filePath === selectedPath);
  const threadsByLine = new Map<number, ReviewThreadDto[]>();
  for (const t of fileThreads) {
    const existing = threadsByLine.get(t.lineNumber) ?? [];
    existing.push(t);
    threadsByLine.set(t.lineNumber, existing);
  }

  const allLines: DiffLine[] = [];
  for (const hunk of file.hunks) {
    allLines.push(...parseHunkLines(hunk.body));
  }

  const isSplit = diffMode === 'side-by-side';
  const modeClass = isSplit ? 'diff-pane--split' : 'diff-pane--unified';

  return (
    <div className={`diff-pane ${modeClass}`}>
      <div className="diff-pane-header">
        <span className="diff-pane-path">{selectedPath}</span>
      </div>
      <div className="diff-pane-body">
        <table className="diff-table">
          <tbody>
            {allLines.map((line, idx) => {
              // Attach comments to new-side line numbers (insert/context), matching GitHub convention
              const commentLineNum = line.type === 'delete' ? null : line.newLineNum;
              const threadsAtLine = commentLineNum ? threadsByLine.get(commentLineNum) : undefined;
              const pair = findAdjacentPair(allLines, idx);

              return (
                <DiffLineRow
                  key={idx}
                  line={line}
                  pair={pair}
                  threadsAtLine={threadsAtLine}
                  isSplit={isSplit}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      {truncated && <DiffTruncationBanner prUrl={prUrl} />}
    </div>
  );
}

interface DiffLineRowProps {
  line: DiffLine;
  pair: DiffLine | null;
  threadsAtLine: ReviewThreadDto[] | undefined;
  isSplit: boolean;
}

function DiffLineRow({ line, pair, threadsAtLine, isSplit }: DiffLineRowProps) {
  const rowClass = `diff-line diff-line--${line.type}`;

  const renderContent = () => {
    if (line.type === 'hunk-header') {
      return <span className="diff-hunk-header">{line.content}</span>;
    }

    if ((line.type === 'insert' || line.type === 'delete') && pair) {
      const oldText = line.type === 'delete' ? line.content : pair.content;
      const newText = line.type === 'insert' ? line.content : pair.content;
      return (
        <WordDiffOverlay
          oldText={oldText}
          newText={newText}
          type={line.type}
        />
      );
    }

    return <span>{line.content}</span>;
  };

  return (
    <>
      <tr className={rowClass}>
        {isSplit ? (
          <>
            <td className="diff-gutter diff-gutter--old">
              {line.oldLineNum ?? ''}
            </td>
            <td className="diff-gutter diff-gutter--new">
              {line.newLineNum ?? ''}
            </td>
          </>
        ) : (
          <>
            <td className="diff-gutter diff-gutter--old">
              {line.oldLineNum ?? ''}
            </td>
            <td className="diff-gutter diff-gutter--new">
              {line.newLineNum ?? ''}
            </td>
          </>
        )}
        <td className="diff-content">{renderContent()}</td>
      </tr>
      {threadsAtLine && threadsAtLine.length > 0 && (
        <tr className="diff-comment-row">
          <td colSpan={isSplit ? 3 : 3}>
            <ExistingCommentWidget threads={threadsAtLine} />
          </td>
        </tr>
      )}
    </>
  );
}
