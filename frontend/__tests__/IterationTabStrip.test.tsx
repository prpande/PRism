import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { IterationTabStrip } from '../src/components/PrDetail/FilesTab/IterationTabStrip';
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

describe('IterationTabStrip', () => {
  it('renders "All changes" tab and last 3 iterations', () => {
    const iterations = [iter(1), iter(2), iter(3), iter(4), iter(5)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    expect(screen.getByText('All changes')).toBeInTheDocument();
    expect(screen.getByText('Iter 3')).toBeInTheDocument();
    expect(screen.getByText('Iter 4')).toBeInTheDocument();
    expect(screen.getByText('Iter 5')).toBeInTheDocument();
    expect(screen.queryByText('Iter 1')).not.toBeInTheDocument();
    expect(screen.queryByText('Iter 2')).not.toBeInTheDocument();
  });

  it('renders "All iterations" dropdown for older iterations', () => {
    const iterations = [iter(1), iter(2), iter(3), iter(4), iter(5)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    expect(screen.getByText(/All iterations/)).toBeInTheDocument();
  });

  it('does not render "All iterations" dropdown when 3 or fewer iterations', () => {
    const iterations = [iter(1), iter(2), iter(3)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    expect(screen.queryByText(/All iterations/)).not.toBeInTheDocument();
  });

  it('calls onRangeChange with "all" when "All changes" is clicked', () => {
    const onRangeChange = vi.fn();
    render(
      <IterationTabStrip
        iterations={[iter(1)]}
        activeRange="before1..after1"
        onRangeChange={onRangeChange}
      />,
    );
    fireEvent.click(screen.getByText('All changes'));
    expect(onRangeChange).toHaveBeenCalledWith('all');
  });

  it('calls onRangeChange with range when iteration tab is clicked', () => {
    const onRangeChange = vi.fn();
    render(
      <IterationTabStrip
        iterations={[iter(1), iter(2)]}
        activeRange="all"
        onRangeChange={onRangeChange}
      />,
    );
    fireEvent.click(screen.getByText('Iter 2'));
    expect(onRangeChange).toHaveBeenCalledWith('before2..after2');
  });

  it('renders "snapshot lost" for non-resolvable iterations', () => {
    const iterations = [iter(1, false), iter(2)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    expect(screen.getByText('Iter 1 (snapshot lost)')).toBeInTheDocument();
  });

  it('non-resolvable iterations are not clickable', () => {
    const onRangeChange = vi.fn();
    const iterations = [iter(1, false), iter(2)];
    render(
      <IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={onRangeChange} />,
    );
    fireEvent.click(screen.getByText('Iter 1 (snapshot lost)'));
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('marks the active range tab as selected', () => {
    const iterations = [iter(1), iter(2)];
    render(<IterationTabStrip iterations={iterations} activeRange="all" onRangeChange={vi.fn()} />);
    const allTab = screen.getByText('All changes').closest('[role="tab"]');
    expect(allTab?.getAttribute('aria-selected')).toBe('true');
  });
});
