import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import type { PrInboxItem, InboxSection as InboxSectionDto } from '../../api/types';

// #671 — count InboxRow renders by spying on DiffBar, which every InboxRow renders
// exactly once (InboxRow.tsx `.diffCell`). A parent re-render that leaves the row's
// props referentially stable must NOT re-run this spy once InboxRow is React.memo'd.
const { diffBarRenders } = vi.hoisted(() => ({ diffBarRenders: vi.fn() }));
vi.mock('./DiffBar', () => ({
  DiffBar: () => {
    diffBarRenders();
    return null;
  },
}));

// Import AFTER the mock so InboxRow/InboxSection pick up the spied DiffBar.
import { InboxRow } from './InboxRow';
import { InboxSection } from './InboxSection';

function prFor(owner: string, repo: string, n: number): PrInboxItem {
  return {
    reference: { owner, repo, number: n },
    title: `PR ${n}`,
    author: 'a',
    repo: `${owner}/${repo}`,
    updatedAt: '2026-05-01T00:00:00Z',
    pushedAt: '2026-05-01T00:00:00Z',
    commitCount: 1,
    changedFiles: 0,
    commentCount: 0,
    additions: 0,
    deletions: 0,
    headSha: 'x',
    ci: 'none',
    lastViewedHeadSha: null,
    lastSeenCommentId: null,
    mergedAt: null,
    closedAt: null,
    isDraft: false,
  };
}

function makeSection(id: string, items: PrInboxItem[]): InboxSectionDto {
  return { id, label: id, items };
}

function shell(children: React.ReactNode) {
  return (
    <MemoryRouter>
      <OpenTabsProvider>{children}</OpenTabsProvider>
    </MemoryRouter>
  );
}

// Referentially stable props declared once, so re-rendering the parent hands
// InboxRow the exact same references — the only thing that should let the memo bail.
const STABLE_PR = prFor('acme', 'api', 1);
const STABLE_SETTLED: ReadonlySet<string> = new Set();

describe('InboxRow memoization (#671)', () => {
  it('does not re-render when a parent re-renders with referentially stable props', () => {
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN((x) => x + 1)}>bump {n}</button>
          <InboxRow
            pr={STABLE_PR}
            showCategoryChip={false}
            maxDiff={100}
            settled={STABLE_SETTLED}
          />
        </>
      );
    }
    render(shell(<Harness />));
    const baseline = diffBarRenders.mock.calls.length;

    // Two unrelated parent re-renders (mirrors an SSE frame / rail poll that leaves this
    // row's data unchanged). Without React.memo the row re-renders on each → +2.
    fireEvent.click(screen.getByRole('button', { name: /bump/i }));
    fireEvent.click(screen.getByRole('button', { name: /bump/i }));
    expect(diffBarRenders.mock.calls.length).toBe(baseline);
  });

  it('a parent re-render through InboxSection does not re-render unchanged rows when `settled` is omitted', () => {
    // `settled` is omitted here so InboxSection falls back to its default. A fresh
    // `new Set()` default parameter would hand every row a new identity on each render
    // and silently defeat InboxRow's memo — this locks in the module-level EMPTY_SETTLED.
    const section = makeSection('review-requested', [
      prFor('acme', 'api', 1),
      prFor('acme', 'api', 2),
    ]);
    function Harness() {
      const [n, setN] = useState(0);
      return (
        <>
          <button onClick={() => setN((x) => x + 1)}>bump {n}</button>
          <InboxSection section={section} enrichments={{}} showCategoryChip={false} maxDiff={100} />
        </>
      );
    }
    render(shell(<Harness />));
    const baseline = diffBarRenders.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: /bump/i }));
    fireEvent.click(screen.getByRole('button', { name: /bump/i }));
    // Rows are unchanged across the parent re-renders. A fresh `new Set()` default would
    // hand them a new `settled` identity each render and re-render both rows → +4.
    expect(diffBarRenders.mock.calls.length).toBe(baseline);
  });
});
