import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { StalePill } from '../StalePill';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

describe('StalePill', () => {
  it('is absent for a fresh (<30 min) cache', () => {
    render(<StalePill lastRefreshedAt={minsAgo(5)} />);
    expect(screen.queryByTestId('inbox-stale-pill')).not.toBeInTheDocument();
  });

  it('renders "Updated <age>" when older than 30 min', () => {
    render(<StalePill lastRefreshedAt={minsAgo(125)} />);
    const pill = screen.getByTestId('inbox-stale-pill');
    expect(pill).toHaveTextContent(/Updated 2h ago/);
    // Round-3 DES-1: role="status" lives on the always-mounted sr-only LIVE REGION, NOT the visible
    // pill — asserting it on `pill` fails, and adding role to the visible pill would make the ~60s
    // ticker re-announce every tick (defeating the round-2 aria-once design). Assert the live region
    // separately (there is exactly one role="status" element in StalePill — the sr-only span).
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('appears once the ~60s ticker crosses the 30-min threshold', () => {
    render(<StalePill lastRefreshedAt={minsAgo(29)} />);
    expect(screen.queryByTestId('inbox-stale-pill')).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(120_000);
    }); // cross 30 min
    expect(screen.getByTestId('inbox-stale-pill')).toBeInTheDocument();
  });
});
