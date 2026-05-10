import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { PrRootReplyComposer } from '../src/components/PrDetail/Composer/PrRootReplyComposer';
import * as draftApi from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

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
    <PrRootReplyComposer
      prRef={ref}
      prState="open"
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

describe('PrRootReplyComposer — accessibility (A3)', () => {
  it('outer container has role="form" with PR-root aria-label', () => {
    render(<Harness />);
    const form = screen.getByRole('form');
    expect(form).toHaveAttribute('aria-label', 'Reply to this PR');
  });
});

describe('PrRootReplyComposer — first qualifying keystroke fires newPrRootDraftComment', () => {
  it('PrRootReplyComposer_FirstKeystroke_FiresNewPrRootDraftComment', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-pr-root-1' });
    render(<Harness />);
    const textarea = screen.getByLabelText('PR reply body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'thanks for shipping this' } });
    await settle();
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'newPrRootDraftComment',
      payload: { bodyMarkdown: 'thanks for shipping this' },
    });
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
    const textarea = screen.getByLabelText('PR reply body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });

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

describe('PrRootReplyComposer — closed PR banner', () => {
  it('renders a banner when prState !== "open"', () => {
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
    expect(screen.getByText(/PR closed — text not saved/i)).toBeInTheDocument();
  });
});
