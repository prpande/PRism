import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Logo } from './Logo';

describe('Logo', () => {
  it('shows the visible "PRism" wordmark and makes the mark decorative when showName', () => {
    const { container } = render(<Logo showName />);
    // The name is presented as visible text...
    expect(screen.getByText('PRism')).toBeInTheDocument();
    // ...so the image is decorative (empty alt) and must not double-announce the name.
    expect(screen.queryByAltText('PRism')).toBeNull();
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('carries the name on the mark (alt="PRism") and renders no visible text by default', () => {
    render(<Logo />);
    expect(screen.queryByText('PRism')).toBeNull();
    expect(screen.getByAltText('PRism')).toBeInTheDocument();
  });
});
