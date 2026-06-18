import { describe, it, expect } from 'vitest';
import { stripMarkdown } from './stripMarkdown';

describe('stripMarkdown', () => {
  it('strips a leading bullet marker and bold emphasis', () => {
    expect(stripMarkdown('- **Core** logic')).toBe('Core logic');
  });
  it('strips a heading marker', () => {
    expect(stripMarkdown('## Risk area')).toBe('Risk area');
  });
  it('strips inline-code backticks', () => {
    expect(stripMarkdown('`fn()` changed')).toBe('fn() changed');
  });
  it('reduces a link to its text', () => {
    expect(stripMarkdown('[see this](http://x.test)')).toBe('see this');
  });
  it('reduces an image to its alt text', () => {
    expect(stripMarkdown('![alt text](http://x.test/i.png)')).toBe('alt text');
  });
  it('returns the first non-empty line', () => {
    expect(stripMarkdown('\n\n- first\n- second')).toBe('first');
  });
  it('strips italic and strikethrough markers', () => {
    expect(stripMarkdown('_italic_ and ~~struck~~')).toBe('italic and struck');
  });
  it('returns empty string for empty input', () => {
    expect(stripMarkdown('')).toBe('');
  });
  it('skips a leading code-fence marker, not surfacing the language tag', () => {
    const out = stripMarkdown('```cs\nif (x) throw;\n```\n- note');
    expect(out).not.toBe('cs');
    expect(out).toBe('if (x) throw;');
  });
});
