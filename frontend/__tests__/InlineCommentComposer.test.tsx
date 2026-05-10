import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import {
  InlineCommentComposer,
  type InlineAnchor,
} from '../src/components/PrDetail/Composer/InlineCommentComposer';
import * as draftApi from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const sampleAnchor: InlineAnchor = {
  filePath: 'src/Foo.cs',
  lineNumber: 42,
  side: 'right',
  anchoredSha: 'a'.repeat(40),
  anchoredLineContent: '    return 0;',
};

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
    <InlineCommentComposer
      prRef={ref}
      prState="open"
      anchor={sampleAnchor}
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

describe('InlineCommentComposer — accessibility (A3)', () => {
  it('outer container has role="form" and a descriptive aria-label', () => {
    render(<Harness />);
    const form = screen.getByRole('form');
    expect(form).toHaveAttribute('aria-label', 'Draft comment on src/Foo.cs line 42');
  });

  it('Save button is aria-disabled when body is empty', () => {
    render(<Harness />);
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'true');
    expect(save).toHaveAttribute('title', 'Type something to save.');
  });

  it('Save button is enabled (aria-disabled=false) once body is non-empty', async () => {
    render(<Harness />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toHaveAttribute('aria-disabled', 'false');
  });
});

describe('InlineCommentComposer — preview toggle', () => {
  it('toggle button has aria-pressed and switches to ComposerMarkdownPreview', () => {
    render(<Harness initialBody="**bold**" />);
    const toggle = screen.getByRole('button', { name: 'Preview' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(screen.getByRole('region', { name: 'Markdown preview' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('InlineCommentComposer — discard flow', () => {
  it('Discard with no draftId calls onClose immediately (no modal)', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Discard with draftId opens a modal with defaultFocus=cancel', () => {
    render(<Harness initialDraftId="uuid-existing" initialBody="some text" />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Discard saved draft?');
    // defaultFocus="cancel" → Cancel button focused.
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancelBtn);
  });

  it('Confirming the discard modal sends deleteDraftComment + closes', async () => {
    const onClose = vi.fn();
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    render(<Harness initialDraftId="uuid-existing" initialBody="some text" onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    // The "Discard" button inside the modal is the primary one.
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
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('InlineCommentComposer — keyboard', () => {
  it('Cmd+Enter flushes save and calls onClose', async () => {
    const onClose = vi.fn();
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'uuid-x' });
    render(<Harness onClose={onClose} />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await settle(0);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Esc opens the discard modal when draftId is set', () => {
    render(<Harness initialDraftId="uuid-existing" initialBody="text" />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Esc with no draftId calls onClose immediately', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('InlineCommentComposer — 404 recovery', () => {
  it('renders the recovery modal with disableEscDismiss when update returns 404', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: { error: 'draft-not-found' },
    });
    const onClose = vi.fn();
    render(<Harness initialDraftId="uuid-existing" initialBody="abcd" onClose={onClose} />);

    // Trigger a save (Cmd+Enter routes through flush) → 404 → recovery modal.
    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await settle(0);

    // The recovery modal is now open. Esc should NOT dismiss it.
    expect(screen.getByText(/draft was deleted from another window/i)).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByText(/draft was deleted from another window/i)).toBeInTheDocument();
  });

  it('Discard from recovery modal closes the composer', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: { error: 'draft-not-found' },
    });
    const onClose = vi.fn();
    render(<Harness initialDraftId="uuid-existing" initialBody="abcd" onClose={onClose} />);

    const textarea = screen.getByLabelText('Comment body') as HTMLTextAreaElement;
    fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
    await settle(0);

    // The recovery modal's "Discard" button is data-modal-role="cancel".
    const cancelBtn = screen
      .getAllByRole('button', { name: 'Discard' })
      .find((b) => b.getAttribute('data-modal-role') === 'cancel');
    expect(cancelBtn).toBeDefined();
    fireEvent.click(cancelBtn!);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('InlineCommentComposer — closed PR banner (spec § 5.3)', () => {
  it('renders a banner when prState !== "open"', () => {
    render(
      <InlineCommentComposer
        prRef={ref}
        prState="closed"
        anchor={sampleAnchor}
        draftId={null}
        onDraftIdChange={() => undefined}
        registerOpenComposer={() => () => undefined}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByText(/PR closed — text not saved/i)).toBeInTheDocument();
  });
});
