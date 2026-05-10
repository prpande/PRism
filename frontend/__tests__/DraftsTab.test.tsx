import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { DraftsTab } from '../src/components/PrDetail/DraftsTab/DraftsTab';
import type {
  DraftCommentDto,
  DraftReplyDto,
  PrReference,
  ReviewSessionDto,
} from '../src/api/types';
import type { DraftSessionStatus } from '../src/hooks/useDraftSession';
import * as draftApi from '../src/api/draft';

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

function mkReply(overrides: Partial<DraftReplyDto> = {}): DraftReplyDto {
  return {
    id: 'r1',
    parentThreadId: 'PRRT_xyz',
    replyCommentId: null,
    bodyMarkdown: 'reply body',
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

interface RenderOptions {
  session: ReviewSessionDto | null;
  status: DraftSessionStatus;
  refetch?: () => Promise<void>;
  initialPath?: string;
}

function renderDraftsTab(opts: RenderOptions) {
  const refetch = opts.refetch ?? (() => Promise.resolve());
  return render(
    <MemoryRouter initialEntries={[opts.initialPath ?? '/pr/octocat/hello/42/drafts']}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number/drafts"
          element={
            <DraftsTab prRef={ref} session={opts.session} status={opts.status} refetch={refetch} />
          }
        />
        <Route path="/pr/:owner/:repo/:number/files/*" element={<div>FILES_TAB_STUB</div>} />
        <Route path="/pr/:owner/:repo/:number" element={<div>OVERVIEW_TAB_STUB</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('DraftsTab', () => {
  it('RendersLoadingSkeleton_WhilePending', () => {
    renderDraftsTab({ session: null, status: 'loading' });
    expect(screen.getByTestId('drafts-tab-skeleton')).toBeInTheDocument();
  });

  it('RendersErrorCard_OnLoadFailure', () => {
    renderDraftsTab({ session: null, status: 'error' });
    expect(screen.getByText(/Couldn't load drafts/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('Retry_button_invokes_refetch', async () => {
    const refetch = vi.fn(() => Promise.resolve());
    renderDraftsTab({ session: null, status: 'error', refetch });
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('RendersEmptyState_WhenNoDrafts', () => {
    renderDraftsTab({ session: mkSession(), status: 'ready' });
    expect(screen.getByText(/No drafts on this PR yet/i)).toBeInTheDocument();
  });

  it('RendersDraftsGroupedByFile', () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', filePath: 'src/Foo.cs', lineNumber: 10, bodyMarkdown: 'first' }),
        mkComment({ id: 'b', filePath: 'src/Foo.cs', lineNumber: 20, bodyMarkdown: 'second' }),
        mkComment({ id: 'c', filePath: 'src/Bar.cs', lineNumber: 5, bodyMarkdown: 'third' }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    // Two file group headers
    expect(screen.getByText('src/Foo.cs')).toBeInTheDocument();
    expect(screen.getByText('src/Bar.cs')).toBeInTheDocument();
  });

  it('RendersHeader_CountsDraftsAndFiles', () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', filePath: 'src/Foo.cs' }),
        mkComment({ id: 'b', filePath: 'src/Bar.cs' }),
      ],
      draftReplies: [mkReply({ id: 'r1' })],
    });
    renderDraftsTab({ session, status: 'ready' });
    // 3 drafts (2 comments + 1 reply) on 2 files (replies don't add file count)
    expect(screen.getByText(/3 drafts on 2 files/i)).toBeInTheDocument();
  });

  it('RendersStaleBadge_WhenStaleCountGtZero', () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', status: 'stale' }),
        mkComment({ id: 'b', status: 'draft' }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    expect(screen.getByText(/1 stale/i)).toBeInTheDocument();
  });

  it('OverriddenStale_NotCountedAsStale_InHeaderBadge', () => {
    // Per spec § 5.5, the backend reclassifies overridden drafts to status
    // 'draft' so submit is unblocked, but `isOverriddenStale` stays true.
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', status: 'draft', isOverriddenStale: true }),
        mkComment({ id: 'b', status: 'draft' }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    // The header "N stale" count badge is gated on summary.staleCount > 0,
    // which excludes overridden drafts. The override chip ("User-overridden
    // (was Stale)") still renders per-row but is not the count badge.
    expect(screen.queryByText(/^\d+ stale$/i)).not.toBeInTheDocument();
  });

  it('RendersOverrideChip_WhenIsOverriddenStale', () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', status: 'stale', isOverriddenStale: true, bodyMarkdown: 'kept' }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    expect(screen.getByText(/User-overridden/i)).toBeInTheDocument();
  });

  it('RendersMovedChip_WhenStatusMoved', () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'moved', lineNumber: 50 })],
    });
    renderDraftsTab({ session, status: 'ready' });
    expect(screen.getByText(/Moved/i)).toBeInTheDocument();
  });

  it('DiscardAllStaleButton_VisibleOnlyWhenStaleCountGtZero', () => {
    const noStale = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'draft' })],
    });
    const { rerender } = renderDraftsTab({ session: noStale, status: 'ready' });
    expect(screen.queryByRole('button', { name: /discard all stale/i })).not.toBeInTheDocument();

    const oneStale = mkSession({
      draftComments: [mkComment({ id: 'a', status: 'stale' })],
    });
    rerender(
      <MemoryRouter initialEntries={['/pr/octocat/hello/42/drafts']}>
        <Routes>
          <Route
            path="/pr/:owner/:repo/:number/drafts"
            element={
              <DraftsTab
                prRef={ref}
                session={oneStale}
                status="ready"
                refetch={() => Promise.resolve()}
              />
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /discard all stale/i })).toBeInTheDocument();
  });

  it('DiscardAllStaleConfirmModal_ListsCountAndPreviews', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({
          id: 's1',
          status: 'stale',
          filePath: 'src/Foo.cs',
          lineNumber: 10,
          bodyMarkdown: 'preview-foo',
        }),
        mkComment({
          id: 's2',
          status: 'stale',
          filePath: 'src/Bar.cs',
          lineNumber: 20,
          bodyMarkdown: 'preview-bar',
        }),
      ],
      draftReplies: [
        mkReply({
          id: 'rs1',
          parentThreadId: 'PRRT_abc',
          status: 'stale',
          bodyMarkdown: 'preview-rep',
        }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /discard all stale/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/3/); // count
    expect(dialog).toHaveTextContent(/preview-foo/);
    expect(dialog).toHaveTextContent(/preview-bar/);
    expect(dialog).toHaveTextContent(/preview-rep/);
    expect(dialog).toHaveTextContent(/src\/Foo\.cs/);
    expect(dialog).toHaveTextContent(/PRRT_abc/);
  });

  it('DiscardAllStale_OnConfirm_FiresDeletePerStaleId', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 's1', status: 'stale' }),
        mkComment({ id: 's2', status: 'stale' }),
      ],
      draftReplies: [mkReply({ id: 'rs1', status: 'stale' })],
    });
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /discard all stale/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
    const calls = spy.mock.calls.map((c) => c[1].kind);
    expect(calls).toEqual(
      expect.arrayContaining(['deleteDraftComment', 'deleteDraftComment', 'deleteDraftReply']),
    );
  });

  it('DiscardAllStale_KeepsModalOpenAndShowsError_OnPartialFailure', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 's1', status: 'stale' }),
        mkComment({ id: 's2', status: 'stale' }),
      ],
    });
    // First call fails, second succeeds. Modal must stay open and surface
    // the failure count so the user is not silently misled.
    let callCount = 0;
    const spy = vi.spyOn(draftApi, 'sendPatch').mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: false as const,
          status: 0,
          kind: 'network' as const,
          body: 'fetch failed',
        });
      }
      return Promise.resolve({ ok: true as const, assignedId: null });
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /discard all stale/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    // Modal still open, error message visible.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/1 draft could not be discarded/i);
  });

  it('OverriddenStale_NotIncluded_InDiscardAllStale', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 's1', status: 'stale' }),
        mkComment({ id: 's2', status: 'stale', isOverriddenStale: true }),
      ],
    });
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /discard all stale/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'deleteDraftComment',
      payload: { id: 's1' },
    });
  });

  it('EditAction_NavigatesToFilesTabAndOpensComposer', async () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', filePath: 'src/Foo.cs', lineNumber: 42 })],
    });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => {
      expect(screen.getByText('FILES_TAB_STUB')).toBeInTheDocument();
    });
  });

  it('EditAction_OnPrRootDraft_NavigatesToOverview', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({
          id: 'pr-root',
          filePath: null,
          lineNumber: null,
          side: null,
          anchoredSha: null,
          anchoredLineContent: null,
        }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /^edit$/i }));
    await waitFor(() => {
      expect(screen.getByText('OVERVIEW_TAB_STUB')).toBeInTheDocument();
    });
  });

  it('DeleteAction_OpensConfirmation_FocusesCancel', async () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', bodyMarkdown: 'body to confirm' })],
    });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Discard this draft/i);
    expect(dialog).toHaveTextContent(/body to confirm/i);
    // Focus on Cancel per spec § 5.5a
    expect(within(dialog).getByRole('button', { name: /cancel/i })).toHaveFocus();
  });

  it('DeleteAction_OnSuccess_CallsRefetch', async () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', bodyMarkdown: '' })],
    });
    const refetch = vi.fn(() => Promise.resolve());
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready', refetch });
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    // Empty body → no confirm modal → direct delete → refetch.
    await waitFor(() => expect(refetch).toHaveBeenCalledTimes(1));
  });

  it('DiscardAllStale_OnFullSuccess_CallsRefetch', async () => {
    const session = mkSession({
      draftComments: [
        mkComment({ id: 's1', status: 'stale' }),
        mkComment({ id: 's2', status: 'stale' }),
      ],
    });
    const refetch = vi.fn(() => Promise.resolve());
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready', refetch });
    await userEvent.click(screen.getByRole('button', { name: /discard all stale/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(refetch).toHaveBeenCalled());
  });

  it('PrRootGroupHeading_ReadsPrConversationDrafts_NotPrRootReplies', () => {
    const session = mkSession({
      draftComments: [
        mkComment({
          id: 'pr-root',
          filePath: null,
          lineNumber: null,
          side: null,
          anchoredSha: null,
          anchoredLineContent: null,
        }),
      ],
    });
    renderDraftsTab({ session, status: 'ready' });
    // Heading must be inclusive of both PR-root comments and replies.
    expect(screen.getByText(/PR conversation drafts/i)).toBeInTheDocument();
    expect(screen.queryByText(/PR-root replies/i)).not.toBeInTheDocument();
  });

  it('DeleteAction_OnEmptyBody_DeletesWithoutConfirmation', async () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', bodyMarkdown: '' })],
    });
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'deleteDraftComment',
      payload: { id: 'a' },
    });
  });

  it('DeleteAction_OnConfirm_FiresDeletePatch', async () => {
    const session = mkSession({
      draftComments: [mkComment({ id: 'a', bodyMarkdown: 'something' })],
    });
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    renderDraftsTab({ session, status: 'ready' });
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, {
      kind: 'deleteDraftComment',
      payload: { id: 'a' },
    });
  });
});
