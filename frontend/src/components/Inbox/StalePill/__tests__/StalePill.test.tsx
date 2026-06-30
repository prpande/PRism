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
  });

  it('is purely visual — carries no live region (the page region owns the announce)', () => {
    // Task 14 / R3-6: the pill dropped its own aria-live so it can't double-announce with
    // InboxPage's `inbox-stale-status` page region in the same render tick.
    render(<StalePill lastRefreshedAt={minsAgo(125)} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
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
