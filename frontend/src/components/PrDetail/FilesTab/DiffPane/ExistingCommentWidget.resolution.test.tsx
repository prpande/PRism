import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import type { ReviewThreadDto } from '../../../../api/types';

// #571 Task 12 — the widget consumes useThreadResolution (Task 9) to render the
// Resolve/Unresolve control. Mock it so each test can drive an arbitrary hook
// state without exercising the real resolve/unresolve network call — that
// hook already has its own dedicated test suite (useThreadResolution.test.tsx).
const { useThreadResolutionMock } = vi.hoisted(() => ({
  useThreadResolutionMock: vi.fn(),
}));

vi.mock('../../../../hooks/useThreadResolution', () => ({
  useThreadResolution: useThreadResolutionMock,
}));

function thread(over: Partial<ReviewThreadDto> = {}): ReviewThreadDto {
  return {
    threadId: 't1',
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    isResolved: false,
    comments: [
      {
        commentId: 'c1',
        author: 'amelia.cho',
        avatarUrl: null,
        body: 'one',
        createdAt: '2026-05-18T00:00:00Z',
      },
    ],
    ...over,
  } as ReviewThreadDto;
}

function replyContext(over: Record<string, unknown> = {}) {
  return {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prState: 'open' as const,
    registerOpenComposer: () => () => {},
    onReplyComposerClose: () => {},
    reload: () => {},
    ...over,
  };
}

function collapseStub() {
  return { isCollapsed: () => false, toggle: () => {}, clearCollapseOverride: () => {} };
}

function hookState(over: Record<string, unknown> = {}) {
  return {
    pending: false,
    announce: null,
    error: null,
    reconcileHint: false,
    invoke: vi.fn(),
    ...over,
  };
}

describe('ExistingCommentWidget — resolve/unresolve control (#571 Task 12)', () => {
  beforeEach(() => {
    useThreadResolutionMock.mockReset();
    useThreadResolutionMock.mockReturnValue(hookState());
  });

  it('active thread renders "Resolve conversation" with the green-outline class', () => {
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Resolve conversation' });
    expect(button.className).toMatch(/\bbtn-success-outline\b/);
  });

  it('resolved thread renders "Unresolve conversation" with the neutral secondary class', () => {
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: true })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Unresolve conversation' });
    expect(button.className).toMatch(/\bbtn-secondary\b/);
  });

  it('pending: button is disabled + aria-busy + reads "Resolving…"; sr-only status announces it', () => {
    useThreadResolutionMock.mockReturnValue(hookState({ pending: true, announce: 'Resolving…' }));
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const button = screen.getByRole('button', { name: 'Resolving…' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    const status = screen.getByRole('status');
    expect(status).toHaveTextContent('Resolving…');
  });

  it('keeps the sr-only live region mounted (empty) when idle so AT announces later mutations', () => {
    // Always-mounted region (mirrors PrActionsPanel): a region inserted already-containing
    // its text is not reliably announced. When idle it must be present but empty.
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('');
  });

  it('error: renders a role=alert .composer-error banner with the copy; button stays present', () => {
    useThreadResolutionMock.mockReturnValue(
      hookState({ error: "PRism can't resolve this conversation. Grant PR-write access." }),
    );
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('composer-error');
    expect(alert).toHaveTextContent(
      "PRism can't resolve this conversation. Grant PR-write access.",
    );
    expect(screen.getByRole('button', { name: 'Resolve conversation' })).toBeInTheDocument();
  });

  it('reconcileHint (no error): renders the "couldn\'t refresh" hint banner', () => {
    useThreadResolutionMock.mockReturnValue(hookState({ reconcileHint: true }));
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('composer-error');
    expect(alert).toHaveTextContent(
      'Resolved — couldn’t refresh. Reload the PR to see the change.',
    );
  });

  it('readOnly: the control is disabled', () => {
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: false })]}
        replyContext={replyContext({ readOnly: true })}
        collapse={collapseStub()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Resolve conversation' })).toBeDisabled();
  });

  it('pure render (no replyContext): no Resolve/Unresolve button renders and nothing throws; hook gets prRef=null', () => {
    expect(() =>
      render(<ExistingCommentWidget threads={[thread()]} collapse={collapseStub()} />),
    ).not.toThrow();
    expect(screen.queryByRole('button', { name: /resolve conversation/i })).not.toBeInTheDocument();
    expect(useThreadResolutionMock).toHaveBeenCalled();
    const lastCallArgs = useThreadResolutionMock.mock.calls.at(-1)?.[0];
    expect(lastCallArgs.prRef).toBeNull();
  });

  it('clicking the button parks focus on the thread root before invoking', async () => {
    const invoke = vi.fn();
    useThreadResolutionMock.mockReturnValue(hookState({ invoke }));
    const user = userEvent.setup();
    render(
      <ExistingCommentWidget
        threads={[thread({ threadId: 't1', isResolved: false })]}
        replyContext={replyContext()}
        collapse={collapseStub()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Resolve conversation' }));
    expect(invoke).toHaveBeenCalledTimes(1);
    const root = document.querySelector('[data-thread-id="t1"]');
    expect(document.activeElement).toBe(root);
  });
});
