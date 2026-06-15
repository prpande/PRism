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
  it('suppresses a radio NOT inside .diff-view-toggle', () => {
    // Only the diff-view tiles are whitelisted; a radio elsewhere is a plain INPUT.
    const radio = document.createElement('input');
    radio.type = 'radio';
    expect(isInputTarget(radio)).toBe(true);
  });
  it('suppresses inside a contenteditable region', () => {
    // The composer is contenteditable; naked-key shortcuts must not fire while typing.
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    editable.appendChild(child);
    expect(isInputTarget(child)).toBe(true);
  });
});
