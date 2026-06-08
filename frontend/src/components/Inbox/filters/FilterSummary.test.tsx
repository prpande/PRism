import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FilterSummary } from './FilterSummary';

const base = {
  filterCount: 1,
  matchCount: 2,
  totalCount: 5,
  ciIncomplete: false,
  onClear: () => {},
};

describe('FilterSummary', () => {
  it('renders nothing when inactive and the CI probe is complete', () => {
    const { container } = render(<FilterSummary {...base} active={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('surfaces the CI-incomplete hint even with no active filter', () => {
    // A 429-degraded probe must warn the user in the unfiltered view too, so
    // absent CI dots aren't misread as "passing".
    render(<FilterSummary {...base} active={false} ciIncomplete />);
    expect(screen.getByText(/CI status may be incomplete/i)).toBeInTheDocument();
    // No filter summary / Clear button when there's no active filter.
    expect(screen.queryByRole('button', { name: /clear all filters/i })).toBeNull();
  });

  it('shows the count summary and Clear button when active', () => {
    render(<FilterSummary {...base} active />);
    expect(screen.getByText(/showing 2 of 5 PRs/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear all filters/i })).toBeInTheDocument();
    expect(screen.queryByText(/CI status may be incomplete/i)).toBeNull();
  });

  it('appends the CI-incomplete hint to the active summary', () => {
    render(<FilterSummary {...base} active ciIncomplete />);
    expect(screen.getByText(/showing 2 of 5 PRs/i)).toBeInTheDocument();
    expect(screen.getByText(/CI status may be incomplete/i)).toBeInTheDocument();
  });

  it('calls onClear when the Clear button is clicked', async () => {
    const onClear = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    render(<FilterSummary {...base} active onClear={onClear} />);
    await user.click(screen.getByRole('button', { name: /clear all filters/i }));
    expect(onClear).toHaveBeenCalledOnce();
  });
});
