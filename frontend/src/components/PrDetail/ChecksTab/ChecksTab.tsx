// frontend/src/components/PrDetail/ChecksTab/ChecksTab.tsx
import { useEffect, useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import { FAILING_CONCLUSIONS } from '../checksGlyphState';
import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import { rerunCheck } from '../../../api/checks';
import type { CheckRun, RerunOutcome } from '../../../api/types';
import type { CheckRunsResult } from '../../../hooks/useCheckRuns';
import styles from './ChecksTab.module.css';

const TIER_FAILING = 0;
const TIER_ACTION_REQUIRED = 1;
const TIER_IN_PROGRESS = 2;
const TIER_NEUTRAL = 3;
const TIER_PASSING = 4;

function isFailing(c: CheckRun): boolean {
  return c.conclusion != null && FAILING_CONCLUSIONS.has(c.conclusion);
}

function tierOf(c: CheckRun): number {
  if (c.status === 'queued' || c.status === 'in-progress') return TIER_IN_PROGRESS;
  if (isFailing(c)) return TIER_FAILING;
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
  if (isFailing(c)) return 'cross';
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

function statusLabel(c: CheckRun): string {
  if (c.status === 'queued') return 'Queued';
  if (c.status === 'in-progress') return 'In progress';
  switch (c.conclusion) {
    case 'success':
      return 'Passing';
    case 'failure':
      return 'Failing';
    case 'timed-out':
      return 'Timed out';
    case 'cancelled':
      return 'Cancelled';
    case 'action-required':
      return 'Action required';
    case 'skipped':
      return 'Skipped';
    case 'neutral':
      return 'Neutral';
    case 'stale':
      return 'Stale';
    case 'startup-failure':
      return 'Startup failure';
    default:
      return 'Completed';
  }
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
      const failing = state.checks.filter(isFailing).length;
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
  const now = Date.now(); // single read per render; no per-second ticker (updates each 15s poll)

  return (
    <>
      <span role="status" className="sr-only">
        {announce(state)}
      </span>
      <ChecksBody state={state} now={now} />
    </>
  );
}

function ChecksBody({ state, now }: { state: CheckRunsResult; now: number }) {
  const { status, degraded } = state;
  const sorted = status === 'ok' ? sortChecks(state.checks) : [];
  const defaultKey = sorted.length > 0 ? `${sorted[0].source}:${sorted[0].name}` : null;
  // The useState initial value is only a seed — useState ignores it on every later
  // render, so when the component first mounts in loading state (sorted empty →
  // defaultKey null) selectedKey stays null. Auto-selection is driven by
  // effectiveKey below (which falls back to defaultKey when selectedKey is null or
  // stale), NOT by this initial value. Do not "fix" this to an effect.
  const [selectedKey, setSelectedKey] = useState<string | null>(defaultKey);

  // Derive the effective selected key: if the current selection is null or no
  // longer in the list (check removed after a poll), fall back to the first row.
  const effectiveKey =
    selectedKey != null && sorted.some((c) => `${c.source}:${c.name}` === selectedKey)
      ? selectedKey
      : defaultKey;

  const selected = sorted.find((c) => `${c.source}:${c.name}` === effectiveKey) ?? null;

  if (status === 'idle' || (status === 'loading' && state.checks.length === 0)) {
    return <SkeletonRows />;
  }
  if (status === 'empty') {
    // Centred neutral card (mirrors the error card's surface/border/radius, but a muted dash
    // glyph rather than the amber warning) so the empty state reads as a design-language
    // element, not bare text. role="status" — the persistent announcer carries the SR signal.
    return (
      <div className={styles.stateWrap}>
        <div className={styles.emptyCard} role="status">
          <svg
            className={styles.emptyIcon}
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="28"
            height="28"
            fill="currentColor"
          >
            <path d={GLYPH_PATH.dash} />
          </svg>
          <p className={styles.emptyText}>No checks have been reported for this commit.</p>
        </div>
      </div>
    );
  }
  if (status === 'error') {
    // Centred card with a warning glyph + a standard app button — purpose-built for
    // this tab but matching the app's surface/border/btn design language. role="alert"
    // so the async error transition is announced (design R2).
    return (
      <div className={styles.stateWrap}>
        <div className={styles.errorCard} role="alert">
          <AlertTriangleIcon />
          <p className={styles.errorText}>
            {degraded === 'auth'
              ? "Couldn't load checks — the current token may lack access (a classic `repo` token is required for the Checks API)."
              : "Couldn't load checks."}
          </p>
          <button type="button" className="btn btn-secondary" onClick={state.retry}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.checks}>
      {degraded !== 'none' && (
        <div className={styles.degradedBanner} role="status">
          {degraded === 'auth'
            ? "PRism couldn't read some checks -- the current token may lack access (a classic `repo` token is required for the Checks API)."
            : "Some checks couldn't be loaded -- retry."}
        </div>
      )}
      <div className={styles.masterDetail}>
        {/* Left pane: check list */}
        <div className={styles.listPane} role="listbox" aria-label="Checks">
          {sorted.map((c) => {
            const key = `${c.source}:${c.name}`;
            const duration = formatDuration(c, now);
            const isSelected = key === effectiveKey;
            return (
              <button
                key={key}
                role="option"
                aria-selected={isSelected}
                className={`${styles.row} ${isSelected ? styles.rowSelected : ''}`}
                onClick={() => setSelectedKey(key)}
                type="button"
              >
                <RowGlyphIcon glyph={glyphFor(c)} />
                <span className={styles.name} data-testid="check-name" title={c.name}>
                  {c.name}
                </span>
                <span className={styles.statusBadge}>{statusLabel(c)}</span>
                {duration != null && (
                  <span className={styles.duration} data-testid="check-duration">
                    {duration}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Right pane: detail panel */}
        <div
          className={styles.detailPane}
          role="region"
          aria-label={selected != null ? selected.name : 'Check details'}
        >
          {selected != null ? <CheckDetail check={selected} now={now} /> : null}
        </div>
      </div>
    </div>
  );
}

const isInProgress = (c: CheckRun) => c.status === 'queued' || c.status === 'in-progress';

// The Actions workflow-run id, parsed from a check-run's details_url
// (…/actions/runs/{run_id}/job/{job_id}). null for non-Actions checks (third-party App or
// legacy status), whose details_url has no run id — those aren't subject to the run-busy rule.
function runIdOf(c: CheckRun): string | null {
  if (c.detailsUrl == null) return null;
  const m = /\/actions\/runs\/(\d+)/.exec(c.detailsUrl);
  return m ? m[1] : null;
}

// A job can't be re-run while its workflow RUN is in progress — even if this job's own check
// shows `completed`, GitHub 403s ("The workflow run containing this job is already running").
// The run is busy when any check sharing this check's run id is non-terminal. Scoped by run id
// so checks in a different, idle run stay re-runnable.
function runIsBusy(c: CheckRun, all: CheckRun[]): boolean {
  const runId = runIdOf(c);
  if (runId == null) return false;
  return all.some((o) => o !== c && isInProgress(o) && runIdOf(o) === runId);
}

// Why the Re-run button is disabled, or null when it is eligible. The reason strings are
// user-facing captions; headSha == null is an internal invariant (prod always has it) handled
// separately on the disabled gate, not here.
function rerunDisabledReason(c: CheckRun, all: CheckRun[]): string | null {
  if (c.source !== 'check-run') return "Legacy status checks can't be re-run from PRism";
  if (c.status !== 'completed') return 'Check is still running';
  if (c.checkRunId == null) return 'Not re-runnable';
  if (runIsBusy(c, all)) return 'A re-run is in progress for this commit';
  return null; // eligible
}

function CheckDetail({ check: c, now }: { check: CheckRun; now: number }) {
  // Read everything from the shared PrDetail context — ChecksTab does NOT own useCheckRuns,
  // so there is no prop to thread. headSha is null-safe (sub-tab tests stub prDetail as {}).
  const { prRef, prDetail, checks: state } = usePrDetailContext();
  const headSha = prDetail.pr?.headSha ?? null;
  const rerunPendingFor = state.rerunPendingFor ?? null; // optional on the interface

  const duration = formatDuration(c, now);
  const sourceLabel = c.source === 'check-run' ? 'GitHub check' : 'Status';
  const metaParts: string[] = [];
  if (c.appName != null) metaParts.push(c.appName);
  metaParts.push(sourceLabel);
  if (duration != null) metaParts.push(duration);

  const disabledReason = rerunDisabledReason(c, state.checks);
  const [phase, setPhase] = useState<'idle' | 'posting' | 'error'>('idle');
  const [errorOutcome, setErrorOutcome] = useState<RerunOutcome | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Per-check isolation: reset the rerun UI when the selected check changes.
  const identity = c.checkRunId ?? c.name;
  useEffect(() => {
    setPhase('idle');
    setErrorOutcome(null);
    setNote(null);
  }, [identity]);

  const watching = rerunPendingFor != null && rerunPendingFor === c.checkRunId;
  const running = phase === 'posting' || watching;

  // `runIsBusy` (in disabledReason) catches a sibling whose run is in progress once polling
  // reflects it. This covers the gap BEFORE that: right after we trigger a re-run, the watched
  // check's run is already in progress on GitHub but our list still shows it `completed`, so a
  // sibling re-run would 403. While our watch is pending for ANOTHER check, block siblings up
  // front. (The watched check itself shows "Re-running…" via `running`.)
  const anotherRerunPending = rerunPendingFor != null && rerunPendingFor !== c.checkRunId;
  const blockedReason =
    disabledReason ?? (anotherRerunPending ? 'A re-run is in progress for this commit' : null);

  const handleRerun = async () => {
    if (c.checkRunId == null || headSha == null) return; // also narrows headSha to string
    setPhase('posting');
    setErrorOutcome(null);
    setNote(null);
    const ctrl = new AbortController();
    try {
      const { outcome } = await rerunCheck(prRef, c.checkRunId, headSha, ctrl.signal);
      if (outcome === 'accepted') {
        state.armRerunWatch?.(c.checkRunId); // hook drives "Re-running…" via rerunPendingFor
        setPhase('idle');
      } else if (outcome === 'superseded') {
        setPhase('idle');
        setNote('The PR was updated — re-run from the latest checks.');
      } else {
        setErrorOutcome(outcome); // auth | not-rerunnable | transient
        setPhase('error');
      }
    } catch {
      setErrorOutcome('transient');
      setPhase('error');
    }
  };

  const errorText =
    errorOutcome === 'auth'
      ? "Couldn't re-run — PRism couldn't authenticate to GitHub. Reconnect your token."
      : errorOutcome === 'not-rerunnable'
        ? "Couldn't re-run this check — GitHub didn't allow it. A re-run may already be in progress for this commit, or the check may be too old to re-run."
        : "Couldn't re-run — try again.";

  return (
    <div className={styles.detail}>
      {/* Header (read-only) */}
      <div className={styles.detailHeader}>
        <RowGlyphIcon glyph={glyphFor(c)} />
        <span className={styles.detailName}>{c.name}</span>
        <span className={styles.detailStatus}>{statusLabel(c)}</span>
      </div>

      {/* Meta line */}
      <p className={styles.detailMeta}>{metaParts.join(' · ')}</p>

      {/* Summary title */}
      {c.summary != null && <p className={styles.detailSummary}>{c.summary}</p>}

      {/* Markdown body */}
      {c.body != null ? (
        <MarkdownRenderer source={c.body} className={styles.body} dataTestId="check-body" />
      ) : (
        <p className={styles.detailNoBody}>No additional details from this check.</p>
      )}

      {/* GitHub link */}
      {c.detailsUrl != null && (
        <a
          className={styles.detailLink}
          href={c.detailsUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on GitHub ↗
        </a>
      )}

      {/* Re-run action row (footer; header stays read-only) */}
      <div className={styles.rerunRow}>
        <button
          type="button"
          className={`btn btn-secondary ${styles.rerunButton}`}
          disabled={blockedReason != null || running || headSha == null}
          onClick={handleRerun}
        >
          {running ? (
            <>
              <RowGlyphIcon glyph="spinner" /> Re-running…
            </>
          ) : (
            'Re-run'
          )}
        </button>
        {!running && blockedReason != null && (
          <span className={styles.rerunCaption}>{blockedReason}</span>
        )}
      </div>

      {/* Live regions: a token-styled callout — alert (amber-keyed) for failures, a
          neutral status callout for the superseded note — so the feedback reads as a
          design-language element, not bare text under the button. */}
      {phase === 'error' && (
        <div role="alert" className={`${styles.rerunCallout} ${styles.rerunCalloutError}`}>
          <RowGlyphIcon glyph="alert" />
          <span className={styles.rerunCalloutText}>{errorText}</span>
          {errorOutcome === 'transient' && (
            <button
              type="button"
              className={`btn btn-secondary ${styles.rerunRetry}`}
              onClick={handleRerun}
            >
              Retry
            </button>
          )}
        </div>
      )}
      {note != null && (
        <div role="status" className={`${styles.rerunCallout} ${styles.rerunCalloutNote}`}>
          <span className={styles.rerunCalloutText}>{note}</span>
        </div>
      )}
      {/* SR-only running announcement */}
      <span role="status" className="sr-only">
        {running ? `Re-running ${c.name}` : ''}
      </span>
    </div>
  );
}

// Loading skeleton mirrors the real master-detail layout (capped width, list pane +
// detail pane) so the placeholder occupies the same footprint the loaded tab will —
// no full-width sprawl, no jump when content arrives.
function SkeletonRows() {
  return (
    <div className={styles.checks} aria-busy="true">
      {/* No role on the placeholder panes — they're decorative; the persistent
          role="status" announcer ("Loading checks…") carries the SR signal, so the
          skeleton doesn't expose a misleading empty list/listbox landmark. */}
      <div className={styles.masterDetail}>
        <div className={styles.listPane}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${styles.row} ${styles.skeleton}`} />
          ))}
        </div>
        <div className={styles.detailPane}>
          <div className={styles.skeletonDetail} />
        </div>
      </div>
    </div>
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

const GLYPH_CLS: Record<RowGlyph, string> = {
  cross: styles.glyphFail,
  alert: styles.glyphAlert,
  spinner: styles.glyphPending,
  check: styles.glyphPass,
  dash: styles.glyphNeutral,
};

// octicon alert-16 — the same triangle the action-required row glyph uses, rendered
// larger and amber for the error-state card.
function AlertTriangleIcon() {
  return (
    <svg
      className={styles.errorIcon}
      aria-hidden="true"
      viewBox="0 0 16 16"
      width="32"
      height="32"
      fill="currentColor"
    >
      <path d={GLYPH_PATH.alert} />
    </svg>
  );
}

function RowGlyphIcon({ glyph }: { glyph: RowGlyph }) {
  return (
    <svg
      className={`${styles.glyph} ${GLYPH_CLS[glyph]}`}
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
