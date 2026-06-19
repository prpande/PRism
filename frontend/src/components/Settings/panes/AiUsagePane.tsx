import { useCallback, useEffect, useRef, useState } from 'react';
import { getAiUsage } from '../../../api/aiUsage';
import type { AiUsageReport, AiUsageWindow } from '../../../api/types';
import { formatCost, formatTokens } from '../../../utils/formatUsage';
import { SegmentedControl } from '../../controls/SegmentedControl';
import pane from './Pane.module.css';
import styles from './AiUsagePane.module.css';

const WINDOWS: { value: AiUsageWindow; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All' },
];

type Status = 'cold' | 'loading' | 'ready' | 'error';

export function AiUsagePane() {
  const [selectedWindow, setSelectedWindow] = useState<AiUsageWindow>('7d');
  const [report, setReport] = useState<AiUsageReport | null>(null);
  const [status, setStatus] = useState<Status>('cold');
  const reqId = useRef(0);
  const reportRef = useRef<AiUsageReport | null>(null);

  const load = useCallback((w: AiUsageWindow) => {
    const id = ++reqId.current;
    // Base the cold-vs-loading decision on whether data exists, not on prior status.
    // This prevents a post-error retry from wiping retained numbers back to the skeleton.
    setStatus(() => (reportRef.current !== null ? 'loading' : 'cold'));
    getAiUsage(w)
      .then((r) => {
        if (id !== reqId.current) return; // a newer request superseded this one
        reportRef.current = r;
        setReport(r);
        setStatus('ready');
      })
      .catch(() => {
        if (id !== reqId.current) return;
        setStatus('error');
      });
  }, []); // stable — no `report` dependency, so no stale closure on the retry path

  useEffect(() => {
    load(selectedWindow);
  }, [selectedWindow, load]);

  const onWindow = (w: AiUsageWindow) => {
    if (w !== selectedWindow) setSelectedWindow(w);
  };

  // A cache-only window (cacheHits > 0, no tokens, no provider calls) is NOT empty — it must show
  // the cache stat, the one signal that matters most to a cache-heavy user.
  const isEmpty =
    report !== null &&
    report.totals.totalTokens === 0 &&
    report.totals.providerCalls === 0 &&
    report.totals.cacheHits === 0;

  return (
    <section className={styles.pane} aria-labelledby="ai-usage-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ai-usage-heading" className={pane.title}>
            AI Usage
          </h2>
          <p className={pane.sub}>Token usage and estimated equivalent cost, by feature and PR.</p>
        </div>
      </div>

      <div className={status === 'loading' ? styles.loadingControl : undefined}>
        <SegmentedControl
          label="Usage window"
          value={selectedWindow}
          options={WINDOWS}
          disabled={status === 'loading'}
          onChange={(v) => onWindow(v as AiUsageWindow)}
        />
      </div>

      {status === 'cold' && <Skeleton />}
      {/* Cold error — no data to fall back to → full error card. */}
      {status === 'error' && report === null && (
        <div className={styles.card} role="alert">
          <p>Could not load usage data.</p>
          <button type="button" onClick={() => load(selectedWindow)}>
            Try again
          </button>
        </div>
      )}
      {/* We have data → keep it visible. §5.3 promises a window switch keeps the previous numbers
          on screen — and a *refresh* error must not wipe them either. A refresh failure shows a
          non-blocking inline notice ABOVE the retained report rather than replacing the pane.
          The error notice is shared across both the empty and non-empty retained-data branches. */}
      {report !== null && status !== 'cold' && (
        <>
          {status === 'error' && (
            <div className={styles.card} role="alert">
              <p>Could not refresh usage data — showing the last loaded numbers.</p>
              <button type="button" onClick={() => load(selectedWindow)}>
                Try again
              </button>
            </div>
          )}
          {isEmpty ? (
            <div className={styles.card}>
              <p>No AI usage recorded yet.</p>
            </div>
          ) : (
            <Report report={report} />
          )}
        </>
      )}
    </section>
  );
}

function Skeleton() {
  return (
    <>
      <div className={styles.card}>
        <div className={styles.skeletonRow} style={{ width: '40%' }} />
      </div>
      <div className={styles.trend} aria-hidden="true">
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className={styles.skeletonBar} />
        ))}
      </div>
      <div className={styles.card}>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className={styles.skeletonRow} />
        ))}
      </div>
    </>
  );
}

function Report({ report }: { report: AiUsageReport }) {
  const [showPrs, setShowPrs] = useState(false);
  const prTableRef = useRef<HTMLTableElement>(null);
  // Bar height, tooltip, and the SR summary ALL track cost so the tallest bar IS the highest-spend
  // bucket (cache-read tokens are cheap; output costs more than input — token volume ≠ cost).
  const trendCostMax = report.trend.reduce((m, t) => Math.max(m, t.estimatedCostUsd), 0);
  const showTrend = trendCostMax > 0; // a spend trend — omit entirely when there's no cost to chart
  const peak = report.trend.reduce<AiUsageReport['trend'][number] | null>(
    (a, b) => (a === null || b.estimatedCostUsd > a.estimatedCostUsd ? b : a),
    null,
  );
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <>
      <div className={styles.card} role="region" aria-label="Usage summary">
        <div className={styles.headlineCost}>{formatCost(report.totals.estimatedCostUsd)}</div>
        <div>{formatTokens(report.totals.totalTokens)} tokens</div>
        <div className={styles.headlineSub}>
          Estimated API-equivalent cost — for reference only; PRism uses a Claude subscription, not
          pay-per-token billing.
        </div>
      </div>

      {/* A *spend* trend — rendered only when there's nonzero cost to chart, so a cache-only or
          all-zero-cost window shows neither an empty 64px gap nor flat bars that contradict the
          tables below. Decorative; the precise data lives in the tables. Height tracks cost. */}
      {showTrend && (
        <>
          <div className={styles.trend} aria-hidden="true">
            {report.trend.map((t) => (
              <div
                key={t.bucketStart}
                className={styles.bar}
                style={{ height: `${Math.round((t.estimatedCostUsd / trendCostMax) * 100)}%` }}
                title={`${fmtDate(t.bucketStart)}: ${formatCost(t.estimatedCostUsd)}`}
              />
            ))}
          </div>
          {peak && peak.estimatedCostUsd > 0 && (
            <p className="sr-only">
              Highest spend: {fmtDate(peak.bucketStart)}, {formatCost(peak.estimatedCostUsd)}.
            </p>
          )}
        </>
      )}

      <table className={styles.table} aria-label="Usage by feature">
        <thead>
          <tr>
            <th>Feature</th>
            <th className={styles.num}>Calls</th>
            <th className={styles.num}>Tokens</th>
            <th className={styles.num}>Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {report.byFeature.map((f) => (
            <tr key={f.component}>
              <td>{f.displayName}</td>
              <td className={styles.num}>{formatTokens(f.providerCalls)}</td>
              <td className={styles.num}>{formatTokens(f.totalTokens)}</td>
              <td className={styles.num}>{formatCost(f.estimatedCostUsd)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={styles.card}>
        Cache hit-rate: {Math.round(report.cache.hitRate * 100)}% —{' '}
        {formatTokens(report.cache.cacheHits)} calls served from cache.
      </div>

      <div className={styles.card}>
        <button
          type="button"
          aria-expanded={showPrs}
          onClick={() => {
            const next = !showPrs;
            setShowPrs(next);
            // Move focus into the revealed table so keyboard users land on the new content
            // instead of tabbing from the button through it. rAF: the table mounts this render.
            if (next) requestAnimationFrame(() => prTableRef.current?.focus());
          }}
        >
          By PR ({report.totalPrCount})
        </button>
        {showPrs && (
          <>
            {/* Render report.byPr VERBATIM — the backend already capped at top-20-by-cost AND appended
                the "batch" row past the cap (§4.4). Re-slicing here (e.g. .slice(0, 20)) would drop
                exactly that appended "Inbox (batched)" row, violating AC §10. */}
            <table ref={prTableRef} tabIndex={-1} className={styles.table} aria-label="Usage by PR">
              <thead>
                <tr>
                  <th>PR</th>
                  <th className={styles.num}>Tokens</th>
                  <th className={styles.num}>Est. cost</th>
                </tr>
              </thead>
              <tbody>
                {report.byPr.map((p) => (
                  <tr key={p.prRef}>
                    <td>{p.displayLabel}</td>
                    <td className={styles.num}>{formatTokens(p.totalTokens)}</td>
                    <td className={styles.num}>{formatCost(p.estimatedCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Honest truncation note — the payload is capped server-side, so there is no "show all"
                to fetch. Static "+N more", matching the §4.6 DTO comment (TotalPrCount "for +N more"). */}
            {report.totalPrCount > report.byPr.length && (
              <p className={styles.headlineSub}>
                Showing {report.byPr.length} of {report.totalPrCount} PRs (top by cost).
              </p>
            )}
          </>
        )}
      </div>
    </>
  );
}
