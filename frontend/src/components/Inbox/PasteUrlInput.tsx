import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { inboxApi } from '../../api/inbox';
import styles from './PasteUrlInput.module.css';

export function PasteUrlInput() {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  // Set to true by onPaste; cleared when onChange consumes it.
  const pasteInProgress = useRef(false);

  const submit = async (raw: string) => {
    setError(null);
    if (!raw.trim()) return;
    try {
      const resp = await inboxApi.parsePrUrl(raw.trim());
      if (resp.ok && resp.ref) {
        navigate(`/pr/${resp.ref.owner}/${resp.ref.repo}/${resp.ref.number}`);
        setValue('');
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
    <div className={styles.wrap}>
      <input
        className={styles.input}
        type="text"
        placeholder="Paste a PR URL to open it…"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          if (pasteInProgress.current) {
            pasteInProgress.current = false; // consume the flag; do NOT clear error
          } else {
            setError(null);
          }
        }}
        onPaste={(e) => {
          pasteInProgress.current = true;
          const pasted = e.clipboardData.getData('text');
          setValue(pasted);
          void submit(pasted);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit(value);
        }}
      />
      {error && (
        <span className={styles.error} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
