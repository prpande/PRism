import { describe, test, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';

// Stub InboxPage so these tests assert HOST behavior (lazy mount, hide-not-
// unmount, the `active` prop) independent of the page's data hooks. The stub
// surfaces the `active` prop it receives and a stable DOM node we can identity-
// check across navigation to prove the host hides (never remounts) the page.
vi.mock('../../pages/InboxPage', () => ({
  InboxPage: ({ active, revalidateNonce }: { active?: boolean; revalidateNonce?: number }) => (
    <div
      data-testid="inbox-page"
      data-active={String(active)}
      data-nonce={String(revalidateNonce)}
    />
  ),
}));

import { InboxHost } from './InboxHost';

let navigateRef: ((to: string) => void) | null = null;
function NavProbe() {
  navigateRef = useNavigate();
  return null;
}

function renderHostAt(entry: string | { pathname: string; state?: unknown }) {
  navigateRef = null;
  render(
    <MemoryRouter initialEntries={[entry as never]}>
      <NavProbe />
      {/* a real scroller for useTabScrollMemory to query (no-op in jsdom layout) */}
      <div data-app-scroll>
        <InboxHost />
      </div>
    </MemoryRouter>,
  );
  return { navigate: (to: string) => act(() => navigateRef!(to)) };
}

describe('InboxHost', () => {
  test('renders the Inbox visible and active on /', () => {
    renderHostAt('/');
    const page = screen.getByTestId('inbox-page');
    expect(page).toBeVisible();
    expect(page).toHaveAttribute('data-active', 'true');
  });

  test('hides (not unmounts) the Inbox on a PR route, passing active=false', () => {
    const { navigate } = renderHostAt('/');
    const before = screen.getByTestId('inbox-page');
    expect(before).toBeVisible();

    navigate('/pr/acme/api/7');
    const after = screen.getByTestId('inbox-page');
    // Same DOM node → the page was hidden, never remounted (state survives).
    expect(after).toBe(before);
    expect(after).toBeInTheDocument();
    expect(after).not.toBeVisible(); // wrapped in [hidden]
    expect(after).toHaveAttribute('data-active', 'false');

    navigate('/');
    expect(screen.getByTestId('inbox-page')).toBe(before); // re-shown, still the same node
    expect(screen.getByTestId('inbox-page')).toBeVisible();
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-active', 'true');
  });

  test('lazy mount: a cold /pr deep-link does not mount the Inbox until first / visit', () => {
    const { navigate } = renderHostAt('/pr/acme/api/7');
    // Not on the Inbox and never visited → page is not mounted (no Inbox fetch).
    expect(screen.queryByTestId('inbox-page')).not.toBeInTheDocument();

    navigate('/');
    const mounted = screen.getByTestId('inbox-page');
    expect(mounted).toBeVisible();

    // Now keep-alive: navigating away keeps the same node mounted-but-hidden.
    navigate('/pr/acme/api/7');
    expect(screen.getByTestId('inbox-page')).toBe(mounted);
    expect(screen.getByTestId('inbox-page')).not.toBeVisible();
  });

  test('bumps revalidateNonce each time the Inbox becomes visible (return-to-inbox) — #713', () => {
    // The nonce is the primary return-refetch trigger: it increments on every
    // onInbox false→true edge so InboxPage reloads on return (the mount fetch covers
    // the initial visit, so the first paint stays at 0 — no double-fetch on cold load).
    const { navigate } = renderHostAt('/');
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-nonce', '0');

    navigate('/pr/acme/api/7'); // hidden — no bump
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-nonce', '0');

    navigate('/'); // first return — bump to 1
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-nonce', '1');

    navigate('/pr/acme/api/7');
    navigate('/'); // second return — bump to 2
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-nonce', '2');
  });

  test('stays visible when a Settings modal sits over the Inbox (effective location)', () => {
    // A Settings modal whose background is the Inbox keeps the effective path at
    // '/', so the Inbox stays visible behind the scrim (mirrors PrTabHost).
    renderHostAt({
      pathname: '/settings/appearance',
      state: { backgroundLocation: { pathname: '/' } },
    });
    expect(screen.getByTestId('inbox-page')).toBeVisible();
    expect(screen.getByTestId('inbox-page')).toHaveAttribute('data-active', 'true');
  });

  test('is hidden when a Settings modal sits over a PR (effective location)', () => {
    renderHostAt({
      pathname: '/settings/appearance',
      state: { backgroundLocation: { pathname: '/pr/acme/api/7' } },
    });
    // Effective path is the PR → the Inbox must not mount eagerly (lazy) here.
    expect(screen.queryByTestId('inbox-page')).not.toBeInTheDocument();
  });
});
