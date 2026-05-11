interface CrossTabPresenceBannerProps {
  visible: boolean;
  // True when a peer tab has CLAIMED ownership of this PR via the take-over
  // action. The banner stays mounted (instead of hiding when showBanner
  // clears) so the user has an in-page affordance to switch back to the
  // other tab; the copy and action set adapt to this state so it is clear
  // why composers/actions are disabled.
  readOnly: boolean;
  onSwitchToOther: () => void;
  onTakeOver: () => void;
  onDismiss: () => void;
}

// Spec § 5.7a. Surfaces "this PR is open in another tab" with three actions.
// The banner is non-dismissable via the usual × control — the user must
// pick one of: switch tabs, take over, or "dismiss for this session" (which
// is the explicit "I know, leave me alone" affordance and writes to
// sessionStorage so the banner stays gone for the rest of this tab session).
//
// Read-only mode (peer tab claimed ownership): the banner stays visible with
// the read-only copy + the Switch-to-other-tab action so the user can recover
// without reloading the page. Take-over is hidden in read-only mode because
// re-claiming defeats the cross-tab UX (it just bounces ownership back).
export function CrossTabPresenceBanner({
  visible,
  readOnly,
  onSwitchToOther,
  onTakeOver,
  onDismiss,
}: CrossTabPresenceBannerProps) {
  // Always render when read-only — the message is the user's only signal
  // that their composer is disabled because of cross-tab take-over.
  if (!visible && !readOnly) return null;
  const message = readOnly
    ? 'Another tab claimed this PR. Composer actions are disabled here. Switch to that tab to keep editing.'
    : 'This PR is open in another tab. Saves may overwrite each other.';
  return (
    <div role="alert" aria-live="assertive" className="cross-tab-presence-banner">
      <span className="cross-tab-presence-banner-message">{message}</span>
      <div className="cross-tab-presence-banner-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onSwitchToOther}>
          Switch to other tab
        </button>
        {!readOnly && (
          <button type="button" className="btn btn-primary btn-sm" onClick={onTakeOver}>
            Take over here
          </button>
        )}
        {!readOnly && (
          // In read-only mode, the banner is the only signal that composers
          // are disabled; clicking Dismiss would set sessionStorage but the
          // banner would still re-render (the `!readOnly` short-circuit
          // forces it visible), so the button would appear to do nothing.
          // Hide it to avoid a confusing no-op control. Recovery from
          // read-only is via Switch-to-other-tab or a page reload.
          <button type="button" className="btn btn-link btn-sm" onClick={onDismiss}>
            Dismiss for this session
          </button>
        )}
      </div>
    </div>
  );
}
