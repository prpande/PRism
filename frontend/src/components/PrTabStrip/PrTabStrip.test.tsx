import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { PrTabStrip } from './PrTabStrip';
import { useEffect } from 'react';

vi.mock('../../hooks/useSubmitInFlight', () => ({
  useSubmitInFlight: vi.fn(() => ({ inFlight: false, prRef: null })),
}));

import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';

function Seed({ count }: { count: number }) {
  const { addTab } = useOpenTabs();
  useEffect(() => {
    for (let i = 1; i <= count; i++) {
      addTab({ owner: 'acme', repo: 'api', number: i }, `Title ${i}`);
    }
  }, [addTab, count]);
  return null;
}

function wrap(ui: React.ReactNode) {
  return (
    <MemoryRouter>
      <OpenTabsProvider>{ui}</OpenTabsProvider>
    </MemoryRouter>
  );
}

describe('PrTabStrip', () => {
  it('renders nothing when openTabs is empty', () => {
    const { container } = render(wrap(<PrTabStrip />));
    expect(container.querySelector('[data-testid="pr-tabstrip"]')).toBeNull();
  });

  it('renders one tab per openTab and shows #NNNN prefix', () => {
    render(
      wrap(
        <>
          <Seed count={3} />
          <PrTabStrip />
        </>,
      ),
    );
    const strip = screen.getByTestId('pr-tabstrip');
    expect(strip).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
    expect(screen.getByText('#1')).toBeInTheDocument();
    expect(screen.getByText('Title 1')).toBeInTheDocument();
  });

  it('falls back to "owner/repo#NNNN" when title is null', () => {
    function SeedNullTitle() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 42 }, null);
      }, [addTab]);
      return null;
    }
    render(
      wrap(
        <>
          <SeedNullTitle />
          <PrTabStrip />
        </>,
      ),
    );
    const tab = screen.getByRole('tab', { name: /acme\/api#42/i });
    expect(tab).toBeInTheDocument();
  });

  it('marks the matching tab active when on a nested PR route', () => {
    function Seed() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 99 }, 'Match me');
      }, [addTab]);
      return null;
    }
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/99/files']}>
        <OpenTabsProvider>
          <Seed />
          <PrTabStrip />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    const tab = screen.getByRole('tab', { name: /Match me/i });
    expect(tab).toHaveAttribute('aria-selected', 'true');
  });

  it('applies the unread modifier class when a tab is in unreadKeys', () => {
    function Seed() {
      const { addTab, markUnread } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 5 }, 'Has unread');
        markUnread('acme/api/5');
      }, [addTab, markUnread]);
      return null;
    }
    render(
      wrap(
        <>
          <Seed />
          <PrTabStrip />
        </>,
      ),
    );
    const tab = screen.getByRole('tab', { name: /Has unread/i });
    // CSS-module class names are hashed; assert via partial class match.
    expect(tab.className).toMatch(/tabUnread/);
  });
});

describe('PrTabStrip close affordance', () => {
  it('clicking × removes the tab from openTabs', async () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: false, prRef: null });
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
        addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const tab1 = screen.getByRole('tab', { name: /A/i });
    const close1 = tab1.querySelector('[aria-label="Close tab"]') as HTMLElement;
    expect(close1).not.toBeNull();
    await userEvent.click(close1);
    expect(screen.queryByRole('tab', { name: /A/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /B/i })).toBeInTheDocument();
  });

  it('middle-click on a tab closes it', () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: false, prRef: null });
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const tab = screen.getByRole('tab', { name: /A/i });
    fireEvent.mouseDown(tab, { button: 1 });
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('close button is disabled when submit is in flight for that tab', () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: true, prRef: 'acme/api/1' });
    function Harness() {
      const { addTab } = useOpenTabs();
      useEffect(() => {
        addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
        addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
      }, [addTab]);
      return <PrTabStrip />;
    }
    render(wrap(<Harness />));
    const closeA = screen
      .getByRole('tab', { name: /A/i })
      .querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    const closeB = screen
      .getByRole('tab', { name: /B/i })
      .querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    expect(closeA).toBeDisabled();
    expect(closeA.getAttribute('title')).toMatch(/submit in progress/i);
    expect(closeB).not.toBeDisabled();
  });
});
