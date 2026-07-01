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
});
