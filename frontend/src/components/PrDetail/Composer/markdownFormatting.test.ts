import { describe, it, expect } from 'vitest';
import { applyMarkdownFormat } from './markdownFormatting';

describe('applyMarkdownFormat — bold', () => {
  it('wraps a selection in ** ** and keeps the core selected', () => {
    // "foo bar" with "bar" (4..7) selected
    const r = applyMarkdownFormat('bold', 'foo bar', 4, 7);
    expect(r.value).toBe('foo **bar**');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('inserts an empty pair with the caret parked between on an empty selection', () => {
    const r = applyMarkdownFormat('bold', 'foo ', 4, 4);
    expect(r.value).toBe('foo ****');
    expect(r.selectionStart).toBe(6);
    expect(r.selectionEnd).toBe(6);
  });

  it('toggles off when the selection already includes the markers', () => {
    const r = applyMarkdownFormat('bold', 'foo **bar**', 4, 11); // "**bar**" selected
    expect(r.value).toBe('foo bar');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('toggles off when the selection sits inside an existing pair (bold-inside-bold)', () => {
    const r = applyMarkdownFormat('bold', '**bar**', 2, 5); // "bar" selected, markers outside
    expect(r.value).toBe('bar');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });

  it('keeps a trailing space outside the markers', () => {
    const r = applyMarkdownFormat('bold', 'foo bar ', 4, 8); // "bar " selected (trailing space)
    expect(r.value).toBe('foo **bar** ');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('bar');
  });
});

describe('applyMarkdownFormat — italic', () => {
  it('wraps with single underscores (GFM), not asterisks', () => {
    const r = applyMarkdownFormat('italic', 'a foo b', 2, 5);
    expect(r.value).toBe('a _foo_ b');
  });

  it('does NOT treat a surrounding ** bold ** boundary as an italic pair', () => {
    // selecting "foo" inside **foo** must ADD italic, not strip bold
    const r = applyMarkdownFormat('italic', '**foo**', 2, 5);
    expect(r.value).toBe('**_foo_**');
  });

  it('does NOT merge adjacent independent runs on toggle-off (_a_b_c_)', () => {
    // "b" (3..4) sits between two SEPARATE _..._ runs. The outside-marker
    // toggle-off must not fire (that would strip a/c into "_abc_"); ADD instead.
    const r = applyMarkdownFormat('italic', '_a_b_c_', 3, 4);
    expect(r.value).toBe('_a__b__c_');
  });
});

describe('applyMarkdownFormat — strikethrough', () => {
  it('wraps with ~~ ~~', () => {
    const r = applyMarkdownFormat('strikethrough', 'foo', 0, 3);
    expect(r.value).toBe('~~foo~~');
  });
});

describe('applyMarkdownFormat — code', () => {
  it('wraps a single-line selection in inline backticks', () => {
    const r = applyMarkdownFormat('code', 'foo bar', 4, 7);
    expect(r.value).toBe('foo `bar`');
  });

  it('toggles inline backticks off', () => {
    const r = applyMarkdownFormat('code', 'foo `bar`', 4, 9);
    expect(r.value).toBe('foo bar');
  });

  it('wraps a multi-line selection in a fenced block', () => {
    const r = applyMarkdownFormat('code', 'a\nb', 0, 3);
    expect(r.value).toBe('```\na\nb\n```');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('a\nb');
  });

  it('strips a selected fenced block (toggle off)', () => {
    const r = applyMarkdownFormat('code', '```\na\nb\n```', 0, 11);
    expect(r.value).toBe('a\nb');
  });
});

describe('applyMarkdownFormat — link', () => {
  it('wraps a selection as [selection](url) with url selected', () => {
    const r = applyMarkdownFormat('link', 'see foo', 4, 7);
    expect(r.value).toBe('see [foo](url)');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('url');
  });

  it('inserts [text](url) with text selected on an empty selection', () => {
    const r = applyMarkdownFormat('link', '', 0, 0);
    expect(r.value).toBe('[text](url)');
    expect(r.value.slice(r.selectionStart, r.selectionEnd)).toBe('text');
  });
});
