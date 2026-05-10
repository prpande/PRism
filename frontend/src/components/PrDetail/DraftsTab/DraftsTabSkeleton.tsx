export function DraftsTabSkeleton() {
  return (
    <div className="drafts-tab-skeleton" data-testid="drafts-tab-skeleton" aria-busy="true">
      <div className="drafts-tab-skeleton-header skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}
