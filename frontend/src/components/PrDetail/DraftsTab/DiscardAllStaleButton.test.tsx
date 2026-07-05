import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DiscardAllStaleButton } from './DiscardAllStaleButton';
import { sendPatch } from '../../../api/draft';
import type { DraftCommentDto } from '../../../api/types';

vi.mock('../../../api/draft', () => ({ sendPatch: vi.fn() }));
const mockSendPatch = vi.mocked(sendPatch);

const prRef = { owner: 'acme', repo: 'api', number: 123 };

function staleComment(id: string): DraftCommentDto {
  return {
    id,
    filePath: 'src/Calc.cs',
    lineNumber: 1,
    side: 'right',
    anchoredSha: 'abc',
    anchoredLineContent: 'x',
    bodyMarkdown: `body ${id}`,
    status: 'stale',
    isOverriddenStale: false,
    postedCommentId: null,
  };
}

beforeEach(() => {
  mockSendPatch.mockReset();
});

// #744 — the bulk stale-discard clears each row optimistically on its own
// server-confirmed success, not only after the reconciliation refetch.
it('removes each successfully-discarded id locally', async () => {
  mockSendPatch.mockResolvedValue({ ok: true, assignedId: null });
  const removeDraftLocally = vi.fn();
  const onMutated = vi.fn();
  render(
    <DiscardAllStaleButton
      prRef={prRef}
      staleComments={[staleComment('c1'), staleComment('c2')]}
      staleReplies={[]}
      onMutated={onMutated}
      removeDraftLocally={removeDraftLocally}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Discard all stale/ }));
  fireEvent.click(document.querySelector('[data-modal-role="primary"]') as HTMLButtonElement);
  await waitFor(() => expect(onMutated).toHaveBeenCalled());
  expect(removeDraftLocally).toHaveBeenCalledWith('c1');
  expect(removeDraftLocally).toHaveBeenCalledWith('c2');
  expect(removeDraftLocally).toHaveBeenCalledTimes(2);
});

it('removes only the succeeded ids on a partial failure', async () => {
  // c1 succeeds, c2 fails.
  mockSendPatch
    .mockResolvedValueOnce({ ok: true, assignedId: null })
    .mockResolvedValueOnce({ ok: false, status: 0, kind: 'network', body: 'x' });
  const removeDraftLocally = vi.fn();
  const onMutated = vi.fn();
  render(
    <DiscardAllStaleButton
      prRef={prRef}
      staleComments={[staleComment('c1'), staleComment('c2')]}
      staleReplies={[]}
      onMutated={onMutated}
      removeDraftLocally={removeDraftLocally}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Discard all stale/ }));
  fireEvent.click(document.querySelector('[data-modal-role="primary"]') as HTMLButtonElement);
  await waitFor(() => expect(mockSendPatch).toHaveBeenCalledTimes(2));
  expect(removeDraftLocally).toHaveBeenCalledWith('c1');
  expect(removeDraftLocally).not.toHaveBeenCalledWith('c2');
  expect(removeDraftLocally).toHaveBeenCalledTimes(1);
});
