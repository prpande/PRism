import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';

// Stub PrDetailView so we can read the `active` prop PrTabHost passes it.
vi.mock('../PrDetail/PrDetailView', () => ({
  PrDetailView: ({
    prRef,
    active,
  }: {
    prRef: { owner: string; repo: string; number: number };
    active: boolean;
  }) => (
    <div data-testid={`pr-${prRef.owner}/${prRef.repo}/${prRef.number}`} data-active={String(active)} />
  ),
}));
// Stub the AskAi drawer context with an open drawer + a close spy.
const drawerClose = vi.fn();
vi.mock('../../contexts/AskAiDrawerContext', () => ({
  useAskAiDrawer: () => ({ isOpen: true, close: drawerClose }),
  AskAiDrawerProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { PrTabHost } from '../PrDetail/PrTabHost';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { DrawerEffects } from '../AskAiDrawer/DrawerEffects';

const MODAL_OVER_PR = [
  { pathname: '/settings/appearance', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
];

describe('keep-alive while the Settings modal is open over a PR', () => {
  it('PrTabHost keeps the PR view mounted AND active (no deactivate → no #180 refetch)', () => {
    render(
      <MemoryRouter initialEntries={MODAL_OVER_PR}>
        <OpenTabsProvider>
          <PrTabHost />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    expect(screen.getByTestId('pr-o/r/1')).toHaveAttribute('data-active', 'true');
  });

  it('DrawerEffects does NOT force-close an open Ask-AI drawer', () => {
    drawerClose.mockClear();
    render(
      <MemoryRouter initialEntries={MODAL_OVER_PR}>
        <DrawerEffects />
      </MemoryRouter>,
    );
    expect(drawerClose).not.toHaveBeenCalled();
  });
});
