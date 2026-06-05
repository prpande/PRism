import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { useFilesTabShortcuts } from './useFilesTabShortcuts';

function Harness({
  onToggleDiffMode,
  onNextFile,
}: {
  onToggleDiffMode: () => void;
  onNextFile: () => void;
}) {
  useFilesTabShortcuts({
    onNextFile,
    onPrevFile: () => {},
    onToggleViewed: () => {},
    onToggleDiffMode,
  });
  return (
    <div>
      <div role="radiogroup">
        <input type="radio" data-testid="r" />
      </div>
      <input type="checkbox" data-testid="c" />
      <textarea data-testid="t" />
    </div>
  );
}

describe('useFilesTabShortcuts INPUT guard', () => {
  it('fires from a radiogroup radio but stays suppressed in checkboxes and text fields', () => {
    const onToggle = vi.fn();
    const onNext = vi.fn();
    const { getByTestId } = render(<Harness onToggleDiffMode={onToggle} onNextFile={onNext} />);

    getByTestId('r').focus();
    getByTestId('r').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    getByTestId('c').focus();
    getByTestId('c').dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true }));
    expect(onNext).not.toHaveBeenCalled();

    getByTestId('t').focus();
    getByTestId('t').dispatchEvent(new KeyboardEvent('keydown', { key: 'd', bubbles: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
