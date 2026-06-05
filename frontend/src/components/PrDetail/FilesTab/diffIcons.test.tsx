// diffIcons.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { InlineDiffIcon, SideBySideDiffIcon, GearIcon } from './diffIcons';

describe('diffIcons', () => {
  it('renders each icon as an aria-hidden svg with a single column / two columns / gear shape', () => {
    const { container: unified } = render(<InlineDiffIcon />);
    const { container: split } = render(<SideBySideDiffIcon />);
    const { container: gear } = render(<GearIcon />);

    for (const c of [unified, split, gear]) {
      const svg = c.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('aria-hidden')).toBe('true');
      expect(svg!.getAttribute('focusable')).toBe('false');
    }
    // Split has a vertical divider line that unified does not.
    expect(split.querySelector('line[x1="8"][x2="8"]')).not.toBeNull();
    expect(unified.querySelector('line[x1="8"][x2="8"]')).toBeNull();
  });
});
