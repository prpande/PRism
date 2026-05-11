interface CrossTabPresenceBannerProps {
  visible: boolean;
  onSwitchToOther: () => void;
  onTakeOver: () => void;
  onDismiss: () => void;
}

// Spec § 5.7a. Surfaces "this PR is open in another tab" with three actions.
// The banner is non-dismissable via the usual × control — the user must
// pick one of: switch tabs, take over, or "dismiss for this session" (which
// is the explicit "I know, leave me alone" affordance and writes to
// sessionStorage so the banner stays gone for the rest of this tab session).
export function CrossTabPresenceBanner({
  visible,
  onSwitchToOther,
  onTakeOver,
  onDismiss,
}: CrossTabPresenceBannerProps) {
  if (!visible) return null;
  return (
    <div role="alert" aria-live="assertive" className="cross-tab-presence-banner">
      <span className="cross-tab-presence-banner-message">
        This PR is open in another tab. Saves may overwrite each other.
      </span>
      <div className="cross-tab-presence-banner-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSwitchToOther}>
          Switch to other tab
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={onTakeOver}>
          Take over here
        </button>
        <button type="button" className="btn btn-link btn-sm" onClick={onDismiss}>
          Dismiss for this session
        </button>
      </div>
    </div>
  );
}
