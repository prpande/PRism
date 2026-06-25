// frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx
import { usePrDetailContext } from '../prDetailContext';
import { FAILING_CONCLUSIONS } from '../checksGlyphState';
import type { CheckRun } from '../../../api/types';
import type { CheckRunsResult } from '../../../hooks/useCheckRuns';
import styles from './ChecksTab.module.css';

const TIER_FAILING = 0;
const TIER_ACTION_REQUIRED = 1;
const TIER_IN_PROGRESS = 2;
const TIER_NEUTRAL = 3;
const TIER_PASSING = 4;

function tierOf(c: CheckRun): number {
  if (c.status === 'queued' || c.status === 'in-progress') return TIER_IN_PROGRESS;
  if (c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion)) return TIER_FAILING;
  if (c.conclusion === 'action-required') return TIER_ACTION_REQUIRED;
  if (c.conclusion === 'success') return TIER_PASSING;
  return TIER_NEUTRAL; // skipped / neutral / stale / startup-failure / null
}

function sortChecks(checks: CheckRun[]): CheckRun[] {
  return [...checks].sort((a, b) => tierOf(a) - tierOf(b) || a.name.localeCompare(b.name));
}

type RowGlyph = 'cross' | 'alert' | 'spinner' | 'dash' | 'check';

function glyphFor(c: CheckRun): RowGlyph {
  if (c.status === 'queued' || c.status === 'in-progress') return 'spinner';
  if (c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion)) return 'cross';
  if (c.conclusion === 'action-required') return 'alert';
  if (c.conclusion === 'success') return 'check';
  return 'dash';
}

function formatDuration(c: CheckRun, now: number): string | null {
  if (c.source === 'status' || c.startedAt == null) return null;
  const start = Date.parse(c.startedAt);
  const end = c.completedAt != null ? Date.parse(c.completedAt) : now;
  const secs = Math.max(0, Math.round((end - start) / 1000));
  if (secs < 1) return '<1s';
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

// SR announcement per status -- mirrors HotspotsTab's persistent role="status" announcer
// so async loading->ok/empty/error transitions are spoken (design R2).
function announce(state: CheckRunsResult): string {
  switch (state.status) {
    case 'idle':
    case 'loading':
      return 'Loading checks...';
    case 'empty':
      return 'No checks found for this commit';
    case 'error':
      return state.degraded === 'auth'
        ? "Couldn't load checks -- the token may lack access"
        : "Couldn't load checks";
    case 'ok': {
      const failing = state.checks.filter(
        (c) => c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion),
      ).length;
      return failing > 0
        ? `${failing} ${failing === 1 ? 'check' : 'checks'} failing`
        : 'All checks passing';
    }
    default:
      return '';
  }
}

export function ChecksTab() {
  const { checks: state } = usePrDetailContext();
  const { status, degraded } = state;
  const now = Date.now(); // single read per render; no per-second ticker (updates each 15s poll)

  const body = (() => {
    if (status === 'idle' || (status === 'loading' && state.checks.length === 0)) {
      return <SkeletonRows />;
    }
    if (status === 'empty') {
      return <p className={styles.message}>No checks for this commit.</p>;
    }
    if (status === 'error') {
      // role="alert" so the async error transition is announced (design R2) -- matches
      // DraftsTabError / FilesTab error states.
      return (
        <div className={styles.message} role="alert">
          <p>
            {degraded === 'auth'
              ? "Couldn't load checks -- the current token may lack access (a classic `repo` token is required for the Checks API)."
              : "Couldn't load checks."}
          </p>
          <button type="button" className={styles.retry} onClick={state.retry}>
            Retry
          </button>
        </div>
      );
    }

    const rows = sortChecks(state.checks);
    return (
      <div className={styles.checks}>
        {degraded !== 'none' && (
          <div className={styles.degradedBanner} role="status">
            {degraded === 'auth'
              ? "PRism couldn't read some checks -- the current token may lack access (a classic `repo` token is required for the Checks API)."
              : "Some checks couldn't be loaded -- retry."}
          </div>
        )}
        <ul className={styles.rows} role="list">
          {rows.map((c) => {
            const duration = formatDuration(c, now);
            return (
              <li key={`${c.source}:${c.name}`} className={styles.row}>
                <RowGlyphIcon glyph={glyphFor(c)} />
                <span className={styles.name} data-testid="check-name" title={c.name}>
                  {c.name}
                </span>
                {duration != null && (
                  <span className={styles.duration} data-testid="check-duration">
                    {duration}
                  </span>
                )}
                {c.detailsUrl != null && (
                  <a
                    className={styles.details}
                    href={c.detailsUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Details &#x2197;
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    );
  })();

  return (
    <>
      <span role="status" className="sr-only">
        {announce(state)}
      </span>
      {body}
    </>
  );
}

function SkeletonRows() {
  return (
    <ul className={styles.rows} role="list" aria-busy="true">
      {[0, 1, 2].map((i) => (
        <li key={i} className={`${styles.row} ${styles.skeleton}`} />
      ))}
    </ul>
  );
}

// Octicon paths -- check/cross/dot are the SAME paths InboxRow.tsx uses (CI_GLYPH_PATH),
// so the Checks rows speak the exact inbox CI vocabulary the user asked us to follow.
// alert (check-run action-required) + dash (skipped/neutral) are small new octicons.
const GLYPH_PATH: Record<RowGlyph, string> = {
  // octicon check-16 (InboxRow CI_GLYPH_PATH.passing)
  check:
    'M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z',
  // octicon x-16 (InboxRow CI_GLYPH_PATH.failing)
  cross:
    'M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L9.06 8l3.22 3.22a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215L8 9.06l-3.22 3.22a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z',
  // octicon dot-fill-16 (InboxRow CI_GLYPH_PATH.pending) -- in-progress
  spinner: 'M8 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z',
  // octicon alert-16 -- action-required manual gate
  alert:
    'M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z',
  // octicon dash-16 -- skipped / neutral / stale
  dash: 'M2 7.75A.75.75 0 0 1 2.75 7h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 7.75Z',
};

function RowGlyphIcon({ glyph }: { glyph: RowGlyph }) {
  const cls =
    glyph === 'cross'
      ? styles.glyphFail
      : glyph === 'alert'
        ? styles.glyphAlert
        : glyph === 'spinner'
          ? styles.glyphPending
          : glyph === 'check'
            ? styles.glyphPass
            : styles.glyphNeutral;
  return (
    <svg
      className={`${styles.glyph} ${cls}`}
      data-glyph={glyph}
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
    >
      <path d={GLYPH_PATH[glyph]} />
    </svg>
  );
}
