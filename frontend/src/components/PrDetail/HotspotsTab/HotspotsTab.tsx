import { useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import type { FileFocus } from '../../../api/types';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { splitRationale } from './splitRationale';
import { LevelGlyph } from './LevelGlyph';
import styles from './HotspotsTab.module.css';

// Collapses every non-alphanumeric run in a path to '-' so it is safe inside an
// id attribute. Module-scope so it compiles once, not per row per render.
const PANEL_ID_UNSAFE_CHARS = /[^a-z0-9]/gi;

// Rationale strings the parser assigns BY RULE (not model-authored). Kept in
// sync with the backend: FileFocusParser.BackfillRationale and the ranker's
// LowByRuleRationale. Used to (a) keep the path primary on backfilled rows and
// (b) exclude low-by-rule files from the Low count (#520 D7/D9). These are
// string-keyed: if either backend constant changes, update these too — a
// divergence silently regresses the count/headline (no type error to catch it).
const BACKFILL_RATIONALE = 'Not individually ranked.';
const LOW_BY_RULE_RATIONALE = 'No changes to review in this file.';

const byPath = (a: FileFocus, b: FileFocus) => a.path.localeCompare(b.path);

// The triage surface (#520): one container, severity-sorted High→Medium, each
// row identified by its signal-bars glyph and a synopsis headline derived from
// the rationale's first line. The expanded panel renders the rationale body as
// markdown via the shared MarkdownRenderer (never dangerouslySetInnerHTML). A
// "Diff" pill deep-links to the file via requestFileView. Low files are not
// listed — a muted footer counts them and hops to the Files tab.
export function HotspotsTab() {
  const { fileFocus, requestFileView, onSelectSubTab } = usePrDetailContext();
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
    return <div className={styles.message}>Couldn't rank this PR automatically.</div>;
  }
  if (status === 'error') {
    return (
      <div className={styles.messageError}>
        <span>Couldn't load AI focus right now.</span>{' '}
        <button type="button" className={styles.retryButton} onClick={retry}>
          Retry
        </button>
      </div>
    );
  }
  if (status === 'not-subscribed') {
    return <div className={styles.message}>AI file focus isn't active for this PR.</div>;
  }
  if (status === 'no-changes') {
    return <div className={styles.message}>No file changes to review.</div>;
  }

  const high = entries.filter((e) => e.level === 'high').sort(byPath);
  const medium = entries.filter((e) => e.level === 'medium').sort(byPath);
  // Exclude low-by-rule (empty-body renames/deletes) — they have no changed body
  // to skim, so they would inflate and mis-frame the count (#520 D7).
  const lowCount = entries.filter(
    (e) => e.level === 'low' && e.rationale !== LOW_BY_RULE_RATIONALE,
  ).length;

  if (status === 'empty' || (high.length === 0 && medium.length === 0)) {
    return (
      <div className={styles.messagePositive}>
        Nothing needs special attention — the AI didn't flag any file. Skim freely.
      </div>
    );
  }

  return (
    <div className={styles.hotspots}>
      <div className={styles.card}>
        {high.length > 0 && (
          <ul className={styles.rows} role="list">
            {high.map((r) => (
              <Row
                key={r.path}
                entry={r}
                isOpen={openPaths.has(r.path)}
                onToggle={toggle}
                onOpen={requestFileView}
              />
            ))}
          </ul>
        )}
        {medium.length > 0 && (
          <ul className={styles.rows} role="list">
            {medium.map((r) => (
              <Row
                key={r.path}
                entry={r}
                isOpen={openPaths.has(r.path)}
                onToggle={toggle}
                onOpen={requestFileView}
              />
            ))}
          </ul>
        )}
        {lowCount > 0 && (
          <button
            type="button"
            className={styles.lowFooter}
            aria-label={`${lowCount} low-priority ${lowCount === 1 ? 'file' : 'files'} — switch to the Files tab`}
            onClick={() => onSelectSubTab('files')}
          >
            <LevelGlyph level="low" />
            <span>
              {lowCount} low-priority {lowCount === 1 ? 'file' : 'files'} — skim them in the Files
              tab.
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

function Row({
  entry,
  isOpen,
  onToggle,
  onOpen,
}: {
  entry: FileFocus;
  isOpen: boolean;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  const isBackfill = entry.rationale === BACKFILL_RATIONALE;
  // Backfill rows carry a boilerplate sentence — keep the path as the headline
  // so the real identifier stays primary (#520 D9). They are never expandable, so
  // the split output goes unused for them; skip the call rather than discard it.
  const { headline, body } = isBackfill
    ? { headline: '', body: '' }
    : splitRationale(entry.rationale);
  const expandable = !isBackfill && body.length > 0;
  // Path-stable id (survives reorder/filter so aria-controls never mis-wires);
  // the parser's last-wins dedup guarantees a path appears at exactly one level.
  const panelId = `hotspot-panel-${entry.path.replace(PANEL_ID_UNSAFE_CHARS, '-')}`;

  const lead = (
    <>
      <LevelGlyph level={entry.level} />
      <span className="sr-only">{`AI focus: ${entry.level}`}</span>
      <span className={styles.stack}>
        {isBackfill ? (
          <span className={styles.headlinePath} title={entry.path}>
            {entry.path}
          </span>
        ) : (
          <>
            <span className={styles.headline}>{headline || entry.path}</span>
            <span className={styles.path} title={entry.path}>
              {entry.path}
            </span>
          </>
        )}
      </span>
    </>
  );

  return (
    <li className={styles.item}>
      <div className={styles.itemHeader}>
        {expandable ? (
          <button
            type="button"
            className={styles.rowToggle}
            aria-label={`Toggle ${entry.path} rationale`}
            aria-expanded={isOpen}
            aria-controls={panelId}
            onClick={() => onToggle(entry.path)}
          >
            {lead}
            <Chevron isOpen={isOpen} />
          </button>
        ) : (
          <div className={styles.rowStatic}>{lead}</div>
        )}
        <button
          type="button"
          className={styles.diffPill}
          aria-label={`Open ${entry.path} in diff`}
          onClick={() => onOpen(entry.path)}
        >
          <CodeIcon />
          Diff
        </button>
      </div>
      {expandable && isOpen && (
        <div id={panelId} className={styles.panel}>
          <MarkdownRenderer source={body} className="ai-markdown" />
        </div>
      )}
    </li>
  );
}

function Chevron({ isOpen }: { isOpen: boolean }) {
  return (
    <svg
      className={styles.chevron}
      data-open={isOpen}
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
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CodeIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}
