import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
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

  it('close button is a sibling of the role=tab element (not a child) — D82/D92 a11y lift', () => {
    render(
      wrap(
        <>
          <Seed count={1} />
          <PrTabStrip />
        </>,
      ),
    );
    const tab = screen.getByRole('tab');
    const closeBtn = screen.getByRole('button', { name: /close tab/i });
    // The close button must NOT be a descendant of the role="tab" element.
    // WAI-ARIA forbids nested interactives (axe-core nested-interactive rule).
    expect(tab.contains(closeBtn)).toBe(false);
    // Both must share a parent wrapper (the .tab class wrapper after the D92 lift).
    expect(tab.parentElement).not.toBeNull();
    expect(tab.parentElement!.contains(closeBtn)).toBe(true);
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
    // Post-D92 lift: `.tabUnread` lives on the outer wrapper (parent of role="tab").
    expect(tab.parentElement!.className).toMatch(/tabUnread/);
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
    // Post-D92 lift: close button is a SIBLING of role="tab", under the wrapper.
    const close1 = tab1.parentElement!.querySelector('[aria-label="Close tab"]') as HTMLElement;
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
    // Post-D92 lift: close button is a SIBLING of role="tab", under the wrapper.
    const closeA = screen
      .getByRole('tab', { name: /A/i })
      .parentElement!.querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    const closeB = screen
      .getByRole('tab', { name: /B/i })
      .parentElement!.querySelector('[aria-label="Close tab"]') as HTMLButtonElement;
    expect(closeA).toBeDisabled();
    expect(closeA.getAttribute('title')).toMatch(/submit in progress/i);
    expect(closeB).not.toBeDisabled();
  });
});

describe('PrTabStrip overflow menu', () => {
  function Seed7() {
    const { addTab } = useOpenTabs();
    useEffect(() => {
      for (let i = 1; i <= 7; i++) {
        addTab({ owner: 'acme', repo: 'api', number: i }, `T${i}`);
      }
    }, [addTab]);
    return null;
  }

  beforeEach(() => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: false, prRef: null });
  });

  it('shows + N more chevron when openTabs.length > 6', () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    expect(screen.getByRole('button', { name: /show 1 more/i })).toBeInTheDocument();
  });

  it('inline tabs are the first 6; menu holds the rest', async () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(6);
    // Post-D92 lift: `data-prref` lives on the outer wrapper (parent of role="tab").
    expect(tabs[5].parentElement!.getAttribute('data-prref')).toBe('acme/api/6');
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    const items = screen.getAllByRole('menuitem');
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent('T7');
  });

  it('menu item close removes the overflowed tab without navigating', async () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    const closeBtn = screen.getByLabelText('Close T7');
    await userEvent.click(closeBtn);
    expect(screen.queryByRole('button', { name: /show 1 more/i })).toBeNull();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
  });

  it('clicking outside the overflow menu closes it', async () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
          <div data-testid="outside">Outside</div>
        </>,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('Escape closes the overflow menu', async () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('menu auto-closes when the last overflowed tab is closed via the menu', async () => {
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Close T7'));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.queryByRole('button', { name: /show 1 more/i })).toBeNull();
  });

  it('disabled close in overflow menu when submit is in flight', async () => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: true, prRef: 'acme/api/7' });
    render(
      wrap(
        <>
          <Seed7 />
          <PrTabStrip />
        </>,
      ),
    );
    await userEvent.click(screen.getByRole('button', { name: /show 1 more/i }));
    const closeT7 = screen.getByLabelText('Close T7') as HTMLButtonElement;
    expect(closeT7).toBeDisabled();
    expect(closeT7.getAttribute('title')).toMatch(/submit in progress/i);
  });
});

describe('PrTabStrip close navigation', () => {
  beforeEach(() => {
    vi.mocked(useSubmitInFlight).mockReturnValue({ inFlight: false, prRef: null });
  });

  // LocationProbe: reads the current pathname into a data-testid so tests
  // can assert post-close routing.
  function LocationProbe() {
    const loc = useLocation();
    return <div data-testid="path">{loc.pathname}</div>;
  }

  function SeedTwo() {
    const { addTab } = useOpenTabs();
    useEffect(() => {
      addTab({ owner: 'acme', repo: 'api', number: 1 }, 'A');
      addTab({ owner: 'acme', repo: 'api', number: 2 }, 'B');
    }, [addTab]);
    return null;
  }

  function SeedOne() {
    const { addTab } = useOpenTabs();
    useEffect(() => {
      addTab({ owner: 'acme', repo: 'api', number: 1 }, 'Solo');
    }, [addTab]);
    return null;
  }

  it('closing the active tab navigates to the left neighbour', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/2']}>
        <OpenTabsProvider>
          <SeedTwo />
          <PrTabStrip />
          <LocationProbe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // Post-D92 lift: close button is a SIBLING of role="tab", under the wrapper.
    const closeB = screen
      .getByRole('tab', { name: /B/i })
      .parentElement!.querySelector('[aria-label="Close tab"]') as HTMLElement;
    await userEvent.click(closeB);
    expect(screen.getByTestId('path').textContent).toBe('/pr/acme/api/1');
  });

  it('closing the first active tab navigates to the next remaining tab', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <SeedTwo />
          <PrTabStrip />
          <LocationProbe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // Post-D92 lift: close button is a SIBLING of role="tab", under the wrapper.
    const closeA = screen
      .getByRole('tab', { name: /A/i })
      .parentElement!.querySelector('[aria-label="Close tab"]') as HTMLElement;
    await userEvent.click(closeA);
    expect(screen.getByTestId('path').textContent).toBe('/pr/acme/api/2');
  });

  it('closing the only tab navigates to /', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/acme/api/1']}>
        <OpenTabsProvider>
          <SeedOne />
          <PrTabStrip />
          <LocationProbe />
        </OpenTabsProvider>
      </MemoryRouter>,
    );
    // Post-D92 lift: close button is a SIBLING of role="tab", under the wrapper.
    const close = screen
      .getByRole('tab', { name: /Solo/i })
      .parentElement!.querySelector('[aria-label="Close tab"]') as HTMLElement;
    await userEvent.click(close);
    expect(screen.getByTestId('path').textContent).toBe('/');
  });
});
