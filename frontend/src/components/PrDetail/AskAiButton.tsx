// "Ask AI" header button (spec § 14.2 + PR8 § 4.8). Opens the AskAiDrawer via
// useAskAiDrawer().toggle(). Hidden unless useAiGate('composerAssist') is true.
// Tightens the gating to match AiComposerAssistant; today the change is a
// no-op because capabilities derive from ui.aiMode (D112). PR9b § 4.2.
import { useAiGate } from '../../hooks/useAiGate';

interface Props {
  onClick: () => void;
}

export function AskAiButton({ onClick }: Props) {
  const enabled = useAiGate('composerAssist');
  if (!enabled) return null;
  return (
    <button type="button" className="btn btn-secondary ask-ai-button" onClick={onClick}>
      Ask AI
    </button>
  );
}
