// "Ask AI" header button (spec § 14.2 + PR8 § 4.8). Opens the AskAiDrawer via
// useAskAiDrawer().toggle(). Hidden unless aiPreview is on; no backend touchpoint.
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
