import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inboxApi } from '../../../api/inbox';
import { useOpenTabs } from '../../../contexts/OpenTabsContext';
import { looksLikePrUrl } from './applyInboxFilters';
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
  // Set to true by onPaste; cleared when onChange consumes it — so a pasted URL's
  // error pill survives the change event that React fires right after the paste.
  const pasteInProgress = useRef(false);

  const isUrl = looksLikePrUrl(value);

  const open = async (raw: string) => {
    setError(null);
    if (!raw.trim()) return;
    try {
      const resp = await inboxApi.parsePrUrl(raw.trim());
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
      setError("Couldn't reach the server. Try again.");
    }
  };

  return (
    <div className={styles.search}>
      {/* Monochrome accent line-icon (matches HelpIcon/welcomeIcons convention,
          replacing the multicolour 🔍 emoji). Colour comes from .searchIcon. */}
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
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Filter inbox, or paste a PR URL to open…"
        aria-label="Filter inbox, or paste a PR URL to open"
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
      {isUrl && value && (
        <span className={styles.openHint} aria-hidden="true">
          ↵ Open PR
        </span>
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
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
