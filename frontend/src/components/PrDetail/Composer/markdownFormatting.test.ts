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

describe('applyMarkdownFormat — quote / bulleted / task', () => {
  it('prefixes every selected non-empty line with "> "', () => {
    const r = applyMarkdownFormat('quote', 'a\nb', 0, 3);
    expect(r.value).toBe('> a\n> b');
  });

  it('toggles the quote prefix off when all non-empty lines carry it', () => {
    const r = applyMarkdownFormat('quote', '> a\n> b', 0, 7);
    expect(r.value).toBe('a\nb');
  });

  it('uses "- " (hyphen) for bulleted lists, not "*"', () => {
    const r = applyMarkdownFormat('bulleted', 'a\nb', 0, 3);
    expect(r.value).toBe('- a\n- b');
  });

  it('uses GFM "- [ ] " for task lists', () => {
    const r = applyMarkdownFormat('task', 'do it', 0, 5);
    expect(r.value).toBe('- [ ] do it');
  });

  it('leaves blank lines unprefixed', () => {
    const r = applyMarkdownFormat('bulleted', 'a\n\nb', 0, 4);
    expect(r.value).toBe('- a\n\n- b');
  });

  it('does NOT destroy a task line when Bulleted is applied to it', () => {
    // "- " is a prefix of "- [ ] "; bulleted must not strip a task into "[ ] do it".
    const r = applyMarkdownFormat('bulleted', '- [ ] do it', 0, 11);
    expect(r.value).toBe('- [ ] do it'); // no-op, not "[ ] do it"
  });

  it('converts an existing bullet to a task instead of double-prefixing', () => {
    const r = applyMarkdownFormat('task', '- do it', 0, 7);
    expect(r.value).toBe('- [ ] do it'); // not "- [ ] - do it"
  });
});

describe('applyMarkdownFormat — numbered list', () => {
  it('numbers each non-empty line sequentially from 1.', () => {
    const r = applyMarkdownFormat('numbered', 'a\nb\nc', 0, 5);
    expect(r.value).toBe('1. a\n2. b\n3. c');
  });

  it('toggles numbering off when every non-empty line is already numbered', () => {
    const r = applyMarkdownFormat('numbered', '1. a\n2. b', 0, 9);
    expect(r.value).toBe('a\nb');
  });
});

describe('applyMarkdownFormat — heading cycle', () => {
  it('adds "### " (H3) by default', () => {
    const r = applyMarkdownFormat('heading', 'Title', 0, 5);
    expect(r.value).toBe('### Title');
  });

  it('cycles ### -> ## on a second application', () => {
    const r = applyMarkdownFormat('heading', '### Title', 0, 9);
    expect(r.value).toBe('## Title');
  });

  it('cycles ## -> #', () => {
    const r = applyMarkdownFormat('heading', '## Title', 0, 8);
    expect(r.value).toBe('# Title');
  });

  it('cycles # -> stripped', () => {
    const r = applyMarkdownFormat('heading', '# Title', 0, 7);
    expect(r.value).toBe('Title');
  });

  it('applies a uniform level across a multi-line selection from the first line', () => {
    // Documented, accepted behavior: the block cycles as a unit off the first
    // non-empty line's level (## -> #), not per-line. Mixed-level blocks are rare;
    // this keeps the action a single predictable cycle rather than a per-line mix.
    const r = applyMarkdownFormat('heading', '## A\n# B', 0, 8);
    expect(r.value).toBe('# A\n# B');
  });
});
