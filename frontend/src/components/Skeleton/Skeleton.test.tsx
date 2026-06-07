import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Skeleton, SkeletonText } from './Skeleton';

describe('Skeleton', () => {
  it('renders a shimmer block with the given dimensions and is aria-hidden', () => {
    render(<Skeleton width="60%" height={14} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el).toHaveAttribute('aria-hidden', 'true');
    expect(el.style.width).toBe('60%');
    expect(el.style.height).toBe('14px');
  });

  it('renders a circle when circle is set', () => {
    render(<Skeleton circle width={24} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.style.borderRadius).toBe('50%');
  });

  it('circle with only width falls back to a square (height = width) so it does not collapse to 0px', () => {
    // Regression: `.block` is display:block, so a circle given width but no
    // height collapses to 0px tall and renders invisible (avatar stubs).
    render(<Skeleton circle width={20} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.style.width).toBe('20px');
    expect(el.style.height).toBe('20px');
  });

  it('circle with only height falls back to a square (width = height)', () => {
    render(<Skeleton circle height={20} data-testid="sk" />);
    const el = screen.getByTestId('sk');
    expect(el.style.width).toBe('20px');
    expect(el.style.height).toBe('20px');
  });

  it('SkeletonText renders the requested number of lines and is aria-hidden', () => {
    render(<SkeletonText lines={3} data-testid="lines" />);
    const root = screen.getByTestId('lines');
    expect(root.children).toHaveLength(3);
    expect(root).toHaveAttribute('aria-hidden', 'true');
  });
});
