// frontend/src/components/Ai/SparkIcon.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SparkIcon } from './SparkIcon';

describe('SparkIcon', () => {
  it('renders a decorative svg with the sparkle paths', () => {
    const { container } = render(<SparkIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', '0 0 18 18');
    expect(svg!.querySelectorAll('path')).toHaveLength(2);
  });

  it('accepts a className for sizing and a size override', () => {
    const { container } = render(<SparkIcon size={12} className="x" />);
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '12');
    expect(svg).toHaveClass('x');
  });
});
