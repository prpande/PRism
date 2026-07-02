import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffPane } from './DiffPane';
import type { FileChange, PrReference } from '../../../../api/types';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';

vi.mock('../../../../hooks/useWholeFileContent');

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// Exactly the shape GitHub returns for an ADDED text file (verified live against
// mindbody/Mindbody.BizApp.Bff PR #195): status "added", header "@@ -0,0 +1,N @@",
// every body line "+"-prefixed. All-insert ⇒ the old-side gutter is legitimately
// empty, so the new-side number is the ONLY number on every row.
const addedFile: FileChange = {
  path: 'src/NewType.cs',
  status: 'added',
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 3,
      body: '@@ -0,0 +1,3 @@\n+using System;\n+\n+namespace Foo;',
    },
  ],
};

// Added file whose lines reach 4 digits — exercises gutter width sizing.
const bigAddedFile: FileChange = {
  path: 'src/Big.cs',
  status: 'added',
  hunks: [
    {
      oldStart: 0,
      oldLines: 0,
      newStart: 1200,
      newLines: 4,
      body: '@@ -0,0 +1200,4 @@\n+a\n+b\n+c\n+d',
    },
  ],
};

// The line number visible to the user must live OUTSIDE the hover-only comment
// affordance button. Strip buttons, then read what text remains in each
// new-side gutter cell — that is what shows at rest.
function newGutterNumbersAtRest(): string[] {
  return Array.from(document.querySelectorAll('.diff-gutter--new'))
    .map((cell) => {
      const clone = cell.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('button').forEach((b) => b.remove());
      return clone.textContent?.trim() ?? '';
    })
    .filter((t) => t !== '');
}

describe('DiffPane — added-file line numbers (#554)', () => {
  beforeEach(() => {
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
  });

  it('shows new-side numbers at rest (not only inside the hover affordance) — unified', () => {
    render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/NewType.cs"
        file={addedFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        htmlUrl=""
        onLineClick={() => {}}
      />,
    );
    expect(newGutterNumbersAtRest()).toEqual(['1', '2', '3']);
  });

  it('shows new-side numbers at rest (not only inside the hover affordance) — split', () => {
    render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/NewType.cs"
        file={addedFile}
        diffMode="side-by-side"
        truncated={false}
        reviewThreads={[]}
        htmlUrl=""
        onLineClick={() => {}}
      />,
    );
    expect(newGutterNumbersAtRest()).toEqual(['1', '2', '3']);
  });

  it('keeps the comment affordance reachable by its aria-label (click contract intact)', () => {
    render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/NewType.cs"
        file={addedFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        htmlUrl=""
        onLineClick={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add comment on line 1' })).toBeInTheDocument();
  });

  it('renders a filled comment glyph (not a "+") in the hover affordance', () => {
    render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/NewType.cs"
        file={addedFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        htmlUrl=""
        onLineClick={() => {}}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Add comment on line 1' });
    expect(btn.querySelector('svg')).not.toBeNull();
    expect(btn.textContent).not.toContain('+');
  });

  it('sizes the gutter from the widest line number in the file', () => {
    render(
      <DiffPane
        prRef={prRef}
        selectedPath="src/Big.cs"
        file={bigAddedFile}
        diffMode="unified"
        truncated={false}
        reviewThreads={[]}
        htmlUrl=""
        onLineClick={() => {}}
      />,
    );
    expect(screen.getByTestId('diff-pane').style.getPropertyValue('--diff-gutter-digits')).toBe(
      '4',
    );
  });
});
