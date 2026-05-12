import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscardAllDraftsButton } from '../src/components/PrDetail/DiscardAllDraftsButton';
import type { ReviewSessionDto } from '../src/api/types';

function session(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftSummaryMarkdown: null,
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
    ...overrides,
  };
}

const withDrafts = session({
  draftComments: [{ id: 'd1' } as never, { id: 'd2' } as never],
  draftReplies: [{ id: 'r1' } as never],
});

const originalMatchMedia = window.matchMedia;
beforeEach(() => {
  // Default: not narrow.
  window.matchMedia = ((q: string) =>
    ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
});
afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe('DiscardAllDraftsButton', () => {
  it('renders nothing on an open PR even with session content', () => {
    const { container } = render(
      <DiscardAllDraftsButton prState="open" session={withDrafts} onDiscard={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a closed PR with an empty session', () => {
    const { container } = render(
      <DiscardAllDraftsButton prState="closed" session={session()} onDiscard={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders on a closed PR when the session has content', () => {
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button', { name: /discard all drafts/i })).toBeInTheDocument();
  });

  it('renders on a merged PR with only a pending review id (no drafts)', () => {
    render(
      <DiscardAllDraftsButton
        prState="merged"
        session={session({ pendingReviewId: 'PRR_z' })}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /discard all drafts/i })).toBeInTheDocument();
  });

  it('renders on a closed PR with only a non-empty summary', () => {
    render(
      <DiscardAllDraftsButton
        prState="closed"
        session={session({ draftSummaryMarkdown: 'LGTM' })}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: /discard all drafts/i })).toBeInTheDocument();
  });

  it('uses the btn-danger btn-sm vocabulary', () => {
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={vi.fn()} />);
    const btn = screen.getByRole('button', { name: /discard all drafts/i });
    expect(btn.className).toMatch(/btn-danger/);
    expect(btn.className).toMatch(/btn-sm/);
  });

  it('label shortens to "Discard" at < 600px viewport', () => {
    window.matchMedia = ((q: string) =>
      ({
        matches: q.includes('599'),
        media: q,
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={vi.fn()} />);
    expect(screen.getByRole('button')).toHaveTextContent(/^Discard$/);
  });

  it('click opens the confirmation modal with the count', () => {
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /discard all drafts/i }));
    expect(screen.getByText(/discard 2 draft.+1 repl/i)).toBeInTheDocument();
  });

  it('confirming the modal fires onDiscard', () => {
    const onDiscard = vi.fn();
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: /discard all drafts/i }));
    fireEvent.click(screen.getByRole('button', { name: /^discard all$/i }));
    expect(onDiscard).toHaveBeenCalled();
  });

  it('cancelling the modal does not fire onDiscard', () => {
    const onDiscard = vi.fn();
    render(<DiscardAllDraftsButton prState="closed" session={withDrafts} onDiscard={onDiscard} />);
    fireEvent.click(screen.getByRole('button', { name: /discard all drafts/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onDiscard).not.toHaveBeenCalled();
  });
});
