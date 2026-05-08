export interface DiffPaneProps {
  selectedPath: string | null;
}

export function DiffPane({ selectedPath }: DiffPaneProps) {
  if (!selectedPath) {
    return (
      <div className="diff-pane diff-pane--empty">
        <p className="muted">Select a file from the tree to view its diff.</p>
      </div>
    );
  }

  return (
    <div className="diff-pane">
      <div className="diff-pane-header">
        <span className="diff-pane-path">{selectedPath}</span>
      </div>
      <div className="diff-pane-body muted">Diff content lands in Task 8.</div>
    </div>
  );
}
