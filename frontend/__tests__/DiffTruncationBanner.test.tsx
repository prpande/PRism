import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffTruncationBanner } from '../src/components/PrDetail/FilesTab/DiffPane/DiffTruncationBanner';

describe('DiffTruncationBanner', () => {
  it('links to the host-correct htmlUrl with a host-agnostic label', () => {
    render(<DiffTruncationBanner htmlUrl="https://github.example.com/acme/api/pull/123" />);
    const link = screen.getByRole('link', { name: /open on github/i });
    expect(link).toHaveAttribute('href', 'https://github.example.com/acme/api/pull/123');
    expect(link).toHaveTextContent('Open on GitHub');
    expect(screen.queryByText(/github\.com/)).toBeNull();
  });

  it('omits the link when htmlUrl is absent', () => {
    render(<DiffTruncationBanner htmlUrl={undefined} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByTestId('diff-truncation-banner')).toBeInTheDocument();
  });
});
