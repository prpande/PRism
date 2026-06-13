import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { PrRootReplyComposer } from './PrRootReplyComposer';
import * as draftApi from '../../../api/draft';
import * as rootCommentApi from '../../../api/rootComment';
import type { PrReference } from '../../../api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

function Harness({
  initialBody = '',
  initialDraftId = null,
  onClose = () => undefined,
  readOnly = false,
}: {
  initialBody?: string;
  initialDraftId?: string | null;
  onClose?: () => void;
  readOnly?: boolean;
}) {
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const cleanup = () => undefined;
  return (
    <PrRootReplyComposer
      prRef={ref}
      prState="open"
      initialBody={initialBody}
      draftId={draftId}
      onDraftIdChange={setDraftId}
      registerOpenComposer={() => cleanup}
      onClose={onClose}
      readOnly={readOnly}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 250) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// The wrapped editor renders the textarea (aria-label "PR-level body" per Task 20).
function editorTextarea(): HTMLTextAreaElement {
  return screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
}

function postButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: /^Post(ing…)?$/ }) as HTMLButtonElement;
}

describe('PrRootReplyComposer — accessibility (A3)', () => {
  it('outer container has role="form" with PR-root aria-label', () => {
    render(<Harness />);
    const form = screen.getByRole('form');
    expect(form).toHaveAttribute('aria-label', 'Reply to this PR');
  });

  it('wraps PrRootBodyEditor (textarea aria-label is "PR-level body")', () => {
    render(<Harness initialBody="hi" />);
    expect(editorTextarea()).toBeInTheDocument();
  });

  it('exposes a Post button and no Save button', () => {
    render(<Harness initialBody="hello" />);
    expect(screen.getByRole('button', { name: 'Post' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});

describe('PrRootReplyComposer — discard flow', () => {
  it('DiscardConfirm_ServerRejectsDelete_ModalStaysOpen — non-ok result keeps the modal open', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 422,
      kind: 'invalid-body',
      body: 'rejected',
    });
    const onClose = vi.fn();
    render(<Harness initialDraftId="uuid-existing" initialBody="text" onClose={onClose} />);
    fireEvent.keyDown(editorTextarea(), { key: 'Escape' });

    const modalDiscard = screen
      .getAllByRole('button', { name: 'Discard' })
      .find((b) => b.getAttribute('data-modal-role') === 'primary');
    expect(modalDiscard).toBeDefined();
    fireEvent.click(modalDiscard!);
    await settle(0);

    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'deleteDraftComment',
      payload: { id: 'uuid-existing' },
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('PrRootReplyComposer — Post flow', () => {
  it('Post flushes the autosave, then calls postRootComment, then onClose on success', async () => {
    const order: string[] = [];
    // The wrapped editor surfaces a real flush via onAutosaveControl. Stub
    // sendPatch so flush resolves without touching the network.
    vi.spyOn(draftApi, 'sendPatch').mockImplementation(async () => {
      order.push('flush');
      return { ok: true, status: 200, data: { id: 'uuid-existing' } } as never;
    });
    const postSpy = vi.spyOn(rootCommentApi, 'postRootComment').mockImplementation(async () => {
      order.push('post');
      return { ok: true };
    });
    const onClose = vi.fn(() => order.push('close'));

    render(
      <Harness initialDraftId="uuid-existing" initialBody="ready to ship" onClose={onClose} />,
    );
    fireEvent.click(postButton());
    await settle(0);

    expect(postSpy).toHaveBeenCalledWith(ref);
    expect(onClose).toHaveBeenCalledTimes(1);
    // flush precedes post; post precedes close.
    expect(order.indexOf('flush')).toBeLessThan(order.indexOf('post'));
    expect(order.indexOf('post')).toBeLessThan(order.indexOf('close'));
  });

  it('Ctrl+Enter triggers Post', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: 'uuid-existing' },
    } as never);
    const postSpy = vi.spyOn(rootCommentApi, 'postRootComment').mockResolvedValue({ ok: true });
    const onClose = vi.fn();

    render(<Harness initialDraftId="uuid-existing" initialBody="ship me" onClose={onClose} />);
    fireEvent.keyDown(editorTextarea(), { key: 'Enter', ctrlKey: true });
    await settle(0);

    expect(postSpy).toHaveBeenCalledWith(ref);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a failing post sets the error row and does NOT close', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: 'uuid-existing' },
    } as never);
    vi.spyOn(rootCommentApi, 'postRootComment').mockResolvedValue({
      ok: false,
      code: 'github-network-error',
      message: 'network down',
    });
    const onClose = vi.fn();

    render(<Harness initialDraftId="uuid-existing" initialBody="ship me" onClose={onClose} />);
    fireEvent.click(postButton());
    await settle(0);

    const alert = screen.getByTestId('post-error');
    expect(alert).toHaveTextContent(/network down/i);
    expect(alert).toHaveTextContent(/Couldn't post to GitHub/i);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('already-posted-body-mismatch renders the recovery banner (not the generic Retry row)', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: 'uuid-existing' },
    } as never);
    vi.spyOn(rootCommentApi, 'postRootComment').mockResolvedValue({
      ok: false,
      code: 'already-posted-body-mismatch',
      message: 'mismatch',
      postedCommentId: 9876,
    });
    const onClose = vi.fn();

    render(<Harness initialDraftId="uuid-existing" initialBody="edited body" onClose={onClose} />);
    fireEvent.click(postButton());
    await settle(0);

    const alert = screen.getByTestId('post-error');
    expect(screen.getByTestId('post-error-already-posted')).toBeInTheDocument();
    expect(alert).toHaveTextContent(/already posted/i);
    expect(alert).toHaveTextContent(/9876/);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Post is disabled when the body is empty', () => {
    render(<Harness initialBody="" />);
    expect(postButton()).toBeDisabled();
  });

  it('Post is disabled (and tooltip set) under cross-tab readOnly', () => {
    render(<Harness initialBody="some text" initialDraftId="uuid-existing" readOnly />);
    const post = postButton();
    expect(post).toBeDisabled();
    expect(post).toHaveAttribute('title', 'Another tab is editing this PR.');
  });

  it('Post button enters "Posting…" + stays disabled while in flight', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      status: 200,
      data: { id: 'uuid-existing' },
    } as never);
    let resolvePost: (v: { ok: true }) => void = () => undefined;
    vi.spyOn(rootCommentApi, 'postRootComment').mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }),
    );

    render(<Harness initialDraftId="uuid-existing" initialBody="ship me" />);
    fireEvent.click(postButton());
    // Drain flush so we sit inside the pending postRootComment promise.
    await settle(0);

    const posting = screen.getByRole('button', { name: 'Posting…' });
    expect(posting).toBeDisabled();

    await act(async () => {
      resolvePost({ ok: true });
      await Promise.resolve();
    });
  });
});

describe('PrRootReplyComposer — closed PR (#302 updated)', () => {
  // #302: "text not saved" banner removed from PrRootBodyEditor (guard relaxed).
  it('does NOT render a "text not saved" banner when prState !== "open"', () => {
    render(
      <PrRootReplyComposer
        prRef={ref}
        prState="closed"
        draftId={null}
        onDraftIdChange={() => undefined}
        registerOpenComposer={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.queryByText(/text not saved/i)).not.toBeInTheDocument();
  });
});
