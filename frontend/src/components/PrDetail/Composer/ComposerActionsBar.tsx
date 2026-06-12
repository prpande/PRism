import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import { badgeLabel, type ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';

export interface ComposerActionsBarProps {
  previewMode: boolean;
  onTogglePreview: () => void;
  badge: ComposerSaveBadge;
  saveDisabled: boolean;
  saveTooltip: string | undefined;
  addLabel: string;
  closedBanner: boolean;
  prState: 'open' | 'closed' | 'merged';
  postNowDisabled: boolean;
  postNowTooltip: string | undefined;
  posting: boolean;
  postError: string | null;
  readOnly: boolean;
  onDiscardClick: () => void;
  onSaveClick: () => void;
  onPostNow: () => void;
}

export function ComposerActionsBar({
  previewMode,
  onTogglePreview,
  badge,
  saveDisabled,
  saveTooltip,
  addLabel,
  closedBanner,
  prState,
  postNowDisabled,
  postNowTooltip,
  posting,
  postError,
  readOnly,
  onDiscardClick,
  onSaveClick,
  onPostNow,
}: ComposerActionsBarProps) {
  // #390 — on a merged/closed PR the inline "PR is merged …" note is gone; keep
  // the "posts immediately" context as the immediate-post button's tooltip
  // (title, not aria-label, so the visible "Comment" text stays the accessible
  // name — WCAG 2.5.3 label-in-name).
  const postNowTitle = closedBanner
    ? `Post directly to this ${prState === 'closed' ? 'closed' : 'merged'} PR`
    : postNowTooltip;
  return (
    <div className="composer-actions">
      {/* left group */}
      <button
        type="button"
        className="composer-preview-toggle"
        aria-pressed={previewMode}
        onClick={onTogglePreview}
      >
        {previewMode ? 'Edit' : 'Preview'}
      </button>

      <AiComposerAssistant />

      <span
        className={`composer-badge composer-badge--${badge}`}
        role="status"
        data-testid="composer-badge"
      >
        {badgeLabel(badge)}
      </span>

      <span className="composer-actions-spacer" aria-hidden="true" />

      {/* right group */}
      <button
        type="button"
        className="composer-discard"
        onClick={onDiscardClick}
        disabled={readOnly}
        aria-disabled={readOnly || undefined}
      >
        Discard
      </button>

      {!closedBanner && (
        <button
          type="button"
          className="composer-save btn btn-primary btn-sm"
          aria-disabled={saveDisabled}
          title={saveTooltip}
          onClick={onSaveClick}
          disabled={readOnly}
        >
          {addLabel}
        </button>
      )}
      <button
        type="button"
        className="composer-post-now"
        aria-disabled={postNowDisabled}
        title={postNowTitle}
        onClick={onPostNow}
        disabled={readOnly || posting}
      >
        {posting ? 'Posting…' : 'Comment'}
      </button>
      {postError && (
        <div className="composer-error" role="alert">
          {postError}
        </div>
      )}
    </div>
  );
}
