import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DraftSuggestion, DraftCommentDto } from '../../../api/types';
import type { DraftLike } from '../draftKinds';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { StaleDraftRow } from './StaleDraftRow';

const PR_REF = { owner: 'acme', repo: 'api', number: 123 };

const draftComment: DraftCommentDto = {
  id: 'c1',
  filePath: 'src/index.ts',
  lineNumber: 10,
  side: 'right',
  anchoredSha: 'abc',
  anchoredLineContent: 'const x = 1;',
  bodyMarkdown: 'this looks stale',
  status: 'stale',
  isOverriddenStale: false,
  postedCommentId: null,
};

const draft: DraftLike = { kind: 'comment', data: draftComment };

const aiSuggestion: DraftSuggestion = {
  filePath: 'src/index.ts',
  lineNumber: 10,
  body: 'Re-anchor this comment to the moved line.',
};

beforeEach(() => {
  mock.aiMode = 'preview';
});

describe('StaleDraftRow sample badge', () => {
  it('renders the badge in the aiSuggestion branch in preview', () => {
    render(
      <ul>
        <StaleDraftRow
          prRef={PR_REF}
          draft={draft}
          onMutated={() => {}}
          aiSuggestion={aiSuggestion}
          onSelectSubTab={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('stale-draft-ai-suggestion')).toBeInTheDocument();
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
  });

  it('omits the badge in off', () => {
    mock.aiMode = 'off';
    render(
      <ul>
        <StaleDraftRow
          prRef={PR_REF}
          draft={draft}
          onMutated={() => {}}
          aiSuggestion={aiSuggestion}
          onSelectSubTab={() => {}}
        />
      </ul>,
    );
    expect(screen.getByTestId('stale-draft-ai-suggestion')).toBeInTheDocument();
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });

  it('renders the AiMarker, keeps the "AI suggestion" label, drops the emoji', () => {
    render(
      <ul>
        <StaleDraftRow
          prRef={PR_REF}
          draft={draft}
          onMutated={() => {}}
          aiSuggestion={aiSuggestion}
          onSelectSubTab={() => {}}
        />
      </ul>,
    );
    const block = screen.getByTestId('stale-draft-ai-suggestion');
    expect(within(block).getByTestId('ai-marker')).toBeInTheDocument();
    expect(within(block).getByText('AI suggestion')).toBeInTheDocument();
    expect(block.textContent).not.toContain('✨');
  });
});
