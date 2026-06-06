import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('renders role=switch reflecting checked', () => {
    render(<Switch id="ai" checked label="AI preview" onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'AI preview' });
    expect(sw).toBeChecked();
  });

  it('calls onChange with the next value on click', async () => {
    const onChange = vi.fn();
    render(<Switch id="ai" checked={false} label="AI preview" onChange={onChange} />);
    await userEvent.click(screen.getByRole('switch', { name: 'AI preview' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('exposes aria-describedby when help is provided', () => {
    render(<Switch id="x" checked label="X" onChange={() => {}} describedById="help-x" />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-describedby', 'help-x');
  });
});
