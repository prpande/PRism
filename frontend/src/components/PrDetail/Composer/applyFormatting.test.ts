import { describe, it, expect, vi } from 'vitest';
import { applyFormatting } from './applyFormatting';

function makeTextarea(value: string, selStart: number, selEnd: number): HTMLTextAreaElement {
  const ta = document.createElement('textarea');
  ta.value = value;
  document.body.appendChild(ta);
  ta.focus();
  ta.setSelectionRange(selStart, selEnd);
  return ta;
}

describe('applyFormatting', () => {
  it('applies the engine edit to the textarea value (fallback path)', () => {
    const ta = makeTextarea('foo bar', 4, 7);
    const onChange = vi.fn();
    applyFormatting(ta, 'bold', onChange);
    expect(ta.value).toBe('foo **bar**');
    expect(onChange).toHaveBeenCalledWith('foo **bar**');
  });

  it('leaves the engine selection on the textarea', () => {
    const ta = makeTextarea('see foo', 4, 7);
    const sel = applyFormatting(ta, 'link', () => {});
    // "[foo](url)" — "url" is selected
    expect(ta.value).toBe('see [foo](url)');
    expect(ta.value.slice(ta.selectionStart, ta.selectionEnd)).toBe('url');
    expect(sel.selectionStart).toBe(ta.selectionStart);
    expect(sel.selectionEnd).toBe(ta.selectionEnd);
  });

  it('parks the caret so the next typed character lands inside the pair', () => {
    const ta = makeTextarea('x ', 2, 2);
    applyFormatting(ta, 'bold', () => {});
    // "x ****", caret between the pairs at index 4
    ta.setRangeText('Z', ta.selectionStart, ta.selectionEnd, 'end');
    expect(ta.value).toBe('x **Z**');
  });

  it('warns once (dev) when execCommand is unavailable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ta = makeTextarea('a', 0, 1);
    applyFormatting(ta, 'bold', () => {});
    // jsdom has no execCommand insertText -> fallback -> dev warn at most once
    warn.mockRestore();
    expect(ta.value).toBe('**a**');
  });

  it('refuses to mutate a readOnly textarea (autosave-race defense-in-depth)', () => {
    const ta = makeTextarea('foo', 0, 3);
    ta.readOnly = true;
    const onChange = vi.fn();
    applyFormatting(ta, 'bold', onChange);
    expect(ta.value).toBe('foo'); // unchanged
    expect(onChange).not.toHaveBeenCalled();
  });
});
