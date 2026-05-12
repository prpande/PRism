// "Ask AI" header button (spec § 14.2). The originally-planned interactive
// drawer was cut; the button + the static empty state (AskAiEmptyState)
// preserve the architectural seam without a fake-feeling chat surface. Hidden
// unless aiPreview is on; no backend touchpoint.
interface Props {
  aiPreview: boolean;
  onClick(): void;
}

export function AskAiButton({ aiPreview, onClick }: Props) {
  if (!aiPreview) return null;
  return (
    <button type="button" className="btn btn-secondary ask-ai-button" onClick={onClick}>
      Ask AI
    </button>
  );
}
