import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Locks the bandwidth guarantee. #507 hoisted useActivity into InboxPage so the
// /api/activity fetch can start in parallel with the inbox fetch on cold load — the hook
// is now called unconditionally (Rules of Hooks) and gated by its `enabled` arg. So the
// guarantee shifts from "the hook is never called when off" to "the hook is called with
// enabled=false when off" — and useActivity's own test proves enabled=false never fetches.
const { activitySpy, showRailRef, inboxLoadingRef } = vi.hoisted(() => ({
  activitySpy: vi.fn(() => ({ data: null, isLoading: false, error: null })),
  showRailRef: { value: false },
  // When true, useInbox is mid-cold-load (data null, isLoading true) — the state in
  // which InboxPage early-returns the skeleton. #507's whole point is that the activity
  // fetch must already be in flight in that state, in parallel with the inbox fetch.
  inboxLoadingRef: { value: false },
}));

vi.mock('../hooks/useActivity', () => ({ useActivity: activitySpy }));
vi.mock('../hooks/useInbox', () => ({
  useInbox: () =>
    inboxLoadingRef.value
      ? { data: null, error: null, isLoading: true, reload: vi.fn() }
      : {
          data: {
            sections: [],
            enrichments: {},
            ciProbeComplete: true,
            tokenScopeFooterEnabled: false,
          },
          error: null,
          isLoading: false,
          reload: vi.fn(),
        },
}));
vi.mock('../hooks/useInboxUpdates', () => ({
  useInboxUpdates: () => ({ announce: '' }),
}));
vi.mock('../hooks/useInboxRefresh', () => ({
  useInboxRefresh: () => ({
    isRefreshing: false,
    justRefreshed: false,
    announce: '',
    refresh: vi.fn(),
  }),
}));
vi.mock('../components/Toast/useToast', () => ({ useToast: () => ({ show: vi.fn() }) }));
vi.mock('../hooks/useAiGate', () => ({ useAiGate: () => false }));
vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => true })); // wide enough for the rail
vi.mock('../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      inbox: {
        defaultSort: 'updated',
        showActivityRail: showRailRef.value,
        groupByRepo: true,
        sectionOrder: 'authored-by-me,review-requested,awaiting-author,mentioned',
      },
    },
  }),
}));
// Stub the heavy inbox children — irrelevant to the rail gate.
vi.mock('../components/Inbox/InboxToolbar', () => ({ InboxToolbar: () => null }));
vi.mock('../components/Inbox/InboxSection', () => ({ InboxSection: () => null }));

import { InboxPage } from './InboxPage';

describe('InboxPage — activity rail gate', () => {
  beforeEach(() => {
    activitySpy.mockClear();
    inboxLoadingRef.value = false;
  });

  it('does NOT mount the rail and calls useActivity(false) when the toggle is off', () => {
    showRailRef.value = false;
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('activity-rail')).toBeNull();
    // Hook is called (it is hoisted + unconditional) but disabled, so it never fetches.
    expect(activitySpy).toHaveBeenCalledWith(false);
  });

  it('mounts the rail and calls useActivity(true) when the toggle is on (wide viewport)', () => {
    showRailRef.value = true;
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('activity-rail')).not.toBeNull();
    expect(activitySpy).toHaveBeenCalledWith(true);
  });

  it('fires useActivity(true) during cold load — while the inbox is still fetching (#507)', () => {
    // The fix: the activity fetch starts in PARALLEL with the inbox fetch, not after it.
    // InboxPage early-returns the skeleton here (inbox data null + isLoading), yet because
    // useActivity is hoisted above that early return it is already enabled and in flight.
    showRailRef.value = true;
    inboxLoadingRef.value = true;
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    // Cold-load skeleton is showing (real tree, incl. the rail, not yet mounted)...
    expect(screen.queryByTestId('activity-rail')).toBeNull();
    // ...but the activity request is already enabled, overlapping the inbox fetch.
    expect(activitySpy).toHaveBeenCalledWith(true);
  });
});
