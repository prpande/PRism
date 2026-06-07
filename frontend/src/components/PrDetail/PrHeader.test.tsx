import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrHeader } from './PrHeader';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';

function renderHeader(extra: Partial<React.ComponentProps<typeof PrHeader>> = {}) {
  return render(
    <MemoryRouter>
      <AskAiDrawerProvider>
        <PrHeader
          reference={{ owner: 'acme', repo: 'api', number: 7 }}
          title=""
          author=""
          activeTab="overview"
          onTabChange={() => {}}
          {...extra}
        />
      </AskAiDrawerProvider>
    </MemoryRouter>,
  );
}

describe('PrHeader loading', () => {
  it('shows skeletons for title/author while loading, but keeps the real breadcrumb', () => {
    renderHeader({ loading: true });
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByTestId('pr-header-title-skeleton')).toBeInTheDocument();
  });

  it('renders no action buttons or collapse toggle while loading (no clicks before load)', () => {
    renderHeader({ loading: true });
    // The Submit-review action and the header-collapse toggle are real,
    // state-dependent buttons — they must not render in the loading state.
    expect(screen.queryByRole('button', { name: /submit review/i })).toBeNull();
    expect(screen.queryByTestId('pr-header-collapse-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: /open in github/i })).toBeNull();
  });

  it('renders the real (empty) title element + the collapse toggle when not loading', () => {
    renderHeader({ loading: false, title: 'Real title' });
    expect(screen.queryByTestId('pr-header-title-skeleton')).toBeNull();
    expect(screen.getByText('Real title')).toBeInTheDocument();
    expect(screen.getByTestId('pr-header-collapse-toggle')).toBeInTheDocument();
  });
});
