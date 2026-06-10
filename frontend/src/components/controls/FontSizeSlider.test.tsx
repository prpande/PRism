import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { FontSizeSlider } from './FontSizeSlider';

describe('FontSizeSlider', () => {
  it('renders a labelled range slider positioned at the current value', () => {
    render(<FontSizeSlider value="m" onChange={() => {}} />);
    const slider = screen.getByRole('slider', { name: 'Content font size' });
    expect(slider).toHaveValue('2'); // 'm' is index 2 of xs,s,m,l,xl
    expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  });

  it('renders five growing "a" glyphs as the size legend', () => {
    render(<FontSizeSlider value="m" onChange={() => {}} />);
    expect(screen.getAllByText('a')).toHaveLength(5);
  });

  it('maps the slider index back to the enum on change', () => {
    const onChange = vi.fn();
    render(<FontSizeSlider value="m" onChange={onChange} />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    expect(onChange).toHaveBeenCalledWith('xl');
  });

  it('falls back to index 0 when value is out of the enum', () => {
    render(<FontSizeSlider value={'zzz' as never} onChange={() => {}} />);
    expect(screen.getByRole('slider', { name: 'Content font size' })).toHaveValue('0');
  });
});
