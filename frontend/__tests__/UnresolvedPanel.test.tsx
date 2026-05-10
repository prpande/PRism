import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { UnresolvedPanel } from '../src/components/PrDetail/Reconciliation/UnresolvedPanel';
import * as draftApi from '../src/api/draft';
import type { DraftCommentDto, PrReference, ReviewSessionDto } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

function mkComment(overrides: Partial<DraftCommentDto> = {}): DraftCommentDto {
  return {
    id: 'd1',
    filePath: 'src/Foo.cs',
    lineNumber: 42,
    side: 'right',
    anchoredSha: 'sha1',
    anchoredLineContent: 'foo();',
    bodyMarkdown: 'needs work',
    status: 'draft',
    isOverriddenStale: false,
    ...overrides,
  };
}

function mkSession(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
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

interface RenderOpts {
  onMutated?: () => void;
  initialPath?: string;
}

function renderPanel(session: ReviewSessionDto, opts: RenderOpts = {}) {
  const onMutated = opts.onMutated ?? vi.fn();
  return render(
    <MemoryRouter initialEntries={[opts.initialPath ?? '/pr/octocat/hello/42']}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number"
          element={<UnresolvedPanel prRef={ref} session={session} onMutated={onMutated} />}
        />
        <Route path="/pr/:owner/:repo/:number/files/*" element={<div>FILES_TAB_STUB</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UnresolvedPanel', () => {
  it('HiddenWhenNoStaleAndNoVerdictReconfirm', () => {
    const { container } = renderPanel(mkSession());
    expect(container.firstChild).toBeNull();
  });

  it('RendersOnEveryTab_WhenStaleCountGtZero', () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    renderPanel(session);
    expect(screen.getByRole('region', { name: /unresolved drafts/i })).toBeInTheDocument();
  });

  it('OverriddenStaleDraft_NotCountedTowardStaleCount', () => {
    // Per spec § 5.5, the backend reclassifies overridden drafts to status
    // 'draft'. The realistic shape is status='draft' + isOverriddenStale=true.
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'draft', isOverriddenStale: true })],
    });
    const { container } = renderPanel(session);
    expect(container.firstChild).toBeNull();
  });

  it('SummaryOmitsZeroCountClauses', () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    renderPanel(session);
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    expect(within(region).getByText(/1 draft needs attention/i)).toBeInTheDocument();
    expect(within(region).queryByText(/moved/i)).not.toBeInTheDocument();
    expect(within(region).queryByText(/verdict/i)).not.toBeInTheDocument();
  });

  it('SummaryIncludesMovedAndVerdictWhenPresent', () => {
    const session = mkSession({
      draftVerdictStatus: 'needs-reconfirm',
      draftComments: [
        mkComment({ id: 'a', status: 'stale' }),
        mkComment({ id: 'b', status: 'moved' }),
      ],
    });
    renderPanel(session);
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    const summary = region.querySelector('.unresolved-panel-summary')!;
    expect(summary.textContent).toMatch(/1 draft needs attention/i);
    expect(summary.textContent).toMatch(/1 moved/i);
    expect(summary.textContent).toMatch(/verdict needs re-confirm/i);
  });

  it('VerdictReconfirmRow_FiresConfirmVerdictPatch_AndCallsOnMutated', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const onMutated = vi.fn();
    const session = mkSession({ draftVerdictStatus: 'needs-reconfirm' });
    renderPanel(session, { onMutated });
    const button = screen.getByRole('button', { name: /confirm verdict/i });
    await userEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, { kind: 'confirmVerdict' });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
    // Button must re-enable on success — the row will hide once the
    // refetched session has draftVerdictStatus !== 'needs-reconfirm', but
    // until then the user must not be stuck behind a permanent disabled.
    expect(button).not.toBeDisabled();
  });

  it('VerdictReconfirmRow_DoesNotCallOnMutated_OnFailure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: false, status: 0, kind: 'network', body: 'fetch failed' });
    const onMutated = vi.fn();
    const session = mkSession({ draftVerdictStatus: 'needs-reconfirm' });
    renderPanel(session, { onMutated });
    const button = screen.getByRole('button', { name: /confirm verdict/i });
    await userEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(onMutated).not.toHaveBeenCalled();
    // Button still re-enables so the user can retry.
    expect(button).not.toBeDisabled();
  });

  it('KeepAnyway_FiresOverrideStalePatch_AndCallsOnMutated', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const onMutated = vi.fn();
    const session = mkSession({
      draftComments: [mkComment({ id: 'stale-1', status: 'stale' })],
    });
    renderPanel(session, { onMutated });
    await userEvent.click(screen.getByRole('button', { name: /keep anyway/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'overrideStale',
      payload: { id: 'stale-1' },
    });
    await waitFor(() => expect(onMutated).toHaveBeenCalledTimes(1));
  });

  it('AriaLive_RegionPresent', () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    renderPanel(session);
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    const live = region.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
  });

  it('AriaLive_AnnouncesAllReconciled_WhenStaleCountDropsToZero', async () => {
    vi.useFakeTimers();
    try {
      const session = mkSession({
        draftComments: [mkComment({ id: 'a', status: 'stale' })],
      });
      const { rerender } = renderPanel(session);
      // Initial mount: panel visible, summary text present.
      const region = screen.getByRole('region', { name: /unresolved drafts/i });
      const live = region.querySelector('[aria-live="polite"]') as HTMLElement;
      expect(live.textContent).toMatch(/1 draft needs attention/i);

      // Transition: stale drops to zero. Panel hides itself but emits
      // "All drafts reconciled." in a hidden aria-live region for the
      // configured duration so screen-reader users get the confirmation.
      const reconciled = mkSession();
      rerender(
        <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
          <Routes>
            <Route
              path="/pr/:owner/:repo/:number"
              element={<UnresolvedPanel prRef={ref} session={reconciled} onMutated={vi.fn()} />}
            />
          </Routes>
        </MemoryRouter>,
      );
      const announce = screen.getByTestId('unresolved-panel-announce');
      expect(announce.textContent).toMatch(/all drafts reconciled/i);

      // After the timeout, the announce region unmounts.
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByTestId('unresolved-panel-announce')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('TabOrderInsideRow_StatusShowMeEditDeleteKeepAnyway', () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    renderPanel(session);
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    const buttons = within(region).getAllByRole('button');
    // The first row's button order, after summary buttons (none in summary).
    const labels = buttons.map((b) => b.textContent ?? '');
    const showIdx = labels.findIndex((l) => /show me/i.test(l));
    const editIdx = labels.findIndex((l) => /^edit/i.test(l));
    const deleteIdx = labels.findIndex((l) => /^delete/i.test(l));
    const keepIdx = labels.findIndex((l) => /keep anyway/i.test(l));
    expect(showIdx).toBeGreaterThanOrEqual(0);
    expect(showIdx).toBeLessThan(editIdx);
    expect(editIdx).toBeLessThan(deleteIdx);
    expect(deleteIdx).toBeLessThan(keepIdx);
  });

  it('ShowMe_OnFileDraft_NavigatesToFilesTab_PlainNoLineParam', async () => {
    // FilesTab does not consume `?line=` (deferrals doc); navigation
    // lands on the bare /files route.
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', status: 'stale', filePath: 'src/Foo.cs', lineNumber: 7 }),
      ],
    });
    renderPanel(session);
    await userEvent.click(screen.getByRole('button', { name: /show me/i }));
    await waitFor(() => {
      expect(screen.getByText('FILES_TAB_STUB')).toBeInTheDocument();
    });
  });
});
