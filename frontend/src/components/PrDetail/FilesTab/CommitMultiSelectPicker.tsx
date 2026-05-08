import { useState, useRef, useEffect, useCallback } from 'react';
import type { CommitDto } from '../../../api/types';

export interface CommitMultiSelectPickerProps {
  commits: CommitDto[];
  selectedShas: string[] | null;
  onSelectionChange: (shas: string[] | null) => void;
}

export function CommitMultiSelectPicker({
  commits,
  selectedShas,
  onSelectionChange,
}: CommitMultiSelectPickerProps) {
  const [open, setOpen] = useState(false);
  const [focusIndex, setFocusIndex] = useState(-1);
  const listboxRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const sorted = [...commits].sort(
    (a, b) => new Date(b.committedDate).getTime() - new Date(a.committedDate).getTime(),
  );

  const isShowAll = selectedShas === null;
  const triggerLabel = isShowAll
    ? `Showing changes from all ${commits.length} commits`
    : `Showing changes from ${selectedShas.length} of ${commits.length} commits`;

  const handleToggleCommit = useCallback(
    (sha: string) => {
      if (isShowAll) {
        onSelectionChange([sha]);
        return;
      }
      const idx = selectedShas.indexOf(sha);
      if (idx >= 0) {
        const next = selectedShas.filter((s) => s !== sha);
        onSelectionChange(next.length === 0 ? null : next);
      } else {
        onSelectionChange([...selectedShas, sha]);
      }
    },
    [isShowAll, selectedShas, onSelectionChange],
  );

  const handleShowAll = useCallback(() => {
    onSelectionChange(null);
  }, [onSelectionChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const totalItems = sorted.length + 1;
      switch (e.key) {
        case 'Escape':
          setOpen(false);
          triggerRef.current?.focus();
          break;
        case 'ArrowDown':
          e.preventDefault();
          setFocusIndex((i) => (i + 1) % totalItems);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setFocusIndex((i) => (i - 1 + totalItems) % totalItems);
          break;
        case 'Home':
          e.preventDefault();
          setFocusIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setFocusIndex(totalItems - 1);
          break;
        case ' ':
        case 'Enter':
          e.preventDefault();
          if (focusIndex === 0) {
            handleShowAll();
          } else if (focusIndex > 0) {
            handleToggleCommit(sorted[focusIndex - 1].sha);
          }
          break;
      }
    },
    [sorted, focusIndex, handleShowAll, handleToggleCommit],
  );

  useEffect(() => {
    if (!open) return;
    listboxRef.current?.focus();
  }, [open]);

  const listboxId = 'commit-picker-listbox';

  return (
    <div className="commit-multi-select-picker">
      <button
        ref={triggerRef}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-haspopup="listbox"
        className="commit-picker-trigger"
        onClick={() => {
          setOpen((o) => !o);
          setFocusIndex(0);
        }}
      >
        {triggerLabel} ▾
      </button>

      {open && (
        <div
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-multiselectable="true"
          aria-label="Select commits"
          tabIndex={-1}
          className="commit-picker-listbox"
          onKeyDown={handleKeyDown}
        >
          <div
            role="option"
            aria-selected={isShowAll}
            className={`commit-picker-option${focusIndex === 0 ? ' commit-picker-option--focused' : ''}`}
            onClick={handleShowAll}
          >
            Show all
          </div>
          {sorted.map((c, i) => {
            const isSelected = !isShowAll && selectedShas.includes(c.sha);
            return (
              <div
                key={c.sha}
                role="option"
                aria-selected={isSelected}
                className={`commit-picker-option${focusIndex === i + 1 ? ' commit-picker-option--focused' : ''}`}
                onClick={() => handleToggleCommit(c.sha)}
              >
                <span className="commit-picker-message">
                  {c.message.length > 72 ? c.message.slice(0, 72) + '…' : c.message}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
