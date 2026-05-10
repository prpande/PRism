import { render, screen, waitFor, within } from '@testing-library/react';
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

function renderPanel(session: ReviewSessionDto, initialPath = '/pr/octocat/hello/42') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number"
          element={<UnresolvedPanel prRef={ref} session={session} />}
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

  it('VerdictReconfirmRow_FiresConfirmVerdictPatch', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const session = mkSession({ draftVerdictStatus: 'needs-reconfirm' });
    renderPanel(session);
    const button = screen.getByRole('button', { name: /confirm verdict/i });
    await userEvent.click(button);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, { kind: 'confirmVerdict' });
  });

  it('KeepAnyway_FiresOverrideStalePatch', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    const session = mkSession({
      draftComments: [mkComment({ id: 'stale-1', status: 'stale' })],
    });
    renderPanel(session);
    await userEvent.click(screen.getByRole('button', { name: /keep anyway/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'overrideStale',
      payload: { id: 'stale-1' },
    });
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
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    const { rerender } = renderPanel(session);
    // Initial mount: announces "1 drafts need attention" or similar.
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    const live = region.querySelector('[aria-live="polite"]') as HTMLElement;
    expect(live.textContent).toMatch(/1 draft needs attention/i);

    // Transition: stale drops to zero. Panel hides; the announce message
    // moves to "All drafts reconciled." in a final render before unmount.
    const reconciled = mkSession();
    rerender(
      <MemoryRouter initialEntries={['/pr/octocat/hello/42']}>
        <Routes>
          <Route
            path="/pr/:owner/:repo/:number"
            element={<UnresolvedPanel prRef={ref} session={reconciled} announceReconciled />}
          />
        </Routes>
      </MemoryRouter>,
    );
    // Panel now renders ONLY a hidden announce region with the reconciled message.
    const liveAfter = document.querySelector('[aria-live="polite"]') as HTMLElement | null;
    expect(liveAfter?.textContent).toMatch(/all drafts reconciled/i);
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

  it('ShowMe_OnFileDraft_NavigatesToFilesTab', async () => {
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
