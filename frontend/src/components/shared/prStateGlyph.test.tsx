import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PrStateGlyph, PR_GLYPH_PATH, PR_GLYPH_CLASS, PR_GLYPH_LABEL } from './prStateGlyph';

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

describe('PrStateGlyph component', () => {
  it('renders the octicon path + tooltip for each state', () => {
    for (const state of ['open', 'merged', 'closed', 'draft'] as const) {
      const { container, unmount } = render(<PrStateGlyph state={state} />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('data-pr-state')).toBe(state);
      // Decorative by default — state rides the accessible name of the host.
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(container.querySelector('title')!.textContent).toBe(PR_GLYPH_LABEL[state]);
      expect(container.querySelector('path')!.getAttribute('d')).toBe(PR_GLYPH_PATH[state]);
      unmount();
    }
  });

  it('applies the state colour class and any extra className', () => {
    const { container } = render(<PrStateGlyph state="merged" className="extra" />);
    const svg = container.querySelector('svg')!;
    // The shared colour class (prMerged) and the caller-supplied class both land.
    expect(svg.className.baseVal).toMatch(/prMerged/);
    expect(svg.className.baseVal).toMatch(/extra/);
  });
});
