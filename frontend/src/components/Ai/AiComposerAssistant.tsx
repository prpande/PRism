import { useCapabilities } from '../../hooks/useCapabilities';
import { usePreferences } from '../../hooks/usePreferences';

// AI placeholder slot per spec § 5.8 / addendum A1. Self-gates on
// capabilities.composerAssist + preferences.aiPreview, mirroring S3's
// OverviewTab pattern (the actual hook surface in S0+S1 is `useCapabilities()`
// returning the whole record, not the per-flag `useCapability(flag)` the
// addendum text anticipated — see deferrals doc).
//
// Mounted next to the Save button inside InlineCommentComposer (Task 39),
// ReplyComposer (Task 40, PR5), and PrRootReplyComposer (Task 42, PR5).
// Returns null in PoC default (composerAssist=false). Real AI in v2 swaps
// the placeholder for a generated suggestion stream.
export function AiComposerAssistant() {
  const { capabilities } = useCapabilities();
  const { preferences } = usePreferences();
  const on = !!capabilities?.composerAssist && !!preferences?.aiPreview;
  if (!on) return null;
  return (
    <div
      className="ai-composer-assistant ai-tint"
      role="note"
      aria-label="AI composer suggestions (preview)"
    >
      <span className="ai-summary-chip muted">AI preview — composer suggestions appear here</span>
    </div>
  );
}
