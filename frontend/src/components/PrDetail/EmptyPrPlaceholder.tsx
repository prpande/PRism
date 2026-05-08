export function EmptyPrPlaceholder() {
  return (
    <div role="status" className="empty-pr-placeholder">
      <p className="empty-pr-placeholder-title">No commits yet</p>
      <p className="empty-pr-placeholder-body muted">
        Once the author pushes commits, they'll show up here.
      </p>
    </div>
  );
}
