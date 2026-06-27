import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeMethodPicker, allowedList, firstAllowed } from './MergeMethodPicker';

describe('allowedList / firstAllowed', () => {
  it('orders merge→squash→rebase and picks first allowed', () => {
    expect(allowedList({ merge: false, squash: true, rebase: true })).toEqual(['squash', 'rebase']);
    expect(firstAllowed({ merge: false, squash: true, rebase: true })).toBe('squash');
  });
  it('defaults to all three when none flagged', () => {
    expect(allowedList({ merge: false, squash: false, rebase: false })).toEqual(['merge', 'squash', 'rebase']);
  });
});

describe('MergeMethodPicker', () => {
  it('renders a radiogroup of allowed methods only', () => {
    render(<MergeMethodPicker allowed={{ merge: true, squash: true, rebase: false }} value="merge" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('renders nothing when only one method is allowed', () => {
    const { container } = render(<MergeMethodPicker allowed={{ merge: false, squash: true, rebase: false }} value="squash" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('arrow key changes selection', async () => {
    const onChange = vi.fn();
    render(<MergeMethodPicker allowed={{ merge: true, squash: true, rebase: true }} value="merge" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('squash');
  });
});
