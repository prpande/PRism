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
  it('shows skeletons for title/author/chips while loading, but keeps the real breadcrumb', () => {
    renderHeader({ loading: true });
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByTestId('pr-header-title-skeleton')).toBeInTheDocument();
    // Author avatar + the two CI/mergeability chip placeholders also render.
    expect(screen.getByTestId('pr-header-author-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('pr-header-chip-skeleton')).toHaveLength(2);
  });

  it('gives the heading an accessible name while loading (no empty <h1> for AT)', () => {
    renderHeader({ loading: true });
    // The skeleton is aria-hidden, so the sr-only label is what names the heading.
    expect(
      screen.getByRole('heading', { level: 1, name: /loading pull request/i }),
    ).toBeInTheDocument();
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

describe('PrHeader mergeability chip', () => {
  it('renders the chip for a concrete mergeability state', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'mergeable' });
    const chip = container.querySelector('.chip-mergeability');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent('mergeable');
  });

  it('renders the chip for conflicting', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'conflicting' });
    expect(container.querySelector('.chip-mergeability')).not.toBeNull();
  });

  // GitHub returns "unknown" as its not-yet-computed / indeterminate sentinel.
  // It carries no actionable meaning, so the chip is suppressed (Truthful-by-default).
  // Two code paths feed Pr.Mergeability with different casing: the REST poll snapshot
  // emits lowercase mergeable_state ("unknown"); the GraphQL load emits uppercase
  // ("UNKNOWN"). The guard must catch both.
  it('hides the chip when mergeability is unknown (lowercase REST poll value)', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'unknown' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });

  it('hides the chip when mergeability is UNKNOWN (uppercase GraphQL value)', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'UNKNOWN' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });
});
