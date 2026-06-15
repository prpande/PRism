import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { DiffPane } from './DiffPane';
import type { DiffMode } from './DiffPane';
import type { FileChange, PrReference } from '../../../../api/types';
import { useAiGate } from '../../../../hooks/useAiGate';
import { useAiHunkAnnotations } from '../../../../hooks/useAiHunkAnnotations';
import { useWholeFileContent } from '../../../../hooks/useWholeFileContent';

vi.mock('../../../../hooks/useAiGate');
vi.mock('../../../../hooks/useAiHunkAnnotations');
vi.mock('../../../../hooks/useWholeFileContent');

const prRef: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

// Two separate change runs (two modify blocks split by context lines).
const twoRunFile: FileChange = {
  path: 'src/main.ts',
  status: 'modified',
  hunks: [
    {
      oldStart: 1,
      oldLines: 6,
      newStart: 1,
      newLines: 6,
      body: `@@ -1,6 +1,6 @@
 line one
-line two
+line two mod
 line three
 line four
-line five
+line five mod
 line six
`,
    },
  ],
};

function renderPane(diffMode: DiffMode = 'unified') {
  return render(
    <DiffPane
      prRef={prRef}
      selectedPath="src/main.ts"
      file={twoRunFile}
      diffMode={diffMode}
      truncated={false}
      reviewThreads={[]}
      prUrl=""
    />,
  );
}

describe('DiffPane change navigation', () => {
  beforeEach(() => {
    vi.mocked(useAiGate).mockReturnValue(false);
    vi.mocked(useAiHunkAnnotations).mockReturnValue(null);
    vi.mocked(useWholeFileContent).mockReturnValue({
      fetchStatus: 'idle',
      headContent: null,
      baseContent: null,
      failureReason: null,
    });
  });

  it('renders the prev/next controls group in the header', () => {
    const { getByRole } = renderPane();
    expect(getByRole('group', { name: /change navigation/i })).toBeInTheDocument();
  });

  it('tags both boundary rows of each run (2 runs → 2 start + 2 end tags)', () => {
    const { container } = renderPane();
    expect(container.querySelectorAll('[data-change-start]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-change-end]')).toHaveLength(2);
  });

  it('tags boundaries in split mode where each -x/+y collapses to one paired row', () => {
    // Split rendering pairs the delete+insert of each block into a single <tr>,
    // so that row must carry BOTH the run's start (via get(idx)) and end (via the
    // `?? idx+1` fallback). Still 2 start + 2 end tags, but exercising the
    // collapse path unified mode never hits.
    const { container } = renderPane('side-by-side');
    expect(container.querySelectorAll('[data-change-start]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-change-end]')).toHaveLength(2);
  });

  it('does not render the rail (ticks) in hunks-only mode', () => {
    const { queryAllByTestId } = renderPane();
    expect(queryAllByTestId('change-tick')).toHaveLength(0);
  });
});
