import { describe, it, expect } from 'vitest';
import { SHORTCUTS } from './shortcuts';

describe('SHORTCUTS', () => {
  it('lists n and p in the Diff group', () => {
    const diff = SHORTCUTS.find((g) => g.group === 'Diff');
    const keys = diff?.rows.map((r) => r.keys) ?? [];
    expect(keys).toContain('n');
    expect(keys).toContain('p');
  });
});
