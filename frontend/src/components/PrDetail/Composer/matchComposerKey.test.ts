import { describe, it, expect } from 'vitest';
import { matchComposerKey } from './matchComposerKey';
import type { KeyboardEvent } from 'react';

type K = Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>;
const ev = (e: K) => e as unknown as KeyboardEvent;

describe('matchComposerKey', () => {
  it('Cmd+Shift+P → toggle-preview', () => {
    expect(matchComposerKey(ev({ metaKey: true, shiftKey: true, key: 'P' }))).toBe(
      'toggle-preview',
    );
    expect(matchComposerKey(ev({ ctrlKey: true, shiftKey: true, key: 'p' }))).toBe(
      'toggle-preview',
    );
  });
  it('Cmd/Ctrl+Enter → submit', () => {
    expect(matchComposerKey(ev({ metaKey: true, key: 'Enter' }))).toBe('submit');
    expect(matchComposerKey(ev({ ctrlKey: true, key: 'Enter' }))).toBe('submit');
  });
  it('Escape → escape', () => {
    expect(matchComposerKey(ev({ key: 'Escape' }))).toBe('escape');
  });
  it('non-matching keys → null', () => {
    expect(matchComposerKey(ev({ key: 'a' }))).toBeNull();
    expect(matchComposerKey(ev({ key: 'Enter' }))).toBeNull();
    expect(matchComposerKey(ev({ metaKey: true, key: 'P' }))).toBeNull();
  });
});
