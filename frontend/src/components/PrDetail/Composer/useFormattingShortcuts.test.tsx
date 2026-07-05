import { describe, it, expect, vi } from 'vitest';
import { useRef } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useFormattingShortcuts } from './useFormattingShortcuts';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';

function Harness({
  disabled,
  runAction,
  previewMode = false,
  keepMounted = false,
}: {
  disabled: boolean;
  runAction: (a: FormatAction) => void;
  previewMode?: boolean;
  // When true, mirror the Overview composer (PrRootReplyComposer): the textarea
  // stays MOUNTED across preview toggles, hidden rather than unmounted. When
  // false (default), mirror the inline/reply composers: it UNMOUNTS in preview.
  keepMounted?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const handle: FormattingHandle = {
    textareaRef: ref,
    value: '',
    onChange: () => {},
    previewMode,
    onTogglePreview: () => {},
    disabled,
  };
  useFormattingShortcuts(handle, runAction);
  if (keepMounted) return <textarea ref={ref} aria-label="body" hidden={previewMode} />;
  return previewMode ? <div>preview</div> : <textarea ref={ref} aria-label="body" />;
}

describe('useFormattingShortcuts', () => {
  it('maps Ctrl+B/I/K/E to the matching actions', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    const ta = getByLabelText('body');
    fireEvent.keyDown(ta, { key: 'b', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'i', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'e', ctrlKey: true });
    expect(runAction.mock.calls.map((c) => c[0])).toEqual(['bold', 'italic', 'link', 'code']);
  });

  it('also maps the Cmd (meta) variants', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', metaKey: true });
    expect(runAction).toHaveBeenCalledWith('bold');
  });

  it('fires NO action while disabled (autosave-race safety)', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={true} runAction={runAction} />);
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', ctrlKey: true });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('ignores reserved combos (Ctrl+Enter, Ctrl+Shift+P)', () => {
    const runAction = vi.fn();
    const { getByLabelText } = render(<Harness disabled={false} runAction={runAction} />);
    const ta = getByLabelText('body');
    fireEvent.keyDown(ta, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(ta, { key: 'p', ctrlKey: true, shiftKey: true });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('fires NO action in preview even when the textarea stays mounted (Overview composer)', () => {
    // The Overview composer keeps the textarea mounted (hidden) in preview. The
    // format buttons are hidden there, so the shortcuts must be inert too — the
    // handler's previewMode guard enforces this without relying on the hidden
    // element being unfocusable (jsdom dispatches keydown to it regardless).
    const runAction = vi.fn();
    const { getByLabelText } = render(
      <Harness disabled={false} runAction={runAction} previewMode={true} keepMounted={true} />,
    );
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', ctrlKey: true });
    expect(runAction).not.toHaveBeenCalled();
  });

  it('re-binds to the new textarea after a preview round-trip', () => {
    const runAction = vi.fn();
    const { getByLabelText, rerender } = render(
      <Harness disabled={false} runAction={runAction} previewMode={false} />,
    );
    // Enter preview: the original textarea unmounts.
    rerender(<Harness disabled={false} runAction={runAction} previewMode={true} />);
    // Return to edit: a NEW textarea mounts; the listener must rebind to it.
    rerender(<Harness disabled={false} runAction={runAction} previewMode={false} />);
    fireEvent.keyDown(getByLabelText('body'), { key: 'b', ctrlKey: true });
    expect(runAction).toHaveBeenCalledWith('bold');
  });
});
