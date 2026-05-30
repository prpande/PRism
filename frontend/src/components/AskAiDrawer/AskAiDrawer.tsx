// frontend/src/components/AskAiDrawer/AskAiDrawer.tsx
import { useCallback, useEffect, useId, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { useAskAiDrawer } from '../../contexts/AskAiDrawerContext';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';
import { prRefKey } from '../../api/types';
import styles from './AskAiDrawer.module.css';

export function AskAiDrawer() {
  const { isOpen, close, getThread, setInput, sendMessage } = useAskAiDrawer();
  const { pathname } = useLocation();
  const titleId = useId();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  const prRef = parsePrRefFromPathname(pathname);
  const prKey = prRef ? prRefKey(prRef) : '';
  const thread = prKey ? getThread(prKey) : null;
  const inputValue = thread?.input ?? '';
  const canSubmit = !!thread && !thread.pendingAiReply && inputValue.trim().length > 0;

  const handleSubmit = useCallback(() => {
    if (!prKey || !canSubmit) return;
    sendMessage(prKey);
  }, [prKey, canSubmit, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [handleSubmit],
  );

  // Focus capture-on-open + restore-on-close. Composer is the initial focus target.
  useEffect(() => {
    if (isOpen) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      textareaRef.current?.focus();
      return () => {
        previouslyFocused.current?.focus();
      };
    }
  }, [isOpen]);

  // ESC closes (do NOT preventDefault — composer + browser ESC chains still flow).
  // Modal-coexistence guard: if any [aria-modal="true"] element is open, the modal
  // should consume ESC first — drawer ESC is suppressed for that keystroke. Mirrors
  // Cheatsheet.tsx's capture-phase guard at useCheatsheetShortcut.ts:53.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (document.querySelector('[aria-modal="true"]') !== null) return;
      close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, close]);

  const hasMessages = (thread?.messages.length ?? 0) > 0;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-hidden={!isOpen}
      inert={!isOpen}
      data-testid="ask-ai-drawer"
      className={`${styles.drawer} ${isOpen ? styles.isOpen : ''}`}
    >
      <div className={styles.head}>
        <span id={titleId} className={styles.headTitle}>
          <span className="ai-icon" aria-hidden="true">
            ✨
          </span>
          <span>
            Ask about this PR <span className={styles.headSubtitle}>· AI unavailable</span>
          </span>
        </span>
        <button type="button" className="btn-icon" aria-label="Close Ask AI drawer" onClick={close}>
          ✕
        </button>
      </div>
      <div className={styles.body}>
        {!hasMessages && !thread?.pendingAiReply && (
          <>
            <p className={styles.emptyHint}>Ask anything about this PR.</p>
            <span className={`kbd ${styles.emptyKbdHint}`}>⌘ ⏎ to send</span>
          </>
        )}
        {thread?.messages.map((m, i) =>
          m.role === 'user' ? (
            <div key={i} className={styles.msgUser}>
              {m.body}
            </div>
          ) : (
            <div key={i} className={styles.msgAi}>
              <span className="ai-icon" aria-hidden="true">
                ✨
              </span>
              <div className={styles.msgAiBody}>{m.body}</div>
            </div>
          ),
        )}
        {thread?.pendingAiReply && (
          <div className={styles.msgAi} data-testid="ai-typing-indicator">
            <span className="ai-icon" aria-hidden="true">
              ✨
            </span>
            <span className={styles.typing} aria-label="AI is responding">
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </span>
          </div>
        )}
      </div>
      <div className={styles.composer}>
        <textarea
          ref={textareaRef}
          className={`textarea ${styles.composerTextarea}`}
          placeholder="Ask about this PR…"
          rows={2}
          aria-label="Message"
          value={inputValue}
          onChange={(e) => prKey && setInput(prKey, e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSubmit}
          onClick={handleSubmit}
        >
          Send
        </button>
      </div>
    </aside>
  );
}
