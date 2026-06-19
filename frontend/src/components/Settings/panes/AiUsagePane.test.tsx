import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AiUsagePane } from './AiUsagePane';
import * as api from '../../../api/aiUsage';
import type { AiUsageReport } from '../../../api/types';

function report(over: Partial<AiUsageReport> = {}): AiUsageReport {
  return {
    window: '7d',
    generatedAt: '2026-06-19T12:00:00Z',
    totals: {
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 5000,
      totalTokens: 6200,
      estimatedCostUsd: 0.0012,
      providerCalls: 3,
      cacheHits: 1,
    },
    byFeature: [
      {
        component: 'summary',
        displayName: 'PR Summary',
        totalTokens: 6200,
        estimatedCostUsd: 0.0012,
        providerCalls: 3,
      },
    ],
    byPr: [
      {
        prRef: 'batch',
        displayLabel: 'Inbox (batched)',
        totalTokens: 100,
        estimatedCostUsd: 0.0001,
        providerCalls: 1,
      },
    ],
    totalPrCount: 1,
    cache: { cacheHits: 1, providerCalls: 3, hitRate: 0.25 },
    trend: [
      {
        bucketStart: '2026-06-18T00:00:00Z',
        granularity: 'day',
        estimatedCostUsd: 0.0012,
        totalTokens: 6200,
      },
    ],
    ...over,
  };
}

/** Wait for the report to be rendered by asserting the headline summary region is present. */
async function findHeadlineSummary() {
  return screen.findByRole('region', { name: /usage summary/i });
}

describe('AiUsagePane', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the headline cost with sub-cent precision and the by-feature table', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(report());
    render(<AiUsagePane />);

    const summary = await findHeadlineSummary();
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument(); // not $0.00
    const table = screen.getByRole('table', { name: /by feature/i });
    expect(within(table).getByText('PR Summary')).toBeInTheDocument();
  });

  it('shows the empty state when no usage is recorded', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(
      report({
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          providerCalls: 0,
          cacheHits: 0,
        },
        byFeature: [],
        byPr: [],
        totalPrCount: 0,
        trend: [],
        cache: { cacheHits: 0, providerCalls: 0, hitRate: 0 },
      }),
    );
    render(<AiUsagePane />);
    expect(await screen.findByText('No AI usage recorded yet.')).toBeInTheDocument();
  });

  it('shows the error state with a Try again button that refetches', async () => {
    const spy = vi
      .spyOn(api, 'getAiUsage')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(report());
    render(<AiUsagePane />);

    expect(await screen.findByText('Could not load usage data.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    const summary = await findHeadlineSummary();
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps the last loaded numbers visible when a window switch fails (no full-pane error)', async () => {
    vi.spyOn(api, 'getAiUsage')
      .mockResolvedValueOnce(report()) // initial 7d loads
      .mockRejectedValueOnce(new Error('boom')); // 30d switch fails
    render(<AiUsagePane />);
    const summary = await findHeadlineSummary();

    await userEvent.click(screen.getByRole('radio', { name: '30d' }));
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument(); // stale data retained, not wiped
  });

  it('keeps the previous data visible while a window switch loads (stale-while-loading)', async () => {
    let resolveSecond: (r: AiUsageReport) => void = () => {};
    const spy = vi
      .spyOn(api, 'getAiUsage')
      .mockResolvedValueOnce(report())
      .mockImplementationOnce(
        () =>
          new Promise<AiUsageReport>((res) => {
            resolveSecond = res;
          }),
      );
    render(<AiUsagePane />);
    const summary = await findHeadlineSummary();

    await userEvent.click(screen.getByRole('radio', { name: '30d' }));
    // Old data still on screen while the 30d fetch is in flight.
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument();

    resolveSecond(report({ window: '30d', totals: { ...report().totals, estimatedCostUsd: 9.5 } }));
    await waitFor(() => expect(within(summary).getByText('$9.50')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledWith('30d');
  });

  it('renders the by-PR "Inbox (batched)" row when the drill-down is expanded', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(report());
    render(<AiUsagePane />);
    await findHeadlineSummary();

    await userEvent.click(screen.getByRole('button', { name: /by pr/i }));
    expect(screen.getByText('Inbox (batched)')).toBeInTheDocument();
  });

  it('keeps the appended "Inbox (batched)" row visible with >20 PRs (no client re-slice)', async () => {
    // Backend caps at top-20-by-cost then appends batch as the 21st row; client must not re-slice.
    const priced = Array.from({ length: 20 }, (_, i) => ({
      prRef: `o/r#${i}`,
      displayLabel: `o/r#${i}`,
      totalTokens: 10,
      estimatedCostUsd: (i + 1) * 0.01,
      providerCalls: 1,
    }));
    const batch = {
      prRef: 'batch',
      displayLabel: 'Inbox (batched)',
      totalTokens: 5,
      estimatedCostUsd: 0.0001,
      providerCalls: 1,
    };
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(
      report({ byPr: [...priced, batch], totalPrCount: 26 }),
    );
    render(<AiUsagePane />);
    await findHeadlineSummary();

    await userEvent.click(screen.getByRole('button', { name: /by pr/i }));
    expect(screen.getByText('Inbox (batched)')).toBeInTheDocument(); // would be dropped by a .slice(0,20)
    expect(screen.getByText(/showing 21 of 26 PRs/i)).toBeInTheDocument();
  });

  it('retains displayed numbers during a refresh-failure retry (no skeleton flash)', async () => {
    let resolveThird: (r: AiUsageReport) => void = () => {};
    const spy = vi
      .spyOn(api, 'getAiUsage')
      .mockResolvedValueOnce(report()) // 1st fetch: initial 7d loads
      .mockRejectedValueOnce(new Error('boom')) // 2nd fetch: switch to 30d fails
      .mockImplementationOnce(
        () =>
          new Promise<AiUsageReport>((res) => {
            resolveThird = res;
          }),
      ); // 3rd fetch: retry is in-flight

    render(<AiUsagePane />);
    const summary = await findHeadlineSummary();

    // Step 1: switch to 30d — it fails, inline notice appears, data retained
    await userEvent.click(screen.getByRole('radio', { name: '30d' }));
    expect(await screen.findByText(/could not refresh/i)).toBeInTheDocument();
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument();

    // Step 2: click inline Try again — third fetch is in-flight (deferred)
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));

    // Core assertion: no skeleton while the retry is in-flight, old value still present
    expect(document.querySelector('[class*="skeletonRow"]')).toBeNull();
    expect(within(summary).getByText('$0.0012')).toBeInTheDocument();

    // Step 3: resolve with new data → swaps in
    resolveThird(report({ window: '30d', totals: { ...report().totals, estimatedCostUsd: 5.5 } }));
    await waitFor(() => expect(within(summary).getByText('$5.50')).toBeInTheDocument());
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('shows the cache stat (not the empty state) for a cache-only window', async () => {
    vi.spyOn(api, 'getAiUsage').mockResolvedValue(
      report({
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          totalTokens: 0,
          estimatedCostUsd: 0,
          providerCalls: 0,
          cacheHits: 4,
        },
        byFeature: [],
        byPr: [],
        totalPrCount: 0,
        trend: [],
        cache: { cacheHits: 4, providerCalls: 0, hitRate: 1 },
      }),
    );
    render(<AiUsagePane />);
    expect(await screen.findByText(/served from cache/i)).toBeInTheDocument();
    expect(screen.queryByText('No AI usage recorded yet.')).not.toBeInTheDocument();
  });
});
