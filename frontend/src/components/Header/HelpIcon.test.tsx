import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { HelpIcon } from './HelpIcon';

describe('HelpIcon', () => {
  it('renders a decorative svg (aria-hidden, currentColor)', () => {
    const { container } = render(<HelpIcon />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg!.querySelector('[stroke="currentColor"]')).not.toBeNull();
  });
});
