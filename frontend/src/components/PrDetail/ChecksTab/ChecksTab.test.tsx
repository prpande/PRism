// frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChecksTab } from './ChecksTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { PrDetailContextValue } from '../prDetailContext';
import { makePrDetailContextValue } from '../testUtils';
import * as checksApi from '../../../api/checks';
import type { CheckRun } from '../../../api/types';
import type { CheckRunsResult } from '../../../hooks/useCheckRuns';

const run = (over: Partial<CheckRun>): CheckRun => ({
  name: 'x',
  status: 'completed',
  conclusion: 'success',
  source: 'check-run',
  startedAt: '2026-06-25T10:00:00Z',
  completedAt: '2026-06-25T10:00:45Z',
  detailsUrl: 'https://github.com/o/r/runs/1',
  summary: null,
  appName: null,
  body: null,
  checkRunId: 1,
  ...over,
});

function renderTab(checks: CheckRunsResult) {
  return render(
    <PrDetailContextProvider value={makePrDetailContextValue({ checks })}>
      <ChecksTab />
    </PrDetailContextProvider>,
  );
}

const base = { degraded: 'none' as const, retry: () => {} };

describe('ChecksTab', () => {
  it('renders a flat list problems-first (failing before passing)', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ name: 'pass' }), run({ name: 'fail', conclusion: 'failure' })],
    });
    const names = screen.getAllByTestId('check-name').map((n) => n.textContent);
    expect(names[0]).toBe('fail');
    expect(names[1]).toBe('pass');
  });

  it('cancelled sorts into the failing tier (top)', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ name: 'ok' }), run({ name: 'canc', conclusion: 'cancelled' })],
    });
    expect(screen.getAllByTestId('check-name')[0]).toHaveTextContent('canc');
  });

  it('skipped checks sort to the end, after passing (#690)', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [
        run({ name: 'skip', conclusion: 'skipped' }),
        run({ name: 'pass', conclusion: 'success' }),
      ],
    });
    const names = screen.getAllByTestId('check-name').map((n) => n.textContent);
    expect(names).toEqual(['pass', 'skip']);
  });

  it('neutral-family checks stay above passing — only skipped moves to the end (#690, boundary of #305)', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [
        run({ name: 'pass', conclusion: 'success' }),
        run({ name: 'neut', conclusion: 'neutral' }),
      ],
    });
    const names = screen.getAllByTestId('check-name').map((n) => n.textContent);
    expect(names).toEqual(['neut', 'pass']);
  });

  it('renders empty state', () => {
    renderTab({ ...base, status: 'empty', checks: [] });
    expect(screen.getByText(/no checks have been reported for this commit/i)).toBeInTheDocument();
  });

  it('renders auth error copy', () => {
    renderTab({ status: 'error', degraded: 'auth', checks: [], retry: () => {} });
    expect(screen.getByText(/classic .*repo.* token is required/i)).toBeInTheDocument();
  });

  it('renders transient error copy', () => {
    renderTab({ status: 'error', degraded: 'transient', checks: [], retry: () => {} });
    expect(screen.getByText(/retry/i)).toBeInTheDocument();
  });

  it('shows a degraded banner above a partial list', () => {
    renderTab({ status: 'ok', degraded: 'auth', checks: [run({})], retry: () => {} });
    expect(screen.getByText(/couldn't read some checks/i)).toBeInTheDocument();
  });

  it('omits duration for a legacy status source', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ source: 'status', startedAt: null, completedAt: null })],
    });
    expect(screen.queryByTestId('check-duration')).toBeNull();
  });

  it('first row auto-selects and shows detail panel', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ name: 'build', summary: '2 errors', body: null })],
    });
    // Assert the panel itself is rendered and bound to the first row — not just
    // that the name appears somewhere (it also appears in the list row, so a bare
    // getAllByText would pass even with the panel removed).
    const panel = screen.getByRole('region', { name: 'build' });
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveTextContent('2 errors');
  });

  it('clicking a different row updates the detail panel', async () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [
        run({ name: 'fail', conclusion: 'failure' }),
        run({ name: 'pass', conclusion: 'success' }),
      ],
    });
    // fail is first (failing tier sorts first)
    const passButton = screen.getAllByRole('option').find((el) => el.textContent?.includes('pass'));
    expect(passButton).toBeTruthy();
    await userEvent.click(passButton!);
    // after clicking pass row, detail panel aria-label should update
    const detailPanel = screen.getByRole('region', { name: 'pass' });
    expect(detailPanel).toBeInTheDocument();
  });

  it('renders markdown body in detail panel', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ name: 'build', body: '### Build output\n\nSome details' })],
    });
    expect(screen.getByTestId('check-body')).toBeInTheDocument();
  });

  it('renders "No additional details" fallback when body is null', () => {
    renderTab({
      ...base,
      status: 'ok',
      checks: [run({ name: 'build', body: null })],
    });
    expect(screen.getByText(/no additional details from this check/i)).toBeInTheDocument();
  });

  it('View on GitHub link appears only when detailsUrl is not null', () => {
    const { rerender } = renderTab({
      ...base,
      status: 'ok',
      checks: [run({ detailsUrl: null })],
    });
    expect(screen.queryByRole('link', { name: /view on github/i })).toBeNull();

    rerender(
      <PrDetailContextProvider
        value={makePrDetailContextValue({
          checks: {
            ...base,
            status: 'ok',
            checks: [run({ detailsUrl: 'https://github.com/o/r/runs/1' })],
          },
        })}
      >
        <ChecksTab />
      </PrDetailContextProvider>,
    );
    const link = screen.getByRole('link', { name: /view on github/i });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('action-required conclusion renders the amber alert glyph (scope R2)', () => {
    const { container } = renderTab({
      ...base,
      status: 'ok',
      checks: [run({ conclusion: 'action-required' })],
    });
    expect(container.querySelector('[data-glyph="alert"]')).not.toBeNull();
  });

  it('error state is a live region (role=alert) for async announcement (design R2)', () => {
    renderTab({ status: 'error', degraded: 'transient', checks: [], retry: () => {} });
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';
const DEFAULT_PR_REF = { owner: 'acme', repo: 'api', number: 123 }; // from makePrDetailContextValue
const prDetailWithSha = { pr: { headSha: HEAD_SHA } } as PrDetailContextValue['prDetail'];

// Render the tab with one selected check + a rerun-aware checks result and a real headSha.
function renderRerun(checkOver: Partial<CheckRun>, resultOver: Partial<CheckRunsResult> = {}) {
  const checks: CheckRunsResult = {
    ...base,
    status: 'ok',
    checks: [run(checkOver)],
    refetch: vi.fn(),
    armRerunWatch: vi.fn(),
    rerunPendingFor: null,
    ...resultOver,
  };
  return render(
    <PrDetailContextProvider
      value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
    >
      <ChecksTab />
    </PrDetailContextProvider>,
  );
}

describe('ChecksTab — Re-run action', () => {
  afterEach(() => vi.restoreAllMocks());

  it('enables Re-run for an eligible completed check-run, disables it for ineligible rows', () => {
    // eligible: check-run + completed + checkRunId (run() defaults checkRunId: 1)
    const eligible = renderRerun({ name: 'build' });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeEnabled();
    eligible.unmount();

    // legacy status source → disabled with caption (this is the path that lets
    // FakePrChecksReader keep 3 check-run rows — see the deviation note)
    const legacy = renderRerun({ name: 'legacy', source: 'status', checkRunId: null });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeDisabled();
    expect(screen.getByText(/legacy status checks can't be re-run/i)).toBeInTheDocument();
    legacy.unmount();

    // still-running check-run → disabled with "still running"
    renderRerun({ name: 'running', status: 'in-progress', conclusion: null });
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeDisabled();
    expect(screen.getByText(/still running/i)).toBeInTheDocument();
  });

  it('clicking Re-run posts with the head sha + checkRunId and arms the watch on accepted', async () => {
    const rerun = vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'accepted' });
    const armRerunWatch = vi.fn();
    renderRerun({ name: 'build', checkRunId: 77 }, { armRerunWatch });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(rerun).toHaveBeenCalledWith(DEFAULT_PR_REF, 77, HEAD_SHA, expect.any(AbortSignal));
    await waitFor(() => expect(armRerunWatch).toHaveBeenCalledWith(77));
  });

  it('shows "Re-running…" and disables the button while the watch is pending for this check', () => {
    renderRerun({ name: 'build', checkRunId: 77 }, { rerunPendingFor: 77 });
    expect(screen.getByRole('button', { name: /re-running/i })).toBeDisabled();
  });

  it('disables a sibling (with a caption) while another check re-runs — no spinner on the sibling', () => {
    renderRerun({ name: 'build', checkRunId: 77 }, { rerunPendingFor: 999 });
    // Label stays "Re-run" (not "Re-running…") — the spinner is per-check…
    const btn = screen.getByRole('button', { name: /^re-run$/i });
    // …but the sibling is blocked: GitHub would refuse a job re-run mid-run.
    expect(btn).toBeDisabled();
    expect(screen.getByText(/a re-run is in progress for this commit/i)).toBeInTheDocument();
  });

  it('disables a completed check whose workflow run is still in progress (same-run sibling non-terminal)', () => {
    const checks: CheckRunsResult = {
      ...base,
      status: 'ok',
      checks: [
        // 'build' is completed+failing (re-runnable on its own) but shares run 55 with…
        run({
          name: 'build',
          conclusion: 'failure',
          checkRunId: 1,
          detailsUrl: 'https://github.com/o/r/actions/runs/55/job/1',
        }),
        // …an in-progress 'e2e' → the run is busy, so 'build' can't be re-run yet.
        run({
          name: 'e2e',
          status: 'in-progress',
          conclusion: null,
          checkRunId: 2,
          detailsUrl: 'https://github.com/o/r/actions/runs/55/job/2',
        }),
      ],
      refetch: vi.fn(),
      armRerunWatch: vi.fn(),
      rerunPendingFor: null,
    };
    render(
      <PrDetailContextProvider
        value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
      >
        <ChecksTab />
      </PrDetailContextProvider>,
    );
    // 'build' (failing tier) auto-selects ahead of the in-progress 'e2e'
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeDisabled();
    expect(screen.getByText(/a re-run is in progress for this commit/i)).toBeInTheDocument();
  });

  it('keeps a completed check re-runnable when the in-progress sibling is in a DIFFERENT run', () => {
    const checks: CheckRunsResult = {
      ...base,
      status: 'ok',
      checks: [
        run({
          name: 'build',
          conclusion: 'failure',
          checkRunId: 1,
          detailsUrl: 'https://github.com/o/r/actions/runs/55/job/1',
        }),
        run({
          name: 'e2e',
          status: 'in-progress',
          conclusion: null,
          checkRunId: 2,
          detailsUrl: 'https://github.com/o/r/actions/runs/66/job/2', // different run → not busy
        }),
      ],
      refetch: vi.fn(),
      armRerunWatch: vi.fn(),
      rerunPendingFor: null,
    };
    render(
      <PrDetailContextProvider
        value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
      >
        <ChecksTab />
      </PrDetailContextProvider>,
    );
    expect(screen.getByRole('button', { name: /^re-run$/i })).toBeEnabled();
  });

  it('surfaces an inline alert per failure outcome (auth / not-rerunnable / transient+Retry)', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'auth' });
    const a = renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/authenticate/i);
    a.unmount();
    vi.restoreAllMocks();

    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'not-rerunnable' });
    const b = renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/GitHub didn't allow it/i);
    b.unmount();
    vi.restoreAllMocks();

    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'transient' });
    renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/try again/i);
    expect(within(alert).getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('superseded shows a neutral status note, not an alert', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'superseded' });
    renderRerun({ name: 'build', checkRunId: 5 });
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByText(/PR was updated/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('clears the rerun error when a different check is selected (per-check isolation)', async () => {
    vi.spyOn(checksApi, 'rerunCheck').mockResolvedValue({ outcome: 'transient' });
    const checks: CheckRunsResult = {
      ...base,
      status: 'ok',
      checks: [run({ name: 'aaa', checkRunId: 1 }), run({ name: 'bbb', checkRunId: 2 })],
      refetch: vi.fn(),
      armRerunWatch: vi.fn(),
      rerunPendingFor: null,
    };
    render(
      <PrDetailContextProvider
        value={makePrDetailContextValue({ checks, prDetail: prDetailWithSha })}
      >
        <ChecksTab />
      </PrDetailContextProvider>,
    );
    // aaa auto-selects (same tier, alphabetical) → trigger an error on it
    await userEvent.click(screen.getByRole('button', { name: /^re-run$/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    // select bbb → identity change resets phase/error; no stale alert
    const bbbRow = screen.getAllByRole('option').find((o) => o.textContent?.includes('bbb'));
    await userEvent.click(bbbRow!);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
