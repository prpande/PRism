import { useEffect } from 'react';
import type { FormattingHandle } from './formattingHandle';
import type { FormatAction } from './markdownFormatting';

const KEY_TO_ACTION: Record<string, FormatAction> = {
  b: 'bold',
  i: 'italic',
  k: 'link',
  e: 'code',
};

// Binds Ctrl/Cmd+B/I/K/E on the handle's textarea to the shared runAction. A
// native listener (not the textarea's onKeyDown prop) so it composes with the
// composer's existing matchComposerKey handler without rewiring it. Honors the
// same disable gate as the buttons (§Autosave-race safety): inert under
// posting/read-only, so a mid-post shortcut cannot schedule a draft PUT that
// races the in-flight post.
export function useFormattingShortcuts(
  handle: FormattingHandle,
  runAction: (action: FormatAction) => void,
): void {
  const { textareaRef, disabled, previewMode } = handle;
  // `previewMode` is in the dep list even though the handler doesn't read it:
  // on the inline/reply composers the textarea UNMOUNTS in preview and a fresh
  // element mounts on return to edit. The RefObject identity is stable and
  // `disabled` doesn't change on a preview toggle, so without `previewMode` the
  // effect would never re-run and the listener would stay bound to the old
  // (unmounted) element — Ctrl/Cmd+B/I/K/E would silently die after any
  // Write->Preview->Write cycle. Re-running on `previewMode` re-reads
  // `textareaRef.current` (the new element) and rebinds.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (disabled) return;
      if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      const action = KEY_TO_ACTION[e.key.toLowerCase()];
      if (!action) return;
      e.preventDefault();
      runAction(action);
    };
    ta.addEventListener('keydown', onKeyDown);
    return () => ta.removeEventListener('keydown', onKeyDown);
  }, [textareaRef, disabled, previewMode, runAction]);
}
