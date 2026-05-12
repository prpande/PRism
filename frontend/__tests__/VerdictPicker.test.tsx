import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { VerdictPicker } from '../src/components/PrDetail/VerdictPicker';

describe('VerdictPicker', () => {
  it('renders the three segments', () => {
    render(<VerdictPicker value={null} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });

  it('marks the selected segment with aria-pressed', () => {
    render(<VerdictPicker value="approve" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('clicking an unselected segment calls onChange with that kebab verdict', () => {
    const onChange = vi.fn();
    render(<VerdictPicker value={null} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(onChange).toHaveBeenCalledWith('request-changes');
  });

  it('clicking the selected segment clears the verdict (onChange(null))', () => {
    const onChange = vi.fn();
    render(<VerdictPicker value="approve" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('shows the needs-reconfirm badge when verdictStatus is needs-reconfirm', () => {
    render(<VerdictPicker value="approve" verdictStatus="needs-reconfirm" onChange={() => {}} />);
    expect(screen.getByText(/needs reconfirm/i)).toBeInTheDocument();
  });

  it('does not show the badge when verdictStatus is draft', () => {
    render(<VerdictPicker value="approve" verdictStatus="draft" onChange={() => {}} />);
    expect(screen.queryByText(/needs reconfirm/i)).not.toBeInTheDocument();
  });

  it('disabled freezes every segment and ignores clicks', () => {
    const onChange = vi.fn();
    render(<VerdictPicker value="approve" disabled onChange={onChange} />);
    const buttons = screen.getAllByRole('button');
    buttons.forEach((b) => expect(b).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('exposes a labelled radiogroup-style container', () => {
    render(<VerdictPicker value={null} onChange={() => {}} />);
    expect(screen.getByRole('group', { name: /verdict/i })).toBeInTheDocument();
  });
});
