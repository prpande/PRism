import type { ReactNode } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import type { FileFocus } from '../../../api/types';
import styles from './HotspotsTab.module.css';

// The triage surface (spec §8): filtered High→Medium with inline rationale and a
// click-through deep-link to the file's diff (via requestFileView, owned by
// PrDetailView). Renders the seven file-focus states; the rationale is LLM free
// text and is ALWAYS a plain text node — never dangerouslySetInnerHTML.
export function HotspotsTab() {
  const { fileFocus, requestFileView } = usePrDetailContext();
  const { status, entries, retry } = fileFocus;

  if (status === 'loading') {
    return (
      <div className={styles.hotspots} data-testid="hotspots-skeleton">
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
        <div className={styles.skeletonRow} />
      </div>
    );
  }
  if (status === 'fallback') {
    return <Message className={styles.message}>Couldn’t rank this PR automatically.</Message>;
  }
  if (status === 'error') {
    return (
      <div className={styles.messageError}>
        <span>Couldn’t load AI focus right now.</span>{' '}
        <button type="button" className={styles.retryButton} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (status === 'not-subscribed') {
    return <Message className={styles.message}>AI file focus isn’t active for this PR.</Message>;
  }
  if (status === 'no-changes') {
    return <Message className={styles.message}>No file changes to review.</Message>;
  }

  const high = entries.filter((e) => e.level === 'high');
  const medium = entries.filter((e) => e.level === 'medium');

  if (status === 'empty' || (high.length === 0 && medium.length === 0)) {
    return (
      <Message className={styles.messagePositive}>
        Nothing needs special attention — the AI didn’t flag any file. Skim freely.
      </Message>
    );
  }

  return (
    <div className={styles.hotspots}>
      {high.length > 0 && <Group label="High" rows={high} onOpen={requestFileView} />}
      {medium.length > 0 && <Group label="Medium" rows={medium} onOpen={requestFileView} />}
    </div>
  );
}

function Group({
  label,
  rows,
  onOpen,
}: {
  label: string;
  rows: FileFocus[];
  onOpen: (path: string) => void;
}) {
  return (
    <section className={styles.group}>
      <h3 className={styles.groupHeading}>{label}</h3>
      <ul className={styles.rows} role="list">
        {rows.map((r) => (
          <li key={r.path} role="listitem">
            <button
              type="button"
              className={styles.row}
              onClick={() => onOpen(r.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpen(r.path);
                }
              }}
            >
              <span className={styles.rowPath} title={r.path}>
                {r.path}
              </span>
              {/* rationale is LLM free text — plain text node only (XSS); title carries the full string */}
              <span className={styles.rowRationale} title={r.rationale}>
                {r.rationale}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Message({ children, className }: { children: ReactNode; className: string }) {
  return <div className={className}>{children}</div>;
}
