import { describe, it, expect } from 'vitest';
import { isInputTarget } from './isInputTarget';

describe('isInputTarget', () => {
  it('returns false for non-elements', () => {
    expect(isInputTarget(null)).toBe(false);
  });
  it('suppresses inside a textarea/input/select', () => {
    const ta = document.createElement('textarea');
    expect(isInputTarget(ta)).toBe(true);
  });
  it('lets through radios inside .diff-view-toggle', () => {
    const group = document.createElement('div');
    group.className = 'diff-view-toggle';
    const radio = document.createElement('input');
    radio.type = 'radio';
    group.appendChild(radio);
    expect(isInputTarget(radio)).toBe(false);
  });
});
