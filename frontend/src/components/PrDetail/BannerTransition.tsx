interface Props {
  state: 'merged' | 'closed';
  onReload: () => void;
}

export function BannerTransition({ state, onReload }: Props) {
  return (
    <div className="banner banner-warning" role="status" aria-live="polite">
      This PR was just {state}. Unsubmitted drafts can no longer be submitted.{' '}
      <button type="button" className="btn btn-primary btn-sm" onClick={onReload}>
        Reload to read-only view
      </button>
    </div>
  );
}
