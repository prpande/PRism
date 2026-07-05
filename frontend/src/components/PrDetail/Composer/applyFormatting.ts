import { applyMarkdownFormat, type FormatAction } from './markdownFormatting';

let warnedOnce = false;

// Smallest [start, oldEnd) span that differs between oldStr and newStr, plus the
// replacement text for that span. Keeps execCommand's undo entry scoped to the
// region the format actually changed instead of the whole buffer.
function minimalReplaceSpan(
  oldStr: string,
  newStr: string,
): { start: number; oldEnd: number; replacement: string } {
  let start = 0;
  const minLen = Math.min(oldStr.length, newStr.length);
  while (start < minLen && oldStr[start] === newStr[start]) start += 1;
  let oldEnd = oldStr.length;
  let newEnd = newStr.length;
  while (oldEnd > start && newEnd > start && oldStr[oldEnd - 1] === newStr[newEnd - 1]) {
    oldEnd -= 1;
    newEnd -= 1;
  }
  return { start, oldEnd, replacement: newStr.slice(start, newEnd) };
}

/**
 * Apply a markdown transform to a textarea, preserving native undo where the
 * runtime supports it (Chromium/Electron: execCommand('insertText')). Falls back
 * to setRangeText (jsdom, non-Chromium) with a one-time dev warning because that
 * path does not push a native undo entry. Returns the target selection so the
 * caller can re-assert it after React commits (see FormattingToolbar caret token).
 */
export function applyFormatting(
  textarea: HTMLTextAreaElement,
  action: FormatAction,
  onChange: (next: string) => void,
): { selectionStart: number; selectionEnd: number } {
  // Defense-in-depth for the #601/#644 autosave-vs-post race. The toolbar/shortcut
  // `disabled` gate already blocks this, but the actual body mutation happens
  // HERE and setRangeText ignores the `readOnly` attribute — so enforce the lock
  // where the write occurs. `readOnly` reflects `readOnly || posting` on all three
  // composers, so a mutation during a post is refused even if a call site's guard
  // is ever dropped.
  if (textarea.readOnly) {
    return { selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd };
  }

  const value = textarea.value;
  const result = applyMarkdownFormat(action, value, textarea.selectionStart, textarea.selectionEnd);
  const span = minimalReplaceSpan(value, result.value);

  textarea.focus();
  textarea.setSelectionRange(span.start, span.oldEnd);

  let ok = false;
  try {
    ok = document.execCommand('insertText', false, span.replacement);
  } catch {
    // execCommand threw (jsdom / non-Chromium) — `ok` stays false, fallback below.
  }
  // `!ok` covers the jsdom / non-Chromium case; the value-equality check also
  // catches a runtime that returns true but silently no-ops insertText, so the
  // fallback still lands the edit instead of dropping it. Overwrite the FULL
  // buffer with `result.value` here rather than replaying `span` (offsets into
  // the original pre-mutation value): if execCommand returned true but left the
  // textarea in some other state entirely (neither the original nor the engine
  // result), replaying those stale offsets against the current buffer could
  // corrupt it. A full-buffer overwrite reconstructs the exact engine result
  // regardless of what execCommand did to `textarea.value`.
  if (!ok || textarea.value !== result.value) {
    if (import.meta.env?.DEV && !warnedOnce) {
      warnedOnce = true;
      console.warn(
        '[applyFormatting] execCommand insertText unavailable; falling back to setRangeText (native undo not preserved).',
      );
    }
    textarea.setRangeText(result.value, 0, textarea.value.length, 'preserve');
  }

  onChange(textarea.value);
  textarea.setSelectionRange(result.selectionStart, result.selectionEnd);
  return { selectionStart: result.selectionStart, selectionEnd: result.selectionEnd };
}
