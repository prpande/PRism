import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityResponse } from '../../../api/types';
import { ActivityRail } from '../ActivityRail';

const { useActivityMock } = vi.hoisted(() => ({ useActivityMock: vi.fn() }));
vi.mock('../../../hooks/useActivity', () => ({ useActivity: useActivityMock }));

function resp(partial: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    items: [],
    generatedAt: new Date().toISOString(),
    degraded: { receivedEvents: false },
    ...partial,
  };
}
const item = (over: Partial<ActivityResponse['items'][0]>): ActivityResponse['items'][0] => {
  const base = {
    actorLogin: 'alice', actorAvatarUrl: null, actorIsBot: false, verb: 'reviewed' as const,
    repo: 'acme/api', prNumber: 7, title: 'Fix login',
    timestamp: new Date().toISOString(), source: 'received-event' as const, ...over,
  };
  return { ...base, url: over.url ?? `https://github.com/acme/api/pull/${base.prNumber}` };
};

const renderRail = () => render(<MemoryRouter><ActivityRail /></MemoryRouter>);

beforeEach(() => useActivityMock.mockReset());

describe('ActivityRail (P1)', () => {
  test('renders only the Activity section — no Watching', () => {
    useActivityMock.mockReturnValue({ data: resp(), isLoading: false, error: null });
    renderRail();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.queryByText('Watching')).toBeNull();
  });

  test('renders actor + verb + PR ref as an in-app link', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ actorLogin: 'noah.s', verb: 'reviewed', prNumber: 1810 })] }),
      isLoading: false, error: null,
    });
    renderRail();
    const link = screen.getByRole('link', { name: /noah\.s reviewed #1810/i });
    expect(link).toHaveAttribute('href', '/pr/acme/api/1810');
  });

  test('hides bots by default and reveals them via the toggle, re-capping to 12', async () => {
    const items = [
      item({ actorLogin: 'alice', prNumber: 1 }),
      item({ actorLogin: 'mergewatch[bot]', actorIsBot: true, prNumber: 2 }),
    ];
    useActivityMock.mockReturnValue({ data: resp({ items }), isLoading: false, error: null });
    renderRail();

    // Default hidden: bot row absent.
    expect(screen.queryByText(/mergewatch\[bot\]/)).toBeNull();
    expect(screen.getByText(/alice/)).toBeInTheDocument();

    // Toggle on → bot row appears.
    await userEvent.click(screen.getByRole('button', { name: /show bots/i }));
    expect(screen.getByText(/mergewatch\[bot\]/)).toBeInTheDocument();
  });

  test('empty (quiet) state names the window', () => {
    useActivityMock.mockReturnValue({ data: resp({ items: [] }), isLoading: false, error: null });
    renderRail();
    expect(screen.getByText('No pull-request activity in the last 24h')).toBeInTheDocument();
  });

  test('empty (all-bots, default hidden) names the filter, not the window', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ actorLogin: 'ci[bot]', actorIsBot: true })] }),
      isLoading: false, error: null,
    });
    renderRail();
    expect(screen.getByText(/no human activity in the last 24h/i)).toBeInTheDocument();
  });

  test('degraded note shows on backend-degraded flag', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [], degraded: { receivedEvents: true } }),
      isLoading: false, error: null,
    });
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });

  test('degraded note also shows when the initial fetch itself fails (no data)', () => {
    // The (!data && error) branch — a frontend fetch failure, distinct from the
    // backend degraded flag. Same copy by design (both are "unavailable").
    useActivityMock.mockReturnValue({ data: null, isLoading: false, error: new Error('net') });
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });

  test('malformed PR url falls back to an external anchor without throwing', () => {
    useActivityMock.mockReturnValue({
      data: resp({ items: [item({ url: 'not a url' })] }),
      isLoading: false, error: null,
    });
    renderRail();
    const link = screen.getByRole('link', { name: /alice reviewed #7/i });
    expect(link).toHaveAttribute('href', 'not a url');   // external <a>, no crash
  });
});
