import { describe, it, expect } from 'vitest';
import { PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL } from './prStateGlyph';

describe('prStateGlyph', () => {
  it('has a path, class, and label for every state including draft', () => {
    for (const state of ['open', 'merged', 'closed', 'draft'] as const) {
      expect(PR_GLYPH_PATH[state]).toMatch(/^M/); // non-empty SVG path data
      expect(PR_GLYPH_CLASS[state]).toBeTruthy();
      expect(PR_GLYPH_LABEL[state]).toBeTruthy();
    }
  });

  it('maps classes and labels to the expected values', () => {
    expect(PR_GLYPH_CLASS.draft).toBe('prDraft');
    expect(PR_GLYPH_LABEL.draft).toBe('Draft PR');
    expect(PR_GLYPH_LABEL.open).toBe('PR open');
    expect(PR_GLYPH_LABEL.merged).toBe('PR merged');
    expect(PR_GLYPH_LABEL.closed).toBe('PR closed');
  });
});
