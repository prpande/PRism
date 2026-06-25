import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ChecksTabGlyph } from './ChecksTabGlyph';

describe('ChecksTabGlyph', () => {
  it('renders the amber dot when in-progress', () => {
    const { container } = render(<ChecksTabGlyph lead="in-progress" />);
    expect(container.querySelector('[data-glyph="in-progress"]')).not.toBeNull();
  });
  it('renders the green tick when all-green', () => {
    const { container } = render(<ChecksTabGlyph lead="all-green" />);
    expect(container.querySelector('[data-glyph="all-green"]')).not.toBeNull();
  });
  it('renders nothing when none', () => {
    const { container } = render(<ChecksTabGlyph lead="none" />);
    expect(container.firstChild).toBeNull();
  });
});
