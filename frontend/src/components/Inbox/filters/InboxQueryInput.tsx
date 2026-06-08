import { useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inboxApi } from '../../../api/inbox';
import { useOpenTabs } from '../../../contexts/OpenTabsContext';
import { looksLikePrUrl, looksLikeUrl } from './applyInboxFilters';
import styles from './filters.module.css';

interface Props {
  value: string;
  onChange(value: string): void;
}

// The merged inbox input: one field that filters the inbox as you type AND opens a
// PR when you paste / Enter a PR URL. Type → live filter (handled upstream by
// useInboxFilters deriving the effective text). Paste or Enter a URL-shaped value →
// parse server-side and navigate. The URL value never filters the inbox (the hook
// strips it), so there's no zero-state flash while a URL sits in the box.
export function InboxQueryInput({ value, onChange }: Props) {
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const { addTab } = useOpenTabs();
  const errorId = useId();
  // Set to true by onPaste; cleared when onChange consumes it — so a pasted URL's
  // error pill survives the change event that React fires right after the paste.
  const pasteInProgress = useRef(false);
  // In-flight guard: a single open() at a time. A second open trigger (a fast
  // double-Enter, or Enter landing on a paste already opening) is ignored so we
  // never double addTab / double navigate.
  const submitting = useRef(false);
  // Staleness guard: the value the user is currently looking at, kept in a ref so an
  // in-flight open() reads the latest after its await. If the user abandons the open
  // (clears the box, or edits it into something that's no longer a PR URL) before the
  // parse resolves, we drop the now-stale success instead of navigating away from a
  // different intent. We deliberately do NOT require byte-exact equality: a pasted
  // URL legitimately settles via two events, so we test "still a PR URL", not "==".
  const currentValue = useRef(value);
  currentValue.current = value;
  const isStaleOpen = (submitted: string) => {
    const now = currentValue.current.trim();
    return now === '' || (now !== submitted && !looksLikePrUrl(now));
  };

  const isPrUrl = looksLikePrUrl(value);
  const isNonPrUrl = looksLikeUrl(value) && !isPrUrl;

  const open = async (raw: string) => {
    setError(null);
    const trimmed = raw.trim();
    if (!trimmed) return;
    // Drop a re-entrant open while one is already in flight (e.g. double-Enter).
    if (submitting.current) return;
    submitting.current = true;
    try {
      const resp = await inboxApi.parsePrUrl(trimmed);
      // Drop a stale result the user has moved on from (cleared / typed a term).
      if (isStaleOpen(trimmed)) return;
      if (resp.ok && resp.ref) {
        // Title is null at paste time — PrDetailPage fills it in via setTitle once
        // usePrDetail resolves.
        addTab(resp.ref, null);
        navigate(`/pr/${resp.ref.owner}/${resp.ref.repo}/${resp.ref.number}`);
        onChange('');
        return;
      }
      switch (resp.error) {
        case 'host-mismatch':
          setError(
            `This PR is on ${resp.urlHost}, but PRism is configured for ${resp.configuredHost}.`,
          );
          break;
        case 'not-a-pr-url':
          setError("That doesn't look like a PR link.");
          break;
        default:
          setError("Couldn't parse that URL.");
      }
    } catch {
      // Network failure — only surface if the user hasn't moved on from this value.
      if (!isStaleOpen(trimmed)) {
        setError("Couldn't reach the server. Try again.");
      }
    } finally {
      submitting.current = false;
    }
  };

  return (
    <div className={styles.search}>
      {/* Monochrome accent line-icon (matches HelpIcon/welcomeIcons convention,
          replacing the multicolour 🔍 emoji). Colour comes from .searchIcon.
          The glyph tracks the input's mode: a magnifier while filtering, the
          git-pull-request symbol once the value is a PR URL (signalling "this is
          a PR to open" — paired with the "↵ Open PR" affordance on the right).
          Stroke weight matches the magnifier (1.8/24 ≈ 1.2/16). */}
      {isPrUrl ? (
        <svg
          className={styles.searchIcon}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          aria-hidden="true"
          focusable="false"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="6" cy="6" r="3" />
          <circle cx="18" cy="18" r="3" />
          <path d="M13 6h3a2 2 0 0 1 2 2v7" />
          <line x1="6" y1="9" x2="6" y2="21" />
        </svg>
      ) : (
        <svg
          className={styles.searchIcon}
          width="14"
          height="14"
          viewBox="0 0 16 16"
          aria-hidden="true"
          focusable="false"
          fill="none"
        >
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
          <line
            x1="10.6"
            y1="10.6"
            x2="14"
            y2="14"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
          />
        </svg>
      )}
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Filter inbox, or paste a PR URL to open…"
        aria-label="Filter inbox, or paste a PR URL to open"
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          if (pasteInProgress.current) {
            pasteInProgress.current = false; // consume the flag; do NOT clear error
          } else {
            setError(null);
          }
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          // Only auto-open a pasted PR URL; a pasted filter term just fills the box.
          if (looksLikePrUrl(pasted)) {
            pasteInProgress.current = true;
            onChange(pasted);
            void open(pasted);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            onChange('');
            setError(null);
            return;
          }
          // Enter only acts when the value is a PR URL — otherwise the inbox is
          // already filtering live, so there's nothing to submit.
          if (e.key === 'Enter' && looksLikePrUrl(value)) void open(value);
        }}
      />
      {isPrUrl && (
        <>
          {/* Visible hint is decorative; AT gets the sr-only cue below. */}
          <span className={styles.openHint} aria-hidden="true">
            ↵ Open PR
          </span>
          <span className="sr-only">Press Enter to open this PR.</span>
        </>
      )}
      {isNonPrUrl && (
        <span className={`${styles.openHint} ${styles.openHintMuted}`}>Not a PR link</span>
      )}
      {value && (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="Clear"
          onClick={() => {
            onChange('');
            setError(null);
          }}
        >
          ✕
        </button>
      )}
      {error && (
        <span id={errorId} className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
