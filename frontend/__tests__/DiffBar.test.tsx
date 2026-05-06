import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { DiffBar } from '../src/components/Inbox/DiffBar';

describe('DiffBar', () => {
  it('renders nothing when both additions and deletions are zero', () => {
    const { container } = render(<DiffBar additions={0} deletions={0} max={10} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('width scales relative to max', () => {
    const { container } = render(<DiffBar additions={5} deletions={5} max={20} />);
    const fill = container.querySelector('[style*="width"]') as HTMLElement;
    // (5+5)/20 = 50%
    expect(fill?.style.width).toBe('50%');
  });

  it('split between additions and deletions matches ratio', () => {
    const { container } = render(<DiffBar additions={9} deletions={1} max={10} />);
    // additions: 9/10 = 90%; deletions: 100% - 90% = 10%
    const widths = Array.from(container.querySelectorAll('span'))
      .map((el) => (el as HTMLElement).style.width)
      .filter((w) => w);
    expect(widths).toContain('90%');
    expect(widths).toContain('10%');
  });

  it('caps width at 100% when total exceeds max', () => {
    const { container } = render(<DiffBar additions={100} deletions={50} max={50} />);
    const widths = Array.from(container.querySelectorAll('span'))
      .map((el) => (el as HTMLElement).style.width)
      .filter((w) => w);
    expect(widths).toContain('100%');
  });
});
