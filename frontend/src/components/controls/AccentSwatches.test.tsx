import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { AccentSwatches } from './AccentSwatches';

describe('AccentSwatches', () => {
  it('renders a radiogroup of the three accents with the current one checked', () => {
    render(<AccentSwatches value="indigo" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Teal' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when a swatch is clicked', async () => {
    const onChange = vi.fn();
    render(<AccentSwatches value="indigo" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Amber' }));
    expect(onChange).toHaveBeenCalledWith('amber');
  });

  it('arrow keys move selection and wrap', async () => {
    const onChange = vi.fn();
    render(<AccentSwatches value="teal" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Teal' }).focus();
    await userEvent.keyboard('{ArrowRight}'); // teal is last → wraps to indigo
    expect(onChange).toHaveBeenCalledWith('indigo');
  });

  it('falls back to indigo selected when the value is not a known accent', () => {
    render(<AccentSwatches value={'bogus' as never} onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Indigo' })).toHaveAttribute('aria-checked', 'true');
  });

  it('does not call onChange when rendering with an unknown value (display-only fallback)', () => {
    const onChange = vi.fn();
    render(<AccentSwatches value={'bogus' as never} onChange={onChange} />);
    expect(onChange).not.toHaveBeenCalled();
  });
});
