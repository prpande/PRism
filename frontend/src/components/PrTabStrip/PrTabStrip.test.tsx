import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider, useOpenTabs } from '../../contexts/OpenTabsContext';
import { PrTabStrip } from './PrTabStrip';
import { useEffect } from 'react';

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
});
