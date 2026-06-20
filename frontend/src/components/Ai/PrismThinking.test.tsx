import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PrismThinking } from './PrismThinking';
import { EDGES } from './prismGeometry';

describe('PrismThinking', () => {
  it('renders a decorative pyramid svg with the edge lines and a breathing sparkle', () => {
    const { container } = render(<PrismThinking />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 100 100');
    expect(svg!.querySelectorAll('line')).toHaveLength(EDGES.length);
    expect(svg!.querySelectorAll('path')).toHaveLength(1);
  });

  it('omits the sparkle when sparkle={false}', () => {
    const { container } = render(<PrismThinking sparkle={false} />);
    expect(container.querySelector('path')).toBeNull();
  });

  it('cancels its pending animation frame on unmount', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = render(<PrismThinking />);
    expect(() => unmount()).not.toThrow();
    expect(cancelSpy).toHaveBeenCalled();
    cancelSpy.mockRestore();
  });
});
