// Static "Ask AI — coming in v2" container (spec § 14.2). Appears below the PR
// header when the Ask AI button is clicked. Deliberately NOT an interactive
// chat surface — no input bar, no message bubbles, no "AI is typing" indicator
// — so the validation cohort doesn't read a disabled-but-realistic chat as
// "tool feels half-done". The seam is preserved structurally for v2's real
// IPrChatService.
interface Props {
  open: boolean;
  onClose(): void;
}

export function AskAiEmptyState({ open, onClose }: Props) {
  if (!open) return null;
  return (
    <section className="ask-ai-empty-state ai-tint" aria-label="Ask AI">
      <header className="ask-ai-empty-state__header">
        <h3 className="ask-ai-empty-state__title">Ask AI — coming in v2</h3>
        <button
          type="button"
          className="btn-icon ask-ai-empty-state__close"
          aria-label="Close"
          onClick={onClose}
        >
          ✕
        </button>
      </header>
      <p className="ask-ai-empty-state__body">
        v2 will let you ask questions about this PR&rsquo;s changes, with the assistant grounded in
        the diff and the conversation. The PoC ships the seam &mdash; the architectural slot &mdash;
        without the chat surface itself, to avoid setting up an interaction the tool can&rsquo;t
        deliver yet.
      </p>
    </section>
  );
}
