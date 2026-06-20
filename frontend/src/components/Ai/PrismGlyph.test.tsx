import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PrismGlyph } from './PrismGlyph';
import { EDGES } from './prismGeometry';

describe('PrismGlyph', () => {
  it('renders a decorative pyramid svg with the edge lines and a sparkle', () => {
    const { container } = render(<PrismGlyph />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 100 100');
    // One <line> per pyramid edge, plus a <path> for the sparkle.
    expect(svg!.querySelectorAll('line')).toHaveLength(EDGES.length);
    expect(svg!.querySelectorAll('path')).toHaveLength(1);
  });

  it('omits the sparkle when sparkle={false}', () => {
    const { container } = render(<PrismGlyph sparkle={false} />);
    expect(container.querySelector('path')).toBeNull();
    expect(container.querySelectorAll('line')).toHaveLength(EDGES.length);
  });

  it('accepts a className for sizing and a size override', () => {
    const { container } = render(<PrismGlyph size={12} className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '12');
    expect(svg).toHaveClass('x');
  });
});
