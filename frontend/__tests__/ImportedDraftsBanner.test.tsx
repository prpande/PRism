import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ImportedDraftsBanner } from '../src/components/PrDetail/ForeignPendingReviewModal/ImportedDraftsBanner';

describe('ImportedDraftsBanner', () => {
  it('renders the count-staleness note when the thread count changed between snapshots', () => {
    render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 2, replyCount: 1 }}
        snapshotB={{ threadCount: 3, replyCount: 1 }}
        hasResolvedImports={false}
      />,
    );
    expect(screen.getByText(/changed during the prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/3 thread\(s\) \/ 1 reply\(ies\) imported/i)).toBeInTheDocument();
    expect(screen.getByText(/you saw 2 \/ 1 in the prompt/i)).toBeInTheDocument();
  });

  it('renders the count-staleness note when only the reply count changed', () => {
    render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 2, replyCount: 0 }}
        snapshotB={{ threadCount: 2, replyCount: 3 }}
        hasResolvedImports={false}
      />,
    );
    expect(screen.getByText(/changed during the prompt/i)).toBeInTheDocument();
  });

  it('renders the IsResolved pre-flight warning when any imported thread is resolved', () => {
    render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 1, replyCount: 0 }}
        snapshotB={{ threadCount: 1, replyCount: 0 }}
        hasResolvedImports
      />,
    );
    expect(screen.getByText(/were resolved on github\.com/i)).toBeInTheDocument();
    expect(screen.getByText(/will re-publish them/i)).toBeInTheDocument();
  });

  it('renders both notes when counts drifted AND a thread is resolved', () => {
    render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 1, replyCount: 0 }}
        snapshotB={{ threadCount: 2, replyCount: 0 }}
        hasResolvedImports
      />,
    );
    expect(screen.getByText(/changed during the prompt/i)).toBeInTheDocument();
    expect(screen.getByText(/were resolved on github\.com/i)).toBeInTheDocument();
  });

  it('renders nothing when counts match and no imported thread is resolved', () => {
    const { container } = render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 1, replyCount: 2 }}
        snapshotB={{ threadCount: 1, replyCount: 2 }}
        hasResolvedImports={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('is an aria-live region so the staleness note is announced when it appears', () => {
    render(
      <ImportedDraftsBanner
        snapshotA={{ threadCount: 1, replyCount: 0 }}
        snapshotB={{ threadCount: 2, replyCount: 0 }}
        hasResolvedImports={false}
      />,
    );
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });
});
