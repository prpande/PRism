import { useEffect, useId, useRef, useState, type PointerEvent, type ReactElement } from 'react';
import { createPortal } from 'react-dom';
import { Link, type Location } from 'react-router-dom';
import { InboxCaret } from '../Inbox/InboxCaret';
import { HelpIcon } from '../Header/HelpIcon';
import {
  InfoSparkIcon,
  RefreshIcon,
  LayoutIcon,
  KeyIcon,
  KeyboardIcon,
  ChatIcon,
} from './HelpSectionIcons';
import styles from './HelpModal.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface HelpModalProps {
  onClose: () => void;
  authed: boolean;
  // Spec §6: on close, focus returns to the opener. On a cold deep-link there is
  // no opener (body had focus), so focus moves to this background landmark
  // selector instead of being left on bare <body>.
  restoreFocusFallbackSelector?: string;
  // The effective page Help is open over (the opener's backgroundLocation, else a
  // synthetic). The "Settings → GitHub connection" link forwards this so opening
  // Settings from Help keeps the SAME page behind the scrim (e.g. a PR detail),
  // rather than always snapping to the Inbox.
  settingsBackground?: Location;
}

type SectionKey = 'what' | 'loop' | 'surfaces' | 'token' | 'shortcuts' | 'feedback';

interface Section {
  key: SectionKey;
  title: string;
  icon: ReactElement;
}

const SECTIONS: Section[] = [
  { key: 'what', title: 'What PRism is', icon: <InfoSparkIcon /> },
  { key: 'loop', title: 'The review loop', icon: <RefreshIcon /> },
  { key: 'surfaces', title: 'The main surfaces', icon: <LayoutIcon /> },
  { key: 'token', title: 'Connecting your token', icon: <KeyIcon /> },
  { key: 'shortcuts', title: 'Keyboard shortcuts', icon: <KeyboardIcon /> },
  { key: 'feedback', title: 'Send feedback', icon: <ChatIcon /> },
];

export function HelpModal({
  onClose,
  authed,
  restoreFocusFallbackSelector,
  settingsBackground,
}: HelpModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const scrimDownTarget = useRef<EventTarget | null>(null);
  const fallbackRef = useRef(restoreFocusFallbackSelector);
  fallbackRef.current = restoreFocusFallbackSelector;
  const titleId = useId();
  // Stable per-instance prefix for accordion body ids (mirrors titleId's useId so
  // two concurrent instances can't collide on a static literal).
  const bodyIdBase = useId();

  // First section open by default; the rest collapsed.
  const [openSections, setOpenSections] = useState<Set<SectionKey>>(new Set(['what']));

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const target = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
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

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
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
  }, [onClose]);

  const onScrimPointerDown = (e: PointerEvent) => {
    scrimDownTarget.current = e.target;
  };
  const onScrimPointerUp = (e: PointerEvent) => {
    if (e.target === e.currentTarget && scrimDownTarget.current === e.currentTarget) onClose();
    scrimDownTarget.current = null;
  };

  return createPortal(
    <div
      className={styles.scrim}
      data-testid="help-scrim"
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
        <header className={styles.head}>
          <span className={styles.titleIcon}>
            <HelpIcon />
          </span>
          <h2 id={titleId} className={styles.title}>
            Help
          </h2>
          <button type="button" className={styles.close} aria-label="Close help" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className={styles.body}>
          {SECTIONS.map((section) => {
            const open = openSections.has(section.key);
            const bodyId = `${bodyIdBase}-${section.key}`;
            return (
              <div key={section.key} className={styles.section}>
                <button
                  type="button"
                  className={styles.sectionHeader}
                  aria-expanded={open}
                  // Only reference the body while it's mounted — the region is
                  // conditionally rendered, and aria-controls pointing at an absent
                  // id fails axe's aria-valid-attr-value (cf. DiffSettingsMenu).
                  aria-controls={open ? bodyId : undefined}
                  onClick={() => toggleSection(section.key)}
                >
                  <span className={styles.sectionIcon}>{section.icon}</span>
                  <span className={styles.sectionTitle}>{section.title}</span>
                  <InboxCaret open={open} />
                </button>
                {open && (
                  <div
                    id={bodyId}
                    role="region"
                    aria-label={section.title}
                    className={styles.sectionBody}
                  >
                    <SectionContent
                      sectionKey={section.key}
                      authed={authed}
                      settingsBackground={settingsBackground}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SectionContent({
  sectionKey,
  authed,
  settingsBackground,
}: {
  sectionKey: SectionKey;
  authed: boolean;
  settingsBackground?: Location;
}) {
  switch (sectionKey) {
    case 'what':
      return (
        <>
          <p>
            PRism is a local-first workspace for reviewing pull requests without leaving your
            machine. It connects to GitHub with your personal access token and gives you a focused
            review workspace. Your token and PR data stay on this device.
          </p>
        </>
      );
    case 'loop':
      return (
        <>
          <p>
            To review a PR: open it from the <strong>Inbox</strong>, read the change in the PR
            detail view, leave comments on the <strong>Files</strong> tab, then use{' '}
            <strong>Submit</strong> to send your review back to GitHub.
          </p>
        </>
      );
    case 'surfaces':
      return (
        <>
          <p>
            The <strong>Inbox</strong> lists the PRs awaiting you. Opening one shows the PR detail
            with an <strong>Overview</strong> and a <strong>Files</strong> tab. The gear opens{' '}
            <strong>Settings</strong> (appearance, inbox, GitHub connection).
          </p>
        </>
      );
    case 'token':
      return (
        <>
          {authed ? (
            <p>
              When you need to connect or replace your GitHub token, open{' '}
              {/* Navigating to /settings/* unmounts this modal on its own (the
                  /help route stops matching), so no explicit onClose is needed —
                  and adding one would fire a second, racing navigation. Forward
                  the page Help was opened over so Settings keeps it behind the
                  scrim instead of snapping to the Inbox. */}
              <Link
                to="/settings/github-connection"
                state={{ backgroundLocation: settingsBackground ?? { pathname: '/' } }}
              >
                Settings → GitHub connection
              </Link>
              . PRism recommends a classic token; the connect screen explains which token type you
              need.
            </p>
          ) : (
            <p>
              To connect your GitHub token, use the <Link to="/setup">Get started</Link> flow. PRism
              recommends a classic token; the connect screen explains which token type you need.
            </p>
          )}
        </>
      );
    case 'shortcuts':
      return (
        <>
          <p>
            Press <kbd>?</kbd> (outside a text field) or <kbd>⌘/</kbd> (or <kbd>Ctrl+/</kbd>){' '}
            anywhere to open the keyboard-shortcut cheatsheet.
          </p>
        </>
      );
    case 'feedback':
      return (
        <>
          <p>Found a bug or have an idea? (Coming soon.)</p>
        </>
      );
  }
}
