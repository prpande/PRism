import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CommentGlyph } from './CommentGlyph';

describe('CommentGlyph', () => {
  it('renders an aria-hidden currentColor svg', () => {
    const { container } = render(<CommentGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg).not.toBeNull();
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('fill')).toBe('currentColor');
    expect(svg.querySelector('path')).not.toBeNull();
  });

  it('forwards className to the svg', () => {
    const { container } = render(<CommentGlyph className="foo" />);
    expect(container.querySelector('svg')!.getAttribute('class')).toBe('foo');
  });

  it('renders the outline bubble by default — no fill, no tick (inbox)', () => {
    const { container } = render(<CommentGlyph />);
    expect(container.querySelector('[data-comment-fill]')).toBeNull();
    expect(container.querySelector('[data-resolved-tick]')).toBeNull();
    // one path: the outline bubble
    expect(container.querySelectorAll('path')).toHaveLength(1);
  });

  it('renders a solid bubble (no tick) when filled — the open/unresolved state', () => {
    const { container } = render(<CommentGlyph variant="filled" />);
    expect(container.querySelector('[data-comment-fill]')).not.toBeNull();
    expect(container.querySelector('[data-resolved-tick]')).toBeNull();
  });

  it('overlays the CI-passing check in --success-fg when resolved', () => {
    const { container } = render(<CommentGlyph variant="resolved" />);
    const tick = container.querySelector('[data-resolved-tick]');
    expect(tick).not.toBeNull();
    // green comes from the design-system success glyph token, not currentColor
    expect(tick!.getAttribute('fill')).toBe('var(--success-fg)');
    // no solid fill on the resolved bubble — it stays an outline
    expect(container.querySelector('[data-comment-fill]')).toBeNull();
    // bubble is still present (dimmed via the slot's currentColor)
    expect(container.querySelectorAll('path').length).toBeGreaterThanOrEqual(2);
  });
});
