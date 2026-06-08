import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingBar } from './LoadingBar';

describe('LoadingBar', () => {
  it('reflects active state via data-active', () => {
    const { rerender } = render(<LoadingBar active={false} />);
    expect(screen.getByTestId('loading-bar')).toHaveAttribute('data-active', 'false');
    rerender(<LoadingBar active />);
    expect(screen.getByTestId('loading-bar')).toHaveAttribute('data-active', 'true');
  });

  it('is aria-hidden (the per-surface skeleton carries busy state for AT)', () => {
    render(<LoadingBar active />);
    expect(screen.getByTestId('loading-bar').closest('[aria-hidden="true"]')).not.toBeNull();
  });
});
