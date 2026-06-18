import { useState, type ReactNode } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import type { FileFocus } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { stripMarkdown } from './stripMarkdown';
import styles from './HotspotsTab.module.css';

// The triage surface (spec §8 / #488): filtered High→Medium as a multi-open,
// default-collapsed accordion. The collapsed row shows path + level dot + a
// one-line stripped preview; the expanded panel renders the full rationale as
// markdown via the shared MarkdownRenderer (never dangerouslySetInnerHTML). A
// dedicated icon button deep-links to the file diff via requestFileView.
export function HotspotsTab() {
  const { fileFocus, requestFileView } = usePrDetailContext();
  const { status, entries, retry } = fileFocus;
  const [openPaths, setOpenPaths] = useState<Set<string>>(new Set());

  const toggle = (path: string) =>
    setOpenPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

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
        Nothing needs special attention — the AI didn't flag any file. Skim freely.
      </Message>
    );
  }

  return (
    <div className={styles.hotspots}>
      {high.length > 0 && (
        <Group
          label="High"
          rows={high}
          openPaths={openPaths}
          onToggle={toggle}
          onOpen={requestFileView}
        />
      )}
      {medium.length > 0 && (
        <Group
          label="Medium"
          rows={medium}
          openPaths={openPaths}
          onToggle={toggle}
          onOpen={requestFileView}
        />
      )}
    </div>
  );
}

function Group({
  label,
  rows,
  openPaths,
  onToggle,
  onOpen,
}: {
  label: string;
  rows: FileFocus[];
  openPaths: Set<string>;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  return (
    <section className={styles.group} aria-labelledby={`hotspot-group-${label}`}>
      <h3 id={`hotspot-group-${label}`} className={styles.groupHeading}>
        {label}
      </h3>
      <ul className={styles.rows} role="list">
        {rows.map((r) => {
          const isOpen = openPaths.has(r.path);
          // Path-stable (not index-based): survives reorder/filter so aria-controls
          // never mis-wires; the label prefix disambiguates the same path appearing
          // in both High and Medium. Consistent with key={r.path} below.
          const panelId = `hotspot-panel-${label}-${r.path.replace(/[^a-z0-9]/gi, '-')}`;
          return (
            <li key={r.path} className={styles.item}>
              <div className={styles.itemHeader}>
                <button
                  type="button"
                  className={styles.rowToggle}
                  aria-label={`Toggle ${r.path} rationale`}
                  aria-expanded={isOpen}
                  aria-controls={panelId}
                  onClick={() => onToggle(r.path)}
                >
                  <span
                    className={`${styles.dot} ${r.level === 'high' ? styles.dotHigh : styles.dotMed}`}
                    aria-hidden="true"
                  />
                  <span className={styles.rowPath} title={r.path}>
                    {r.path}
                  </span>
                  {!isOpen && (
                    <span className={styles.rowPreview}>{stripMarkdown(r.rationale)}</span>
                  )}
                  <Icon className={styles.chevron} dataOpen={isOpen} d="M6 9l6 6 6-6" />
                </button>
                <button
                  type="button"
                  className={styles.openInDiff}
                  aria-label={`Open ${r.path} in diff`}
                  onClick={() => onOpen(r.path)}
                >
                  <Icon d="M9 18l6-6-6-6" />
                </button>
              </div>
              {isOpen && (
                <div id={panelId} className={styles.panel}>
                  <MarkdownRenderer source={r.rationale} className="ai-markdown" />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Message({ children, className }: { children: ReactNode; className: string }) {
  return <div className={className}>{children}</div>;
}

// Both row affordances are 14px line-icons differing only in the path data: the
// disclosure chevron (rotated in CSS via the data-open attribute) and the
// open-in-diff arrow. dataOpen is omitted for the arrow, so React drops the
// attribute and only the chevron carries it.
function Icon({ d, className, dataOpen }: { d: string; className?: string; dataOpen?: boolean }) {
  return (
    <svg
      className={className}
      data-open={dataOpen}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
