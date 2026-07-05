import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DraftListItem } from './DraftListItem';
import type { DraftLike } from '../draftKinds';
import { sendPatch } from '../../../api/draft';

vi.mock('../../../api/draft', () => ({ sendPatch: vi.fn() }));

const mockSendPatch = vi.mocked(sendPatch);

beforeEach(() => {
  mockSendPatch.mockReset();
});

const prRef = { owner: 'acme', repo: 'api', number: 123 };

const fileDraft: DraftLike = {
  kind: 'comment',
  data: {
    id: 'd1',
    filePath: 'src/Calc.cs',
    lineNumber: 42,
    side: 'right',
    anchoredSha: 'abc',
    anchoredLineContent: 'x',
    bodyMarkdown: 'B'.repeat(200),
    status: 'draft',
    isOverriddenStale: false,
    postedCommentId: null,
  },
};

const rootDraft: DraftLike = {
  kind: 'comment',
  data: {
    ...fileDraft.data,
    id: 'd2',
    filePath: null,
    lineNumber: null,
    bodyMarkdown: 'root body',
  },
};

const noop = () => {};

it('renders the full body, not an 80-char clamp', () => {
  render(<DraftListItem prRef={prRef} draft={fileDraft} onEdit={noop} onMutated={noop} />);
  expect(screen.getByText('B'.repeat(200))).toBeInTheDocument();
});

it('shows file · line for a file-anchored draft', () => {
  render(<DraftListItem prRef={prRef} draft={fileDraft} onEdit={noop} onMutated={noop} />);
  expect(screen.getByText(/src\/Calc\.cs/)).toBeInTheDocument();
  expect(screen.getByText(/line 42/)).toBeInTheDocument();
});

it('does not repeat the line for a moved draft (chip already shows it)', () => {
  const movedDraft: DraftLike = {
    kind: 'comment',
    data: { ...fileDraft.data, id: 'd3', status: 'moved' },
  };
  render(<DraftListItem prRef={prRef} draft={movedDraft} onEdit={noop} onMutated={noop} />);
  // "line 42" appears only in the "Moved (line 42)" chip, not again in the band.
  expect(screen.getAllByText(/line 42/)).toHaveLength(1);
  expect(screen.getByText(/src\/Calc\.cs/)).toBeInTheDocument();
});

it('renders a Stale chip and keeps the line for a stale draft', () => {
  const staleDraft: DraftLike = {
    kind: 'comment',
    data: { ...fileDraft.data, id: 'd4', status: 'stale' },
  };
  render(<DraftListItem prRef={prRef} draft={staleDraft} onEdit={noop} onMutated={noop} />);
  expect(screen.getByText('Stale')).toBeInTheDocument();
  // The line suffix is suppressed only for 'moved' (whose chip already reads
  // the line); a stale draft still shows file · line in the band.
  expect(screen.getByText(/line 42/)).toBeInTheDocument();
});

it('shows chip-only band (no file/line) for a PR-root draft', () => {
  render(<DraftListItem prRef={prRef} draft={rootDraft} onEdit={noop} onMutated={noop} />);
  expect(screen.queryByText(/line/)).toBeNull();
  expect(screen.getByText('Draft')).toBeInTheDocument();
});

it('footer shows Edit + Discard; readOnly hides the footer', () => {
  const { rerender } = render(
    <DraftListItem prRef={prRef} draft={fileDraft} onEdit={noop} onMutated={noop} />,
  );
  expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Discard' })).toBeInTheDocument();
  rerender(
    <DraftListItem prRef={prRef} draft={fileDraft} onEdit={noop} onMutated={noop} readOnly />,
  );
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

// #744 — optimistic discard: the row leaves the list on delete SUCCESS, before
// the reconciliation refetch (onMutated) round-trips back.
it('calls removeDraftLocally(id) then onMutated on a successful discard', async () => {
  mockSendPatch.mockResolvedValue({ ok: true, assignedId: null });
  const removeDraftLocally = vi.fn();
  const onMutated = vi.fn();
  render(
    <DraftListItem
      prRef={prRef}
      draft={fileDraft}
      onEdit={noop}
      onMutated={onMutated}
      removeDraftLocally={removeDraftLocally}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  // Confirm in the modal (data-modal-role="primary").
  fireEvent.click(document.querySelector('[data-modal-role="primary"]') as HTMLButtonElement);
  await waitFor(() => expect(removeDraftLocally).toHaveBeenCalledWith('d1'));
  expect(onMutated).toHaveBeenCalledTimes(1);
});

it('does NOT remove the row when the discard fails (keeps it for retry)', async () => {
  mockSendPatch.mockResolvedValue({ ok: false, status: 0, kind: 'network', body: 'x' });
  const removeDraftLocally = vi.fn();
  const onMutated = vi.fn();
  // Empty body → requestDelete runs the delete directly (no confirm modal).
  const emptyDraft: DraftLike = { kind: 'comment', data: { ...fileDraft.data, bodyMarkdown: '' } };
  render(
    <DraftListItem
      prRef={prRef}
      draft={emptyDraft}
      onEdit={noop}
      onMutated={onMutated}
      removeDraftLocally={removeDraftLocally}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
  await waitFor(() => expect(mockSendPatch).toHaveBeenCalledTimes(1));
  expect(removeDraftLocally).not.toHaveBeenCalled();
  expect(onMutated).not.toHaveBeenCalled();
});
