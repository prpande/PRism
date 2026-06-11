import { describe, it, expect } from 'vitest';
import { badgeLabel } from './useComposerAutoSave';

describe('badgeLabel', () => {
  it('maps each save state to a capitalized label', () => {
    expect(badgeLabel('saved')).toBe('Saved');
    expect(badgeLabel('saving')).toBe('Saving…');
    expect(badgeLabel('unsaved')).toBe('Unsaved');
    expect(badgeLabel('rejected')).toBe('Save failed');
  });
});
