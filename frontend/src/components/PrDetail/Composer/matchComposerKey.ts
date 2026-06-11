import type { KeyboardEvent } from 'react';

export type ComposerShortcut = 'toggle-preview' | 'submit' | 'escape';

/**
 * Pure key-combo matcher shared by the three composers. Element-type agnostic
 * (diff composers bind onKeyDown to the textarea, PrRootReplyComposer to its
 * outer div). Returns which shortcut fired, or null. Behavior dispatch stays
 * local to each composer.
 */
export function matchComposerKey(e: KeyboardEvent): ComposerShortcut | null {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'P' || e.key === 'p')) {
    return 'toggle-preview';
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    return 'submit';
  }
  if (e.key === 'Escape') {
    return 'escape';
  }
  return null;
}
