import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { LevelGlyph } from './LevelGlyph';

describe('LevelGlyph', () => {
  it('is decorative (aria-hidden) and carries the level as a data attribute', () => {
    const { container } = render(<LevelGlyph level="high" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('data-level', 'high');
  });

  it('encodes level by active-bar count: high=3, medium=2, low=1', () => {
    const active = (level: 'high' | 'medium' | 'low') => {
      const { container } = render(<LevelGlyph level={level} />);
      return container.querySelectorAll('rect[data-active="true"]').length;
    };
    expect(active('high')).toBe(3);
    expect(active('medium')).toBe(2);
    expect(active('low')).toBe(1);
  });
});
