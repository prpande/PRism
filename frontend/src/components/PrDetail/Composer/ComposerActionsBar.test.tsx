import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ComposerActionsBar } from './ComposerActionsBar';

const baseProps = {
  previewMode: false,
  onTogglePreview: vi.fn(),
  badge: 'saved' as const,
  saveDisabled: false,
  saveTooltip: undefined,
  addLabel: 'Add to review',
  closedBanner: false,
  prState: 'open' as const,
  postNowDisabled: false,
  postNowTooltip: undefined,
  posting: false,
  postError: null as string | null,
  readOnly: false,
  onDiscardClick: vi.fn(),
  onSaveClick: vi.fn(),
  onPostNow: vi.fn(),
};

describe('ComposerActionsBar', () => {
  it('renders buttons in canonical order for an open PR', () => {
    const { container } = render(<ComposerActionsBar {...baseProps} />);
    const bar = container.querySelector('.composer-actions') as HTMLElement;
    const buttons = within(bar)
      .getAllByRole('button')
      .map((b) => b.textContent);
    // AiComposerAssistant renders null (AI gate off in tests); badge is a span, not a button.
    expect(buttons).toEqual(['Preview', 'Discard', 'Add to review', 'Comment']);
  });
  it('hides the save button and the merged note when closedBanner', () => {
    render(<ComposerActionsBar {...baseProps} closedBanner prState="merged" />);
    expect(screen.queryByRole('button', { name: 'Add to review' })).toBeNull();
    expect(screen.queryByText(/comments post immediately/)).toBeNull();
    // The merged context is preserved as the button's TOOLTIP (title) for mouse
    // users AND an aria-describedby sr-only description for keyboard/SR users —
    // NOT the accessible name ("Comment" stays the name; WCAG 2.5.3).
    const commentBtn = screen.getByRole('button', { name: 'Comment' });
    expect(commentBtn).toHaveAttribute('title', 'Post directly to this merged PR');
    const descId = commentBtn.getAttribute('aria-describedby');
    expect(descId).toBeTruthy();
    expect(document.getElementById(descId as string)).toHaveTextContent(
      'Post directly to this merged PR',
    );
  });
  it('renders postError as an alert', () => {
    render(<ComposerActionsBar {...baseProps} postError="boom" />);
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });
  it('disables Discard while a post is in flight (#601 Defect C)', () => {
    // A post-now in flight owns the draft. Discarding mid-post would fire a
    // delete that races the post (orphaned post or delete-of-already-posted),
    // so Discard must be inert — matching post-now's own `posting` gate.
    render(<ComposerActionsBar {...baseProps} posting />);
    const discard = screen.getByRole('button', { name: 'Discard' });
    expect(discard).toBeDisabled();
    expect(discard).toHaveAttribute('aria-disabled', 'true');
  });
  it('disables Save while a post is in flight (#601 Defect C — Save sibling)', () => {
    // The Save ("Add to review") button fires an update PUT against the same
    // draft the post is shipping. Like Discard, it must be inert during a post
    // so the update can't race the in-flight post.
    render(<ComposerActionsBar {...baseProps} posting />);
    const save = screen.getByRole('button', { name: 'Add to review' });
    expect(save).toBeDisabled();
  });
  it('Save aria-disabled mirrors the disabled state incl. cross-tab read-only (PR #650 review)', () => {
    // aria-disabled is always-present true/false (not omitted) and folds in the
    // cross-tab readOnly lock — guards the `saveDisabled || actionsLocked`
    // expression against the A3 explicit-false contract on one side and the
    // readOnly=true / posting=false case on the other.
    const { rerender } = render(<ComposerActionsBar {...baseProps} />);
    const save = () => screen.getByRole('button', { name: 'Add to review' });
    expect(save()).toHaveAttribute('aria-disabled', 'false'); // enabled
    rerender(<ComposerActionsBar {...baseProps} readOnly />);
    expect(save()).toHaveAttribute('aria-disabled', 'true'); // cross-tab read-only
    expect(save()).toBeDisabled();
  });
  it('supersedes the save badge with a read-only indicator when taken over (#630)', () => {
    // A cross-tab take-over mid-PUT can leave the autosave badge stuck on
    // 'Saving…'. When read-only, the status slot shows a neutral read-only
    // indicator instead of the (possibly stuck) save-state badge.
    render(<ComposerActionsBar {...baseProps} readOnly badge="saving" />);
    const badge = screen.getByTestId('composer-badge');
    expect(badge).toHaveTextContent('Read-only');
    expect(badge).not.toHaveTextContent(/Saving/);
    expect(badge).toHaveClass('composer-badge--readonly');
    expect(badge).toHaveAttribute('title', 'Another tab is editing this PR.');
    // Still a polite live region (role=status), intentionally not assertive.
    expect(badge).toHaveAttribute('role', 'status');
  });
  it('renders the normal save badge when not read-only', () => {
    render(<ComposerActionsBar {...baseProps} badge="saving" />);
    const badge = screen.getByTestId('composer-badge');
    expect(badge).toHaveTextContent('Saving…');
    expect(badge).not.toHaveClass('composer-badge--readonly');
  });
  it('renders the Resolve button immediately before the post-now button (#571) with green-outline style', () => {
    // The thread Resolve control lands in DOM order right before "Comment" so it reads as the
    // last action taken before posting. An unresolved thread uses the green-outline affordance.
    const { container } = render(
      <ComposerActionsBar
        {...baseProps}
        resolve={{
          label: 'Resolve conversation',
          busy: false,
          disabled: false,
          isResolved: false,
          onClick: vi.fn(),
        }}
      />,
    );
    const resolveBtn = screen.getByRole('button', { name: 'Resolve conversation' });
    const postNowButton = container.querySelector('.composer-post-now') as HTMLElement;
    expect(resolveBtn).toBeInTheDocument();
    expect(resolveBtn.className).toMatch(/\bbtn-success-outline\b/);
    // Node.DOCUMENT_POSITION_FOLLOWING (4): the resolve button precedes post-now.
    expect(
      resolveBtn.compareDocumentPosition(postNowButton) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
  it('renders no Resolve button when the resolve descriptor is omitted', () => {
    render(<ComposerActionsBar {...baseProps} />);
    expect(screen.queryByRole('button', { name: /resolve conversation/i })).toBeNull();
  });
  it('surfaces the "Comment and resolve conversation" label and, when busy, disables + aria-busy', () => {
    const { rerender } = render(
      <ComposerActionsBar
        {...baseProps}
        resolve={{
          label: 'Comment and resolve conversation',
          busy: false,
          disabled: false,
          isResolved: false,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Comment and resolve conversation' }),
    ).not.toBeDisabled();

    rerender(
      <ComposerActionsBar
        {...baseProps}
        resolve={{
          label: 'Resolving…',
          busy: true,
          disabled: true,
          isResolved: false,
          onClick: vi.fn(),
        }}
      />,
    );
    const busy = screen.getByRole('button', { name: 'Resolving…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
  });
  it('renders the neutral secondary style for an unresolve (isResolved) descriptor', () => {
    render(
      <ComposerActionsBar
        {...baseProps}
        resolve={{
          label: 'Unresolve conversation',
          busy: false,
          disabled: false,
          isResolved: true,
          onClick: vi.fn(),
        }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Unresolve conversation' }).className).toMatch(
      /\bbtn-secondary\b/,
    );
  });
});
