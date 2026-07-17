import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { GitHubMark } from './GitHubMark';

describe('GitHubMark', () => {
  it('renders a decorative svg at the default 14px size', () => {
    const { container } = render(<GitHubMark />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('width', '14');
    expect(svg).toHaveAttribute('height', '14');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('fill', 'currentColor');
  });

  it('honors a custom size', () => {
    const { container } = render(<GitHubMark size={22} />);
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('width', '22');
    expect(svg).toHaveAttribute('height', '22');
  });
});
