import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { ReplyComposer } from '../src/components/PrDetail/Composer/ReplyComposer';
import * as draftApi from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const PARENT_THREAD_ID = 'PRRT_kwDOBlahBlah';

function Harness({
  initialBody = '',
  initialDraftId = null,
  onClose = () => undefined,
}: {
  initialBody?: string;
  initialDraftId?: string | null;
  onClose?: () => void;
}) {
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  const cleanup = () => undefined;
  return (
    <ReplyComposer
      prRef={ref}
      prState="open"
      parentThreadId={PARENT_THREAD_ID}
      initialBody={initialBody}
      draftId={draftId}
      onDraftIdChange={setDraftId}
      registerOpenComposer={() => cleanup}
      onClose={onClose}
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

describe('ReplyComposer — accessibility (A3)', () => {
  it('outer container has role="form" and a thread-anchored aria-label', () => {
    render(<Harness />);
    const form = screen.getByRole('form');
    expect(form).toHaveAttribute('aria-label', `Reply to thread ${PARENT_THREAD_ID}`);
  });

  it('Save button is aria-disabled when body is empty', () => {
    render(<Harness />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAttribute('title', 'Type something to save.');
  });
});

describe('ReplyComposer — first qualifying keystroke fires newDraftReply', () => {
  it('debounced typing ≥3 chars fires newDraftReply with the parent thread id', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-r1' });
    render(<Harness />);
    const textarea = screen.getByLabelText('Reply body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'lgtm' } });
    await settle();
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'newDraftReply',
      payload: { parentThreadId: PARENT_THREAD_ID, bodyMarkdown: 'lgtm' },
    });
  });
});

describe('ReplyComposer — discard flow', () => {
  it('Discard with no draftId calls onClose immediately (no modal)', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Esc with draftId opens discard-confirm modal; confirm sends deleteDraftReply', async () => {
    const onClose = vi.fn();
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    render(<Harness initialDraftId="uuid-existing" initialBody="some text" onClose={onClose} />);
    const textarea = screen.getByLabelText('Reply body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Discard saved draft?');

    const modalDiscard = screen
      .getAllByRole('button', { name: 'Discard' })
      .find((b) => b.getAttribute('data-modal-role') === 'primary');
    expect(modalDiscard).toBeDefined();
    fireEvent.click(modalDiscard!);
    await settle(0);
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'deleteDraftReply',
      payload: { id: 'uuid-existing' },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('ReplyComposer — closed PR banner (spec § 5.3)', () => {
  it('renders a banner when prState !== "open"', () => {
    render(
      <ReplyComposer
        prRef={ref}
        prState="merged"
        parentThreadId={PARENT_THREAD_ID}
        draftId={null}
        onDraftIdChange={() => undefined}
        registerOpenComposer={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/PR merged — text not saved/i)).toBeInTheDocument();
  });
});
