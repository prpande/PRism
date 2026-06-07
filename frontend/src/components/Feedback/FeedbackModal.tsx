import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { SegmentedControl } from '../controls/SegmentedControl';
import { submitFeedback, type FeedbackRequest } from '../../api/feedback';
import { buildFeedbackIssueUrl } from '../../feedback/feedbackRepo';
import styles from './FeedbackModal.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Category = 'Bug' | 'Idea' | 'Other';
type ModalState =
  | { kind: 'idle' }
  | { kind: 'in-flight' }
  | { kind: 'success'; issueNumber: number; htmlUrl: string }
  | { kind: 'offer-link' }
  | { kind: 'opened' }
  | { kind: 'error' };

const CATEGORIES: ReadonlyArray<{ value: Category; label: string }> = [
  { value: 'Bug', label: 'Bug' },
  { value: 'Idea', label: 'Idea' },
  { value: 'Other', label: 'Other' },
];

export interface FeedbackModalProps {
  onClose: () => void;
  authed: boolean;
  /** authState.host — gates API vs link-only */
  host: string;
  /** The page Help/feedback was opened over (context, not /feedback) */
  routePattern: string;
  restoreFocusFallbackSelector?: string;
}

// Detect Electron bridge — injected by the preload script as window.prism.
function isDesktop(): boolean {
  return (
    typeof (window as unknown as { prism?: { openExternal?: unknown } }).prism?.openExternal ===
    'function'
  );
}

async function openExternal(url: string): Promise<void> {
  if (new URL(url).protocol !== 'https:') throw new Error('refusing non-https url');
  const bridge = (
    window as unknown as { prism?: { openExternal?: (u: string) => Promise<boolean> } }
  ).prism;
  if (typeof bridge?.openExternal === 'function') {
    const ok = await bridge.openExternal(url);
    if (!ok) throw new Error('openExternal rejected the url');
    return;
  }
  window.open(url, '_blank', 'noreferrer');
}

export function FeedbackModal({
  onClose,
  authed,
  host,
  routePattern,
  restoreFocusFallbackSelector,
}: FeedbackModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const scrimDownTarget = useRef<EventTarget | null>(null);
  const fallbackRef = useRef(restoreFocusFallbackSelector);
  fallbackRef.current = restoreFocusFallbackSelector;
  const titleId = useId();
  const liveRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  const [category, setCategory] = useState<Category>('Bug');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [modalState, setModalState] = useState<ModalState>({ kind: 'idle' });

  // Normalize the host: API path only for github.com.
  // Exact-string matching would wrongly classify 'https://github.com/' or
  // 'https://GitHub.com' as GHES, forcing link-only.
  const isGitHubCom = (() => {
    try {
      const u = new URL(host);
      return u.protocol === 'https:' && u.hostname.toLowerCase() === 'github.com';
    } catch {
      return false;
    }
  })();
  const linkOnly = !authed || !isGitHubCom;
  const dirty = Boolean(summary || details);
  const canSubmit =
    Boolean(category && summary.trim() && details.trim()) && modalState.kind === 'idle';
  const submitLabel = linkOnly ? 'Open on GitHub' : 'Send feedback';

  const prefilledUrl = () =>
    buildFeedbackIssueUrl({
      title: `[${category}] ${summary.trim()}`,
      details: details.trim(),
      context: `route: ${routePattern}\nplatform: ${isDesktop() ? 'desktop' : 'browser'}`,
    });

  async function handleOpenExternal(url: string) {
    try {
      await openExternal(url);
    } catch {
      setModalState({ kind: 'error' });
    }
  }

  async function goToLink() {
    try {
      await openExternal(prefilledUrl());
      setModalState({ kind: 'opened' });
    } catch {
      setModalState({ kind: 'error' });
    }
  }

  async function onSubmit() {
    if (modalState.kind === 'in-flight') return;
    if (linkOnly) {
      return goToLink();
    }
    if (liveRef.current) liveRef.current.textContent = 'Sending your feedback…';
    setModalState({ kind: 'in-flight' });
    try {
      const req: FeedbackRequest = {
        category,
        summary: summary.trim(),
        details: details.trim(),
        routePattern,
        platform: isDesktop() ? 'desktop' : 'browser',
      };
      const res = await submitFeedback(req);
      if (res.outcome === 'created') {
        setModalState({ kind: 'success', issueNumber: res.issueNumber, htmlUrl: res.htmlUrl });
      } else {
        setModalState({ kind: 'offer-link' });
      }
    } catch {
      setModalState({ kind: 'error' });
    }
  }

  // ── Capture focus on mount; restore on unmount ──
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    // Initial focus: first category radio (form-dialog APG convention).
    // Fall back to the first focusable element in the dialog.
    const firstRadio = dialog?.querySelector<HTMLElement>('[role="radio"]');
    const firstFocusable = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (firstRadio ?? firstFocusable)?.focus();
    return () => {
      // Trigger-opened → restore to the opener. Cold deep-link (body had focus)
      // → move to the background landmark, never bare <body>.
      const opener = previouslyFocused.current;
      if (opener && opener !== document.body) opener.focus();
      else if (fallbackRef.current)
        document.querySelector<HTMLElement>(fallbackRef.current)?.focus();
    };
    // Run once on mount/unmount; the fallback selector is read via fallbackRef so
    // the empty dep array is intentional. (No exhaustive-deps suppression: the
    // react-hooks plugin is not wired into this project's flat eslint config, and
    // a stale disable directive for it errors as "rule not found".)
  }, []);

  // ── Move focus to the primary action after leaving idle/in-flight ──
  // Scoped to THIS dialog's root so a second mounted dialog can't win the match.
  useEffect(() => {
    if (modalState.kind === 'idle' || modalState.kind === 'in-flight') return;
    dialogRef.current
      ?.querySelector<HTMLElement>('[data-modal-role="primary"], [data-feedback-close]')
      ?.focus();
  }, [modalState.kind]);

  // ── Esc + Tab focus trap ──
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        // In-flight: suppress Esc entirely — closing mid-submit is not allowed (spec §5 state-2).
        if (modalState.kind === 'in-flight') return;
        // Dirty guard: when form has unsaved input, Esc must NOT close;
        // focus Cancel and announce.
        if (dirty) {
          cancelRef.current?.focus();
          if (liveRef.current)
            liveRef.current.textContent = 'Press Cancel to discard, or keep editing.';
          return;
        }
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose, dirty, modalState.kind]);

  const onScrimPointerDown = (e: PointerEvent) => {
    scrimDownTarget.current = e.target;
  };
  const onScrimPointerUp = (e: PointerEvent) => {
    if (e.target === e.currentTarget && scrimDownTarget.current === e.currentTarget) onClose();
    scrimDownTarget.current = null;
  };

  const modalTitle =
    modalState.kind === 'success'
      ? 'Feedback sent'
      : modalState.kind === 'offer-link' || modalState.kind === 'opened'
        ? 'Open on GitHub'
        : 'Send feedback';

  return createPortal(
    <div
      className={styles.scrim}
      data-testid="feedback-scrim"
      onPointerDown={onScrimPointerDown}
      onPointerUp={onScrimPointerUp}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.modal}
      >
        {/* Polite live region for in-flight announcements and dirty-Esc notice */}
        <div ref={liveRef} className={styles.srOnly} role="status" aria-live="polite" />

        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            {modalTitle}
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close feedback"
            onClick={onClose}
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          {modalState.kind === 'success' ? (
            <div className={styles.stateBody}>
              <p className={styles.stateText}>Filed as #{modalState.issueNumber}.</p>
              {modalState.htmlUrl && (
                <div className={styles.footer}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    data-modal-role="primary"
                    onClick={() => void handleOpenExternal(modalState.htmlUrl)}
                  >
                    Open in GitHub
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    data-feedback-close=""
                    onClick={onClose}
                  >
                    Close
                  </button>
                </div>
              )}
              {!modalState.htmlUrl && (
                <div className={styles.footer}>
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-modal-role="primary"
                    data-feedback-close=""
                    onClick={onClose}
                  >
                    Close
                  </button>
                </div>
              )}
            </div>
          ) : modalState.kind === 'offer-link' || modalState.kind === 'opened' ? (
            <div className={styles.stateBody}>
              <p className={styles.stateText}>
                {modalState.kind === 'opened'
                  ? 'A prefilled issue page was opened. Submit it there, then return here.'
                  : "Couldn't file it directly. Open a prefilled issue on GitHub instead?"}
              </p>
              <div className={styles.footer}>
                {modalState.kind === 'offer-link' && (
                  <button
                    type="button"
                    className="btn btn-primary"
                    data-modal-role="primary"
                    onClick={() => void goToLink()}
                  >
                    Open on GitHub
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-ghost"
                  data-feedback-close=""
                  onClick={onClose}
                >
                  Close
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.form}>
              <SegmentedControl
                label="Feedback category"
                options={CATEGORIES}
                value={category}
                onChange={setCategory}
                disabled={modalState.kind === 'in-flight'}
              />
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fb-summary">
                  Summary
                </label>
                <input
                  id="fb-summary"
                  className={styles.input}
                  maxLength={120}
                  value={summary}
                  disabled={modalState.kind === 'in-flight'}
                  onChange={(e) => setSummary(e.target.value)}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.label} htmlFor="fb-details">
                  Details
                </label>
                <textarea
                  id="fb-details"
                  className={styles.textarea}
                  maxLength={4000}
                  placeholder="What happened, and what did you expect? Describe the steps — please don't paste raw logs."
                  value={details}
                  disabled={modalState.kind === 'in-flight'}
                  onChange={(e) => setDetails(e.target.value)}
                />
              </div>
              <p className={styles.notice}>
                Posted as a public GitHub issue under your account — don&apos;t include tokens,
                secrets, or sensitive details (internal project names, PR content).
              </p>
              {modalState.kind === 'error' && (
                <p className={styles.errorText} role="alert">
                  Couldn&apos;t send your feedback. Try again, or open a prefilled issue on GitHub.
                </p>
              )}
              <div className={styles.footer}>
                {modalState.kind === 'error' ? (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-modal-role="primary"
                      disabled={modalState.kind === 'in-flight'}
                      onClick={() => void onSubmit()}
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => void goToLink()}
                    >
                      Open on GitHub instead
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      className="btn btn-ghost"
                      onClick={onClose}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn btn-primary"
                      data-modal-role="primary"
                      disabled={!canSubmit}
                      onClick={() => void onSubmit()}
                    >
                      {modalState.kind === 'in-flight' ? 'Sending…' : submitLabel}
                    </button>
                    <button
                      ref={cancelRef}
                      type="button"
                      className="btn btn-ghost"
                      disabled={modalState.kind === 'in-flight'}
                      onClick={onClose}
                    >
                      Cancel
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
