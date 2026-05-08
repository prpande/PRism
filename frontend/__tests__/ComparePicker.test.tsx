import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ComparePicker } from '../src/components/PrDetail/FilesTab/ComparePicker';
import type { IterationDto } from '../src/api/types';

function iter(n: number, hasResolvableRange = true): IterationDto {
  return {
    number: n,
    beforeSha: `before${n}`,
    afterSha: `after${n}`,
    commits: [],
    hasResolvableRange,
  };
}

describe('ComparePicker', () => {
  it('renders two iteration selectors', () => {
    render(
      <ComparePicker
        iterations={[iter(1), iter(2), iter(3)]}
        fromIter={1}
        toIter={3}
        onCompare={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/from/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/to/i)).toBeInTheDocument();
  });

  it('calls onCompare with correct range when selection changes', () => {
    const onCompare = vi.fn();
    render(
      <ComparePicker
        iterations={[iter(1), iter(2), iter(3)]}
        fromIter={1}
        toIter={3}
        onCompare={onCompare}
      />,
    );
    fireEvent.change(screen.getByLabelText(/from/i), { target: { value: '2' } });
    expect(onCompare).toHaveBeenCalledWith(2, 3);
  });

  it('auto-swaps when from > to', () => {
    const onCompare = vi.fn();
    render(
      <ComparePicker
        iterations={[iter(1), iter(2), iter(3)]}
        fromIter={1}
        toIter={2}
        onCompare={onCompare}
      />,
    );
    fireEvent.change(screen.getByLabelText(/from/i), { target: { value: '3' } });
    expect(onCompare).toHaveBeenCalledWith(2, 3);
  });

  it('shows empty state when from === to', () => {
    render(
      <ComparePicker iterations={[iter(1), iter(2)]} fromIter={1} toIter={1} onCompare={vi.fn()} />,
    );
    expect(screen.getByText(/no changes between/i)).toBeInTheDocument();
  });

  it('disables non-resolvable iterations in selectors', () => {
    render(
      <ComparePicker
        iterations={[iter(1, false), iter(2)]}
        fromIter={null}
        toIter={2}
        onCompare={vi.fn()}
      />,
    );
    const fromSelect = screen.getByLabelText(/from/i) as HTMLSelectElement;
    const options = fromSelect.querySelectorAll('option');
    const lostOption = Array.from(options).find((o) => o.textContent?.includes('snapshot lost'));
    expect(lostOption?.disabled).toBe(true);
  });
});
