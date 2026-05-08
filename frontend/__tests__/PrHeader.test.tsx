import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PrHeader } from '../src/components/PrDetail/PrHeader';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const baseProps = {
  reference: ref,
  title: 'Refactor the renewal worker',
  author: 'amelia.cho',
  activeTab: 'overview' as const,
  onTabChange: vi.fn(),
};

describe('PrHeader', () => {
  it('renders the PR title', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText('Refactor the renewal worker')).toBeInTheDocument();
  });

  it('renders repo and number from the reference', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText(/octocat\/hello/i)).toBeInTheDocument();
    expect(screen.getByText(/#42/i)).toBeInTheDocument();
  });

  it('renders the author', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText(/amelia\.cho/i)).toBeInTheDocument();
  });

  it('renders branch info when provided', () => {
    render(
      <PrHeader
        {...baseProps}
        branchInfo={{ headBranch: 'amelia/work', baseBranch: 'main' }}
      />,
    );
    expect(screen.getByText(/amelia\/work/i)).toBeInTheDocument();
    expect(screen.getByText(/main/i)).toBeInTheDocument();
  });

  it('does not render branch info chip when branchInfo absent', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('renders mergeability chip when provided', () => {
    render(<PrHeader {...baseProps} mergeability="mergeable" />);
    expect(screen.getByText(/mergeable/i)).toBeInTheDocument();
  });

  it('renders CI chip when ciSummary provided', () => {
    render(<PrHeader {...baseProps} ciSummary="success" />);
    expect(screen.getByText(/success/i)).toBeInTheDocument();
  });

  it('Submit button is rendered and disabled (PoC)', () => {
    render(<PrHeader {...baseProps} />);
    const submit = screen.getByRole('button', { name: /submit review/i });
    expect(submit).toBeDisabled();
  });

  it('renders the PrSubTabStrip with the activeTab prop', () => {
    render(<PrHeader {...baseProps} activeTab="files" />);
    const filesTab = screen.getByRole('tab', { name: /files/i });
    expect(filesTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders the PrSubTabStrip with fileCount when provided', () => {
    render(<PrHeader {...baseProps} fileCount={5} />);
    const filesTab = screen.getByRole('tab', { name: /files/i });
    expect(filesTab.textContent).toMatch(/5/);
  });
});
