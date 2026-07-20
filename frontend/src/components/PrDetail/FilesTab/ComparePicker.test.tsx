import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ComparePicker } from './ComparePicker';
import type { IterationDto } from '../../../api/types';

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
    expect(screen.getByRole('combobox', { name: /from/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /to/i })).toBeInTheDocument();
  });

  it('calls onCompare with correct range when selection changes', async () => {
    const onCompare = vi.fn();
    render(
      <ComparePicker
        iterations={[iter(1), iter(2), iter(3)]}
        fromIter={1}
        toIter={3}
        onCompare={onCompare}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: /from/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Iter 2' }));
    expect(onCompare).toHaveBeenCalledWith(2, 3);
  });

  it('auto-swaps when from > to', async () => {
    const onCompare = vi.fn();
    render(
      <ComparePicker
        iterations={[iter(1), iter(2), iter(3)]}
        fromIter={1}
        toIter={2}
        onCompare={onCompare}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: /from/i }));
    await userEvent.click(screen.getByRole('option', { name: 'Iter 3' }));
    expect(onCompare).toHaveBeenCalledWith(2, 3);
  });

  it('shows empty state when from === to', () => {
    render(
      <ComparePicker iterations={[iter(1), iter(2)]} fromIter={1} toIter={1} onCompare={vi.fn()} />,
    );
    expect(screen.getByText(/no changes between/i)).toBeInTheDocument();
  });

  it('disables non-resolvable iterations in selectors', async () => {
    render(
      <ComparePicker
        iterations={[iter(1, false), iter(2)]}
        fromIter={null}
        toIter={2}
        onCompare={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('combobox', { name: /from/i }));
    expect(screen.getByRole('option', { name: /snapshot lost/i })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
