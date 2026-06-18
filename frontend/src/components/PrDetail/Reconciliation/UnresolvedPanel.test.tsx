import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { UnresolvedPanel } from './UnresolvedPanel';
import * as draftApi from '../../../api/draft';
import type { DraftCommentDto, PrReference, ReviewSessionDto } from '../../../api/types';
import styles from './UnresolvedPanel.module.css';
import staleStyles from './StaleDraftRow.module.css';
import { useAiGate } from '../../../hooks/useAiGate';
import { useAiDraftSuggestions } from '../../../hooks/useAiDraftSuggestions';

vi.mock('../../../hooks/useAiGate');
vi.mock('../../../hooks/useAiDraftSuggestions');

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
    postedCommentId: null,
    ...overrides,
  };
}

function mkSession(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
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

// UnresolvedPanel → StaleDraftRow is always-visible chrome that renders during
// the pre-load window, BEFORE PrDetailPage builds its data-gated context
// provider. So onSelectSubTab is threaded as an explicit prop (not read from
// the PrDetail context) to keep the chrome crash-free pre-load. The Show-me
// test asserts the spy was called with the target sub-tab id. No provider is
// mounted here, mirroring production. The FILES_TAB_STUB route remains harmless.
function renderPanel(session: ReviewSessionDto, opts: RenderOpts = {}) {
  const onMutated = opts.onMutated ?? vi.fn();
  const onSelectSubTab = vi.fn();
  const result = render(
    <MemoryRouter initialEntries={[opts.initialPath ?? '/pr/octocat/hello/42']}>
      <Routes>
        <Route
          path="/pr/:owner/:repo/:number"
          element={
            <UnresolvedPanel
              prRef={ref}
              session={session}
              onMutated={onMutated}
              onSelectSubTab={onSelectSubTab}
            />
          }
        />
        <Route path="/pr/:owner/:repo/:number/files/*" element={<div>FILES_TAB_STUB</div>} />
      </Routes>
    </MemoryRouter>,
  );
  return { ...result, onSelectSubTab };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// Default safe values for mocked AI hooks — individual tests override as needed.
beforeEach(() => {
  vi.mocked(useAiGate).mockReturnValue(false);
  vi.mocked(useAiDraftSuggestions).mockReturnValue(null);
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
    expect(screen.getByTestId('unresolved-panel')).toBeInTheDocument();
  });

  it('AppliesBothLiteralAndModuleClasses_OnVisibleSection', () => {
    const session = mkSession({ draftComments: [mkComment({ id: 'a', status: 'stale' })] });
    renderPanel(session);
    const section = screen.getByTestId('unresolved-panel');
    expect(section).toHaveClass('unresolved-panel');
    expect(section).toHaveClass(styles.unresolvedPanel);
  });

  it('StaleDraftRow_AppliesBothLiteralAndModuleClasses', () => {
    const session = mkSession({ draftComments: [mkComment({ id: 'a', status: 'stale' })] });
    renderPanel(session);
    const region = screen.getByRole('region', { name: /unresolved drafts/i });
    const li = region.querySelector('li.stale-draft-row');
    expect(li).not.toBeNull();
    expect(li).toHaveClass(staleStyles.staleDraftRow);
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
              element={
                <UnresolvedPanel
                  prRef={ref}
                  session={reconciled}
                  onMutated={vi.fn()}
                  onSelectSubTab={vi.fn()}
                />
              }
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

  it('ShowMe_OnFileDraft_SelectsFilesSubTab_PlainNoLineParam', async () => {
    // FilesTab does not consume `?line=` (deferrals doc); Show-me selects the
    // bare Files sub-tab via onSelectSubTab (no URL / line param).
    const session = mkSession({
      draftComments: [
        mkComment({ id: 'a', status: 'stale', filePath: 'src/Foo.cs', lineNumber: 7 }),
      ],
    });
    const { onSelectSubTab } = renderPanel(session);
    await userEvent.click(screen.getByRole('button', { name: /show me/i }));
    await waitFor(() => {
      expect(onSelectSubTab).toHaveBeenCalledWith('files');
    });
  });
});

// Helper: builds a session with a stale comment draft anchored at src/Calc.cs:3
// (matches Task 1's PlaceholderData alignment). Copies the canonical mkSession/mkComment
// shape used throughout this file.
function buildSessionFixture(): ReviewSessionDto {
  return mkSession({
    draftComments: [
      mkComment({
        id: 'ai-test-d1',
        filePath: 'src/Calc.cs',
        lineNumber: 3,
        status: 'stale',
        bodyMarkdown: 'existing draft body',
      }),
    ],
  });
}

describe('UnresolvedPanel — StaleDraftRow AI suggestion (D48)', () => {
  it('renders no stale-draft-ai-suggestion when gate is off', () => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiDraftSuggestions).mockReturnValue(null);
    renderPanel(buildSessionFixture());
    expect(screen.queryByTestId('stale-draft-ai-suggestion')).not.toBeInTheDocument();
  });

  it('renders .stale-ai with sparkles icon + "AI suggestion" label + body when suggestion matches anchor', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiDraftSuggestions).mockReturnValue([
      { filePath: 'src/Calc.cs', lineNumber: 3, body: 'Worth a comment here?' },
    ]);
    renderPanel(buildSessionFixture());
    const ai = screen.getByTestId('stale-draft-ai-suggestion');
    expect(ai).toBeInTheDocument();
    const icon = ai.querySelector('.ai-icon');
    expect(icon).toBeInTheDocument();
    expect(icon).toHaveAttribute('data-ai-marker');
    expect(ai.querySelector('.ai-icon svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByText('Worth a comment here?')).toBeInTheDocument();
  });

  it('does NOT render stale-draft-ai-suggestion when suggestion does not match the draft anchor', () => {
    vi.mocked(useAiGate).mockReturnValue(true);
    vi.mocked(useAiDraftSuggestions).mockReturnValue([
      { filePath: 'src/Other.cs', lineNumber: 99, body: 'Mismatched anchor.' },
    ]);
    renderPanel(buildSessionFixture());
    expect(screen.queryByTestId('stale-draft-ai-suggestion')).not.toBeInTheDocument();
  });
});
