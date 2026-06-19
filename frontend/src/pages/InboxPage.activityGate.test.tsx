import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Locks the bandwidth guarantee: the activity feed is fetched ONLY by useActivity, which
// lives ONLY inside ActivityRail, which mounts ONLY when showActivityRail is on. So when the
// toggle is off the hook must never run — no /api/activity poll, no backend GitHub calls.
const { activitySpy, showRailRef } = vi.hoisted(() => ({
  activitySpy: vi.fn(() => ({ data: null, isLoading: false, error: null })),
  showRailRef: { value: false },
}));

vi.mock('../hooks/useActivity', () => ({ useActivity: activitySpy }));
vi.mock('../hooks/useInbox', () => ({
  useInbox: () => ({
    data: { sections: [], enrichments: {}, ciProbeComplete: true, tokenScopeFooterEnabled: false },
    error: null,
    isLoading: false,
    reload: vi.fn(),
  }),
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
vi.mock('../hooks/useAiGate', () => ({ useAiGate: () => false, useIsSampleMode: () => false }));
vi.mock('../hooks/useMediaQuery', () => ({ useMediaQuery: () => true })); // wide enough for the rail
vi.mock('../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        // onboardingSeen:true suppresses the onboarding overlay so it does not
        // interfere with the rail-gate assertions this file owns.
        onboardingSeen: true,
      },
      inbox: {
        defaultSort: 'updated',
        showActivityRail: showRailRef.value,
        groupByRepo: true,
        sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
      },
    },
  }),
}));
// Stub the heavy inbox children — irrelevant to the rail gate.
vi.mock('../components/Inbox/InboxToolbar', () => ({ InboxToolbar: () => null }));
vi.mock('../components/Inbox/InboxSection', () => ({ InboxSection: () => null }));

import { InboxPage } from './InboxPage';

describe('InboxPage — activity rail gate', () => {
  beforeEach(() => activitySpy.mockClear());

  it('does NOT mount the rail or call useActivity when the toggle is off', () => {
    showRailRef.value = false;
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('activity-rail')).toBeNull();
    expect(activitySpy).not.toHaveBeenCalled();
  });

  it('mounts the rail and calls useActivity when the toggle is on (wide viewport)', () => {
    showRailRef.value = true;
    render(
      <MemoryRouter>
        <InboxPage />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('activity-rail')).not.toBeNull();
    expect(activitySpy).toHaveBeenCalled();
  });
});
