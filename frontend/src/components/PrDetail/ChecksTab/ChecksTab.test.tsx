// frontend/src/components/PrDetail/ChecksTab/ChecksTab.test.tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChecksTab } from './ChecksTab';
import { PrDetailContextProvider } from '../prDetailContext';
import { makePrDetailContextValue } from '../testUtils';
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

  it('renders empty state', () => {
    renderTab({ ...base, status: 'empty', checks: [] });
    expect(screen.getByText(/no checks for this commit/i)).toBeInTheDocument();
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
