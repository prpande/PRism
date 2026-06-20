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

  it('defaults the edge stroke width to 5', () => {
    const { container } = render(<PrismGlyph />);
    for (const line of container.querySelectorAll('line')) {
      expect(line).toHaveAttribute('stroke-width', '5');
    }
  });

  it('honors a strokeWidth override on every edge (decorative ~18px uses need a heavier weight to match neighbouring text / line-icons)', () => {
    const { container } = render(<PrismGlyph strokeWidth={7.5} />);
    for (const line of container.querySelectorAll('line')) {
      expect(line).toHaveAttribute('stroke-width', '7.5');
    }
  });

  it('scales the sparkle proportionally with strokeWidth so a heavier mark keeps a visible sparkle', () => {
    // Default stroke (5) scales the sparkle against the 3.2 reference: 0.72 × 5/3.2 = 1.125.
    const { container: base } = render(<PrismGlyph />);
    expect(base.querySelector('path')!.getAttribute('transform')).toContain('scale(1.125)');
    // The 6.4 reference doubles the sparkle scale (0.72 × 6.4/3.2 = 1.440).
    const { container: heavy } = render(<PrismGlyph strokeWidth={6.4} />);
    expect(heavy.querySelector('path')!.getAttribute('transform')).toContain('scale(1.440)');
    // The decorative ~18px weight (7.5) keeps the larger sparkle approved for /welcome
    // (0.72 × 7.5/3.2 = 1.688) — unchanged by the heavier inline default.
    const { container: deco } = render(<PrismGlyph strokeWidth={7.5} />);
    expect(deco.querySelector('path')!.getAttribute('transform')).toContain('scale(1.688)');
  });
});
