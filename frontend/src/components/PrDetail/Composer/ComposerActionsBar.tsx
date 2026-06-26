import { useId } from 'react';
import { AiComposerAssistant } from '../../Ai/AiComposerAssistant';
import type { ComposerSaveBadge } from '../../../hooks/useComposerAutoSave';
import { ComposerStatusBadge } from './ComposerStatusBadge';

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
  // #390 — on a merged/closed PR the inline "PR is merged …" note is gone. Keep
  // the "posts immediately" context as (a) the button's tooltip for mouse users
  // and (b) an `aria-describedby` sr-only description for keyboard/touch/SR users
  // (title alone isn't reliably announced). "Comment" stays the accessible NAME
  // (WCAG 2.5.3 label-in-name); the merged context is a description, not the name.
  const mergedContext = closedBanner
    ? `Post directly to this ${prState === 'closed' ? 'closed' : 'merged'} PR`
    : undefined;
  const postNowTitle = mergedContext ?? postNowTooltip;
  const mergedContextId = useId();
  // #601 — every mutating action (Discard, Save, post-now) is inert while a
  // post is in flight or the tab is cross-tab read-only.
  const actionsLocked = readOnly || posting;
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

      <ComposerStatusBadge badge={badge} readOnly={readOnly} />

      <span className="composer-actions-spacer" aria-hidden="true" />

      {/* right group */}
      <button
        type="button"
        className="composer-discard"
        onClick={onDiscardClick}
        disabled={actionsLocked}
        aria-disabled={actionsLocked || undefined}
      >
        Discard
      </button>

      {!closedBanner && (
        <button
          type="button"
          className="composer-save btn btn-primary btn-sm"
          // Mirror the native `disabled` (actionsLocked = readOnly || posting) so
          // aria-disabled reflects the cross-tab read-only lock too. Kept as an
          // always-present true/false (no `|| undefined`) — the A3 a11y test
          // asserts an explicit aria-disabled="false" on the enabled Save button.
          aria-disabled={saveDisabled || actionsLocked}
          title={saveTooltip}
          onClick={onSaveClick}
          disabled={actionsLocked}
        >
          {addLabel}
        </button>
      )}
      <button
        type="button"
        className="composer-post-now"
        aria-disabled={postNowDisabled}
        title={postNowTitle}
        aria-describedby={mergedContext ? mergedContextId : undefined}
        onClick={onPostNow}
        disabled={actionsLocked}
      >
        {posting ? 'Posting…' : 'Comment'}
      </button>
      {mergedContext && (
        <span id={mergedContextId} className="sr-only">
          {mergedContext}
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
