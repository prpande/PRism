const INPUT_TAG_NAMES = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

/** True when a naked-key shortcut should be suppressed for this event target. */
export function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // ONLY the inline diff-view tiles (radios inside the .diff-view-toggle group)
  // may let the single-key Files-tab shortcuts through. Scoped to that specific
  // class — not any [role="radiogroup"] — so a future radiogroup elsewhere on the
  // page cannot inadvertently leak shortcuts. Everything else — text fields AND the
  // gear's checkboxes — still suppresses.
  if (
    target.tagName === 'INPUT' &&
    (target as HTMLInputElement).type === 'radio' &&
    target.closest('.diff-view-toggle')
  ) {
    return false;
  }
  if (INPUT_TAG_NAMES.has(target.tagName)) return true;
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}
