import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useState, useCallback } from 'react';
import { HotspotsTab } from './HotspotsTab';
import { PrDetailContextProvider, type PrDetailContextValue } from '../prDetailContext';
import type { PrTabId } from '../PrSubTabStrip';
import type { FileFocus } from '../../../api/types';

// Integration through context: HotspotsTab's row click must drive the SAME
// navigation intent PrDetailView owns (requestFileView → switch to Files +
// stash pendingFilePath). The wrapper reproduces PrDetailView's requestFileView
// wiring (selectSubTab('files') + setPendingFilePath) so the test asserts the
// contract that crosses the context boundary, without depending on FilesTab's
// deep-link effects (a separate batch).
function Harness({
  entries,
  onSelectSubTab,
}: {
  entries: FileFocus[];
  onSelectSubTab: (tab: PrTabId) => void;
}) {
  const [pendingFilePath, setPendingFilePath] = useState<string | null>(null);
  const requestFileView = useCallback(
    (path: string) => {
      onSelectSubTab('files');
      setPendingFilePath(path);
    },
    [onSelectSubTab],
  );
  const value: PrDetailContextValue = {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prDetail: {} as PrDetailContextValue['prDetail'],
    draftSession: {} as PrDetailContextValue['draftSession'],
    readOnly: false,
    subscribed: true,
    baseShaChanged: false,
    onSelectSubTab,
    fileFocus: { status: 'ok', entries, retry: vi.fn() },
    checks: { status: 'idle', degraded: 'none', checks: [], retry: vi.fn() },
    pendingFilePath,
    requestFileView,
    clearPendingFilePath: () => setPendingFilePath(null),
    viewedPaths: new Set(),
    toggleViewed: () => {},
  };
  return (
    <PrDetailContextProvider value={value}>
      <HotspotsTab />
      <div data-testid="pending">{pendingFilePath ?? ''}</div>
    </PrDetailContextProvider>
  );
}

describe('HotspotsTab (integration through context)', () => {
  it('clicking a row switches to the Files tab and sets the pending file path', () => {
    const onSelectSubTab = vi.fn();
    render(
      <Harness
        onSelectSubTab={onSelectSubTab}
        entries={[
          { path: 'src/Calc.cs', level: 'high', rationale: 'core billing math' },
          { path: 'src/Calc.Tests.cs', level: 'medium', rationale: 'tests' },
        ]}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /open src\/Calc\.cs in diff/i }));

    expect(onSelectSubTab).toHaveBeenCalledWith('files');
    expect(screen.getByTestId('pending').textContent).toBe('src/Calc.cs');
  });
});
