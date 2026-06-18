import { describe, it, expect } from 'vitest';
import { splitRationale } from './splitRationale';

describe('splitRationale', () => {
  it('conforming: first prose line is the headline, the rest is the body', () => {
    const { headline, body } = splitRationale('Boundary handling in core calc\n- a\n- b');
    expect(headline).toBe('Boundary handling in core calc');
    expect(body).toBe('- a\n- b');
  });

  it('conforming: strips markdown from the synopsis line', () => {
    expect(splitRationale('**Bold** synopsis\n- detail').headline).toBe('Bold synopsis');
  });

  it('conforming synopsis-only (no body) yields an empty body', () => {
    expect(splitRationale('Just a one-line synopsis')).toEqual({
      headline: 'Just a one-line synopsis',
      body: '',
    });
  });

  it('skips leading blank lines to find the synopsis', () => {
    const { headline, body } = splitRationale('\n\nBoundary handling\n- a');
    expect(headline).toBe('Boundary handling');
    expect(body).toBe('- a');
  });

  it('non-conforming bullet-first: keeps the FULL rationale in the body (no content loss)', () => {
    const { headline, body } = splitRationale('- first bullet\n- second bullet');
    expect(headline).toBe('first bullet'); // a usable preview
    // critical: the first bullet is NOT removed from the body
    expect(body).toContain('first bullet');
    expect(body).toContain('second bullet');
  });

  it('empty input yields empty headline and body', () => {
    expect(splitRationale('')).toEqual({ headline: '', body: '' });
  });
});
