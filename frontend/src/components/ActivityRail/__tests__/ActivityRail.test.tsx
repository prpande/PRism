import { describe, test, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ActivityResponse } from '../../../api/types';
import type { UseActivityResult } from '../../../hooks/useActivity';
import { ActivityRail } from '../ActivityRail';

// #507 — ActivityRail is now presentational: it takes { data, isLoading, error } as
// props (the fetch was hoisted to InboxPage). Each test sets `railProps`, and renderRail
// spreads it in — replacing the previous useActivity mock.
let railProps: UseActivityResult = { data: null, isLoading: false, error: null };

function resp(partial: Partial<ActivityResponse> = {}): ActivityResponse {
  return {
    items: [],
    generatedAt: new Date().toISOString(),
    degraded: { receivedEvents: false, notifications: false, watching: false },
    watching: [],
    stale: false,
    ...partial,
  };
}
const item = (over: Partial<ActivityResponse['items'][0]>): ActivityResponse['items'][0] => {
  const base = {
    actorLogin: 'alice',
    actorAvatarUrl: null,
    actorIsBot: false,
    verb: 'reviewed' as const,
    repo: 'acme/api',
    prNumber: 7,
    title: 'Fix login',
    timestamp: new Date().toISOString(),
    source: 'received-event' as const,
    ...over,
  };
  return { ...base, url: over.url ?? `https://github.com/acme/api/pull/${base.prNumber}` };
};

const renderRail = () =>
  render(
    <MemoryRouter>
      <ActivityRail {...railProps} />
    </MemoryRouter>,
  );

beforeEach(() => {
  railProps = { data: null, isLoading: false, error: null };
});

describe('ActivityRail (P1)', () => {
  test('renders only the Activity section — no Watching', () => {
    railProps = { data: resp(), isLoading: false, error: null };
    renderRail();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.queryByText('Watching')).toBeNull();
  });

  test('renders actor + verb + PR ref as an in-app link', () => {
    railProps = {
      data: resp({ items: [item({ actorLogin: 'noah.s', verb: 'reviewed', prNumber: 1810 })] }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /noah\.s reviewed #1810/i });
    expect(link).toHaveAttribute('href', '/pr/acme/api/1810');
  });

  test('hides bots by default and reveals them via the toggle', async () => {
    const items = [
      item({ actorLogin: 'alice', prNumber: 1 }),
      item({ actorLogin: 'mergewatch[bot]', actorIsBot: true, prNumber: 2 }),
    ];
    railProps = { data: resp({ items }), isLoading: false, error: null };
    renderRail();

    // Default hidden: bot row absent.
    expect(screen.queryByText(/mergewatch\[bot\]/)).toBeNull();
    expect(screen.getByText(/alice/)).toBeInTheDocument();

    // Toggle on → bot row appears.
    await userEvent.click(screen.getByRole('button', { name: /show bots/i }));
    expect(screen.getByText(/mergewatch\[bot\]/)).toBeInTheDocument();
  });

  test('empty (quiet) state names the window', () => {
    railProps = { data: resp({ items: [] }), isLoading: false, error: null };
    renderRail();
    expect(screen.getByText('No pull-request activity in the last 24h')).toBeInTheDocument();
  });

  test('empty (all-bots, default hidden) names the filter, not the window', () => {
    railProps = {
      data: resp({ items: [item({ actorLogin: 'ci[bot]', actorIsBot: true })] }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText(/no human activity in the last 24h/i)).toBeInTheDocument();
  });

  test('degraded note shows on backend-degraded flag', () => {
    railProps = {
      data: resp({
        items: [],
        degraded: { receivedEvents: true, notifications: false, watching: false },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });

  test('degraded note also shows when the initial fetch itself fails (no data)', () => {
    // The (!data && error) branch — a frontend fetch failure, distinct from the
    // backend degraded flag. Same copy by design (both are "unavailable").
    railProps = { data: null, isLoading: false, error: new Error('net') };
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });

  test('malformed PR url falls back to an external anchor without throwing', () => {
    railProps = {
      data: resp({ items: [item({ url: 'not a url' })] }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /alice reviewed #7/i });
    expect(link).toHaveAttribute('href', 'not a url'); // external <a>, no crash
  });
});

describe('ActivityRail (P2) — actorless phrasing', () => {
  test('actorless review-requested → "Review requested on #N", no actor, no null', () => {
    railProps = {
      data: resp({
        items: [
          item({
            actorLogin: null,
            actorAvatarUrl: null,
            verb: 'review-requested',
            prNumber: 1842,
            source: 'notification',
          }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /review requested on #1842/i });
    expect(link.getAttribute('aria-label')).not.toMatch(/null/);
  });

  test('actorless mentioned → "You were mentioned in #N"', () => {
    railProps = {
      data: resp({
        items: [
          item({ actorLogin: null, verb: 'mentioned', prNumber: 99, source: 'notification' }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /you were mentioned in #99/i });
    expect(link.getAttribute('aria-label')).not.toMatch(/null/);
  });

  test('standalone actorless commented row → "New comment on #N"', () => {
    railProps = {
      data: resp({
        items: [
          item({ actorLogin: null, verb: 'commented', prNumber: 55, source: 'notification' }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /new comment on #55/i });
    expect(link.getAttribute('aria-label')).not.toMatch(/null/);
  });

  test('actorless other → generic fallback "New update on #N", never a dangling fragment/null', () => {
    railProps = {
      data: resp({
        items: [item({ actorLogin: null, verb: 'other', prNumber: 12, source: 'notification' })],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /new update on #12/i });
    expect(link.getAttribute('aria-label')).not.toMatch(/null/);
  });

  test('enriched notification row renders actor + resolved action ("dave approved #N")', () => {
    railProps = {
      data: resp({
        items: [
          item({ actorLogin: 'dave', verb: 'approved', prNumber: 88, source: 'notification' }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByRole('link', { name: /dave approved #88/i })).toBeInTheDocument();
  });

  test('actorless opened → "Opened #N", never null', () => {
    railProps = {
      data: resp({
        items: [item({ actorLogin: null, verb: 'opened', prNumber: 34, source: 'notification' })],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const link = screen.getByRole('link', { name: /opened #34/i });
    expect(link.getAttribute('aria-label')).not.toMatch(/null/);
  });
});

describe('ActivityRail (P2) — landmarks', () => {
  test('Activity section is a named region landmark', () => {
    railProps = {
      data: resp({ items: [item({})] }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByRole('region', { name: /activity/i })).toBeInTheDocument();
  });

  test('Watching section is a named region landmark when present', () => {
    railProps = {
      data: resp({
        watching: [{ repo: 'acme/api', count: 3, url: 'https://github.com/acme/api' }],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByRole('region', { name: /watching/i })).toBeInTheDocument();
  });
});

describe('ActivityRail (P2) — split degraded gating', () => {
  test('watching-only degraded with items present → Activity list still renders (NOT unavailable)', () => {
    railProps = {
      data: resp({
        items: [item({ actorLogin: 'alice', verb: 'reviewed', prNumber: 7 })],
        degraded: { receivedEvents: false, notifications: false, watching: true },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.queryByText('Activity unavailable')).toBeNull();
    expect(screen.getByRole('link', { name: /alice reviewed #7/i })).toBeInTheDocument();
  });

  test('receivedEvents degraded → Activity unavailable note shows', () => {
    railProps = {
      data: resp({
        items: [item({})],
        degraded: { receivedEvents: true, notifications: false, watching: false },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });

  test('notifications degraded → Activity unavailable note shows', () => {
    railProps = {
      data: resp({
        items: [item({})],
        degraded: { receivedEvents: false, notifications: true, watching: false },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText('Activity unavailable')).toBeInTheDocument();
  });
});

describe('ActivityRail (P2) — Watching section + states', () => {
  test('renders watching rows with repo + count and external link/aria-label', () => {
    railProps = {
      data: resp({
        watching: [{ repo: 'acme/api', count: 3, url: 'https://github.com/acme/api' }],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText('Watching')).toBeInTheDocument();
    // Owner is stripped for the accessible name (display = short repo "api").
    const link = screen.getByRole('link', { name: /api — 3 recent items, opens on github/i });
    expect(link).toHaveAttribute('href', 'https://github.com/acme/api');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
  });

  test('single recent item uses singular "item" in aria-label', () => {
    railProps = {
      data: resp({
        watching: [{ repo: 'acme/api', count: 1, url: 'https://github.com/acme/api' }],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(
      screen.getByRole('link', { name: /api — 1 recent item, opens on github/i }),
    ).toBeInTheDocument();
  });

  test('idle (count 0) watching row uses no-recent-activity aria-label', () => {
    railProps = {
      data: resp({
        watching: [{ repo: 'acme/api', count: 0, url: 'https://github.com/acme/api' }],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(
      screen.getByRole('link', { name: /api — no recent activity, opens on github/i }),
    ).toBeInTheDocument();
  });

  test('Watching absent when empty and not degraded', () => {
    railProps = {
      data: resp({
        watching: [],
        degraded: { receivedEvents: false, notifications: false, watching: false },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.queryByText('Watching')).toBeNull();
    expect(screen.queryByText(/subscription/i)).toBeNull();
  });

  test('Watching empty + degraded → header omitted, inline note shown', () => {
    railProps = {
      data: resp({
        watching: [],
        degraded: { receivedEvents: false, notifications: false, watching: true },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.queryByText('Watching')).toBeNull();
    expect(
      screen.getByText(/subscription list (is|may be)|watch.*unavailable|subscription/i),
    ).toBeInTheDocument();
  });

  test('Watching items + degraded → rows render PLUS incomplete note below', () => {
    railProps = {
      data: resp({
        watching: [{ repo: 'acme/api', count: 2, url: 'https://github.com/acme/api' }],
        degraded: { receivedEvents: false, notifications: false, watching: true },
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: /api — 2 recent items, opens on github/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/subscription list may be incomplete/i)).toBeInTheDocument();
  });
});

describe('ActivityRail (P2) — server order + external routing', () => {
  test('server order is preserved (no client re-sort by timestamp)', () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const newer = new Date().toISOString();
    // Input is intentionally NOT timestamp-sorted: older first, newer second.
    railProps = {
      data: resp({
        items: [
          item({ actorLogin: 'first', prNumber: 100, timestamp: older }),
          item({ actorLogin: 'second', prNumber: 200, timestamp: newer }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const links = screen.getAllByRole('link');
    expect(links[0].getAttribute('aria-label')).toMatch(/first/);
    expect(links[1].getAttribute('aria-label')).toMatch(/second/);
  });

  test('non-PR notification url → external <a>; in-app PR url → <Link>', () => {
    railProps = {
      data: resp({
        items: [
          item({
            actorLogin: null,
            verb: 'mentioned',
            prNumber: 5,
            source: 'notification',
            url: 'https://github.com/notifications',
          }),
          item({ actorLogin: 'alice', verb: 'reviewed', prNumber: 7 }),
        ],
      }),
      isLoading: false,
      error: null,
    };
    renderRail();
    const external = screen.getByRole('link', { name: /you were mentioned in #5/i });
    expect(external).toHaveAttribute('href', 'https://github.com/notifications');
    expect(external).toHaveAttribute('target', '_blank');
    const internal = screen.getByRole('link', { name: /alice reviewed #7/i });
    expect(internal).toHaveAttribute('href', '/pr/acme/api/7');
    expect(internal).not.toHaveAttribute('target');
  });
});
