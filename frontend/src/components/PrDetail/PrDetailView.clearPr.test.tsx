import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import { AiFailureContext, type AiFailureApi } from '../Ai/aiFailure';
import { PrDetailView } from './PrDetailView';
import type { PrReference } from '../../api/types';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';

// ---------------------------------------------------------------------------
// Mirror the vi.mock set from PrDetailView.test.tsx so a bare render doesn't
// crash or hit the network. Copied verbatim from that file.
// ---------------------------------------------------------------------------

const PR_DETAIL = makePrDetailDto({
  pr: makePr({
    reference: { owner: 'o', repo: 'r', number: 1 },
    title: 'Test PR',
    author: 'alice',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  }),
});

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: PR_DETAIL,
    isLoading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDraftSession', () => ({
  useDraftSession: () => ({
    session: { draftComments: [], draftReplies: [], draftVerdictStatus: 'none' },
    status: 'ready',
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    registerOpenComposer: vi.fn(() => () => {}),
    getPrRootHolder: vi.fn(() => null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
  }),
}));

vi.mock('../../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({
    hasUpdate: false,
    headShaChanged: false,
    baseShaChanged: false,
    commentCountDelta: 0,
    isMerged: false,
    isClosed: false,
    subscribed: true,
    clear: vi.fn(),
  }),
}));

vi.mock('../../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));

vi.mock('../../hooks/useRootCommentPostedSubscriber', () => ({
  useRootCommentPostedSubscriber: () => {},
}));

vi.mock('../../hooks/useSingleCommentPostedSubscriber', () => ({
  useSingleCommentPostedSubscriber: () => {},
}));

vi.mock('../../hooks/useDraftSubmittedSubscriber', () => ({
  useDraftSubmittedSubscriber: () => {},
}));

vi.mock('../../hooks/useCrossTabPrPresence', () => ({
  useCrossTabPrPresence: () => ({
    readOnly: false,
    showBanner: false,
    switchToOther: vi.fn(),
    takeOver: vi.fn(),
    dismissForSession: vi.fn(),
  }),
}));

vi.mock('../../hooks/useReconcile', () => ({
  useReconcile: () => ({
    reload: vi.fn().mockResolvedValue(undefined),
    banner: null,
    clearBanner: vi.fn(),
  }),
}));

vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
}));

vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));

vi.mock('../../hooks/useFileFocusResult', () => ({
  useFileFocusResult: () => ({ status: 'idle', entries: [] }),
}));

vi.mock('../../hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));

vi.mock('../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));

vi.mock('../../hooks/useAiSummary', () => ({
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
}));

vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => null,
}));

vi.mock('../../hooks/useFilesTabShortcuts', () => ({
  useFilesTabShortcuts: () => {},
}));

vi.mock('../../hooks/useFirstActivePrPollComplete', () => ({
  useFirstActivePrPollComplete: () => true,
}));

// ---------------------------------------------------------------------------

const PR: PrReference = { owner: 'o', repo: 'r', number: 1 };

function stubApi(over: Partial<AiFailureApi> = {}): AiFailureApi {
  return {
    report: vi.fn(),
    clear: vi.fn(),
    clearPr: vi.fn(),
    retryAll: vi.fn(),
    dismiss: vi.fn(),
    activeFailedSeams: [],
    retrying: false,
    dismissed: false,
    ...over,
  };
}

it('fires clearPr(prRef) when PrDetailView unmounts', () => {
  const clearPr = vi.fn();
  const { unmount } = render(
    <MemoryRouter initialEntries={['/pr/o/r/1']}>
      <OpenTabsProvider>
        <AskAiDrawerProvider>
          <ToastProvider>
            <AiFailureContext.Provider value={stubApi({ clearPr })}>
              <PrDetailView prRef={PR} active />
            </AiFailureContext.Provider>
          </ToastProvider>
        </AskAiDrawerProvider>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
  expect(clearPr).not.toHaveBeenCalled();
  unmount();
  expect(clearPr).toHaveBeenCalledWith(PR);
});
