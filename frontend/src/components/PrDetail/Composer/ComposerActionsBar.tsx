import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import type { ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';

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
  return (
    <div className="composer-actions">
      <button
        type="button"
        className="composer-preview-toggle"
        aria-pressed={previewMode}
        onClick={onTogglePreview}
      >
        {previewMode ? 'Edit' : 'Preview'}
      </button>

      <span className={`composer-badge composer-badge--${badge}`} role="status" data-testid="composer-badge">
        {badge}
      </span>

      <AiComposerAssistant />

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
        title={postNowTooltip}
        onClick={onPostNow}
        disabled={readOnly || posting}
      >
        {posting ? 'Posting…' : 'Comment'}
      </button>
      {closedBanner && (
        <span className="composer-merged-note">
          {prState === 'closed' ? 'PR is closed' : 'PR is merged'} — comments post immediately
        </span>
      )}
      {postError && (
        <div className="composer-error" role="alert">
          {postError}
        </div>
      )}
    </div>
  );
}
