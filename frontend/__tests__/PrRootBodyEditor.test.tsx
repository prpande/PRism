import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { PrRootBodyEditor } from '../src/components/PrDetail/Composer/PrRootBodyEditor';
import type { ComposerSaveBadge } from '../src/hooks/useComposerAutoSave';
import * as draftApi from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

interface HarnessProps {
  initialBody?: string;
  initialDraftId?: string | null;
  readOnly?: boolean;
  prState?: 'open' | 'closed' | 'merged';
  registerOpenComposer?: (draftId: string, ownerKey: string) => () => void;
  onBodyChange?: (body: string) => void;
  onAutosaveControl?: (control: { flush: () => Promise<string | null>; badge: ComposerSaveBadge }) => void;
  onDraftLost?: () => void;
}

function Harness({
  initialBody = '',
  initialDraftId = null,
  readOnly = false,
  prState = 'open',
  registerOpenComposer = () => () => undefined,
  onBodyChange,
  onAutosaveControl,
  onDraftLost,
}: HarnessProps) {
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  return (
    <PrRootBodyEditor
      prRef={ref}
      prState={prState}
      initialBody={initialBody}
      draftId={draftId}
      onDraftIdChange={setDraftId}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      registerOpenComposer={registerOpenComposer as any}
      ownerKey="reply-composer"
      readOnly={readOnly}
      onBodyChange={onBodyChange}
      onAutosaveControl={onAutosaveControl}
      onDraftLost={onDraftLost}
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

describe('PrRootBodyEditor — autosave create', () => {
  it('first qualifying keystroke fires newPrRootDraftComment', async () => {
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-pr-root-1' });
    render(<Harness />);
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'thanks for shipping this' } });
    await settle();
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'newPrRootDraftComment',
      payload: { bodyMarkdown: 'thanks for shipping this' },
    });
  });
});

describe('PrRootBodyEditor — draft-deleted-elsewhere recovery', () => {
  it('opens recovery modal on 404 update, Re-create calls flush (re-creates draft)', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch');
    // First call: update of an existing draft → 404 (deleted elsewhere).
    spy.mockResolvedValueOnce({ ok: false, status: 404, kind: 'draft-not-found', body: '' });
    render(<Harness initialDraftId="uuid-existing" initialBody="hello world" />);
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    // Trigger an update by editing.
    fireEvent.change(textarea, { target: { value: 'hello world!!' } });
    await settle();

    // Recovery modal surfaced.
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/deleted from another window/i)).toBeInTheDocument();

    // Re-create → flush re-creates as a fresh draft (draftId was cleared → create).
    spy.mockResolvedValueOnce({ ok: true, assignedId: 'uuid-recreated' });
    const recreate = screen
      .getAllByRole('button', { name: 'Re-create' })
      .find((b) => b.getAttribute('data-modal-role') === 'primary');
    expect(recreate).toBeDefined();
    fireEvent.click(recreate!);
    await settle(0);

    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'newPrRootDraftComment',
      payload: { bodyMarkdown: 'hello world!!' },
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Discard in recovery modal calls onDraftLost and closes the modal', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch');
    spy.mockResolvedValueOnce({ ok: false, status: 404, kind: 'draft-not-found', body: '' });
    const onDraftLost = vi.fn();
    render(
      <Harness
        initialDraftId="uuid-existing"
        initialBody="hello world"
        onDraftLost={onDraftLost}
      />,
    );
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world?' } });
    await settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const discard = screen
      .getAllByRole('button', { name: 'Discard' })
      .find((b) => b.getAttribute('data-modal-role') === 'cancel');
    expect(discard).toBeDefined();
    fireEvent.click(discard!);
    await settle(0);

    expect(onDraftLost).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the recovery modal via a portal to document.body', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch');
    spy.mockResolvedValueOnce({ ok: false, status: 404, kind: 'draft-not-found', body: '' });
    const { container } = render(
      <Harness initialDraftId="uuid-existing" initialBody="hello world" />,
    );
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello world!' } });
    await settle();

    const dialog = screen.getByRole('dialog');
    // Portaled: the dialog is NOT inside the editor's rendered subtree.
    expect(container.contains(dialog)).toBe(false);
    expect(document.body.contains(dialog)).toBe(true);
  });
});

describe('PrRootBodyEditor — surfaced callbacks', () => {
  it('onAutosaveControl receives { flush, badge } exactly once and does not churn on rerender', () => {
    // Bare inline vi.fn() → its identity is irrelevant: the effect deps are
    // [flush, badge], not the callback. A no-op rerender keeps flush/badge
    // stable, so the surfacing effect must NOT re-fire.
    const onAutosaveControl = vi.fn();
    const { rerender } = render(<Harness onAutosaveControl={onAutosaveControl} />);
    expect(onAutosaveControl).toHaveBeenCalledTimes(1);
    const arg = onAutosaveControl.mock.calls[0][0];
    expect(typeof arg.flush).toBe('function');
    expect(typeof arg.badge).toBe('string');

    // Re-render with no state change: a fresh inline callback identity each
    // time. Because the callback is read from a ref and the effect deps are
    // [flush, badge] (both stable here), the call count must not increase.
    rerender(<Harness onAutosaveControl={onAutosaveControl} />);
    expect(onAutosaveControl).toHaveBeenCalledTimes(1);
  });

  it('onBodyChange fires on typing', async () => {
    const onBodyChange = vi.fn();
    render(<Harness onBodyChange={onBodyChange} />);
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hi' } });
    await act(async () => {
      await Promise.resolve();
    });
    expect(onBodyChange).toHaveBeenCalledWith('hi');
  });

  it('registerOpenComposer is called with (draftId, ownerKey) and unregisters on unmount', () => {
    const unregister = vi.fn();
    const registerOpenComposer = vi.fn(() => unregister);
    const { unmount } = render(
      <Harness initialDraftId="uuid-open" registerOpenComposer={registerOpenComposer} />,
    );
    expect(registerOpenComposer).toHaveBeenCalledWith('uuid-open', 'reply-composer');
    unmount();
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('does NOT register when draftId is null', () => {
    const registerOpenComposer = vi.fn(() => () => undefined);
    render(<Harness initialDraftId={null} registerOpenComposer={registerOpenComposer} />);
    expect(registerOpenComposer).not.toHaveBeenCalled();
  });
});

describe('PrRootBodyEditor — readOnly + banner (#302 updated)', () => {
  it('readOnly makes the textarea read-only', () => {
    render(<Harness readOnly />);
    const textarea = screen.getByLabelText('PR-level body') as HTMLTextAreaElement;
    expect(textarea).toHaveAttribute('readOnly');
  });

  // #302: "text not saved" banner removed — drafts now stage on closed/merged PRs.
  it('does NOT render a "text not saved" banner when prState !== "open"', () => {
    render(<Harness prState="closed" />);
    expect(screen.queryByText(/text not saved/i)).not.toBeInTheDocument();
  });
});
