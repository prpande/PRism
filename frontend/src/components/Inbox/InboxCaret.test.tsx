import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InboxCaret } from './InboxCaret';

describe('InboxCaret', () => {
  it('renders an SVG chevron, not a unicode glyph', () => {
    const { container } = render(<InboxCaret open={false} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(container.textContent).not.toContain('▸');
    expect(container.textContent).not.toContain('▾');
  });

  it('applies the open (rotated) class only when open', () => {
    const closed = render(<InboxCaret open={false} />).container.firstElementChild!;
    const open = render(<InboxCaret open={true} />).container.firstElementChild!;
    // The open variant carries an extra class (the rotation modifier).
    expect(open.className.split(' ').length).toBeGreaterThan(closed.className.split(' ').length);
  });
});
