import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { AiFailureToast } from './AiFailureToast';
import type { AiSeam } from './aiFailure';

function setup(over: { seams?: AiSeam[]; retrying?: boolean; anyTimedOut?: boolean } = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <AiFailureToast
        seams={over.seams ?? (['summary', 'file-focus', 'hunk-annotations'] as AiSeam[])}
        retrying={over.retrying ?? false}
        anyTimedOut={over.anyTimedOut ?? false}
        onRetry={onRetry}
        onDismiss={onDismiss}
      />
    </MemoryRouter>,
  );
  return { onRetry, onDismiss };
}

it('lists failed seams using display names', () => {
  setup({ seams: ['summary', 'file-focus', 'hunk-annotations'] });
  expect(screen.getByText(/summary, hotspots, annotations/)).toBeInTheDocument();
});

it('Retry fires onRetry and is enabled when not retrying', () => {
  const { onRetry } = setup({ retrying: false });
  const btn = screen.getByRole('button', { name: 'Retry' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(onRetry).toHaveBeenCalledOnce();
});

it('shows a disabled "Retrying…" button while retrying', () => {
  setup({ retrying: true });
  expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
});

it('Dismiss fires onDismiss', () => {
  const { onDismiss } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledOnce();
});

function LocationProbe() {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}|${JSON.stringify(loc.state)}`}</span>;
}

function renderToast(anyTimedOut: boolean) {
  return render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <Routes>
        <Route
          path="/pr/o/r/1"
          element={
            <AiFailureToast
              seams={['summary']}
              retrying={false}
              anyTimedOut={anyTimedOut}
              onRetry={vi.fn()}
              onDismiss={vi.fn()}
            />
          }
        />
        <Route path="/settings/ai" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AiFailureToast timeout copy', () => {
  it('shows generic copy and no Adjust-timeout when not timed out', () => {
    renderToast(false);
    expect(
      screen.getByText(/the provider failed or timed out|AI couldn't generate/i),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /adjust timeout/i })).toBeNull();
  });

  it('shows timeout copy + Adjust-timeout deep-link when timed out', async () => {
    renderToast(true);
    // Exact string, not /timed out/i — the generic copy ("…the provider failed or timed out.")
    // also contains "timed out", so a loose regex would not distinguish the two branches.
    expect(screen.getByText('AI generation timed out.')).toBeInTheDocument();
    const adjust = screen.getByRole('button', { name: /adjust timeout/i });
    await userEvent.click(adjust);
    // Navigated to /settings/ai with backgroundLocation state (so the PR is not torn down).
    const loc = screen.getByTestId('loc').textContent ?? '';
    expect(loc).toContain('/settings/ai');
    expect(loc).toContain('backgroundLocation');
  });
});
