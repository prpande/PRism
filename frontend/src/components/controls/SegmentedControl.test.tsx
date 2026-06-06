import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTS = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
] as const;

describe('SegmentedControl', () => {
  it('renders a radiogroup with the selected option checked', () => {
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'false');
  });

  it('calls onChange when an option is clicked', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('arrow keys move selection and wrap', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Theme" options={OPTS} value="light" onChange={onChange} />);
    screen.getByRole('radio', { name: 'Light' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('system');
  });

  it('arrow-left from the first option wraps to the last', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Theme" options={OPTS} value="system" onChange={onChange} />);
    screen.getByRole('radio', { name: 'System' }).focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(onChange).toHaveBeenCalledWith('light');
  });

  it('only the selected option is in the tab order', () => {
    render(<SegmentedControl label="Theme" options={OPTS} value="dark" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('tabindex', '-1');
  });

  it('stays keyboard-reachable when value is not in options (roving index falls back to first)', () => {
    // Guards the roving-tabindex contract: an out-of-set value must NOT leave
    // every radio at tabindex=-1 (which would make the group untabbable).
    render(
      <SegmentedControl
        label="Theme"
        options={OPTS}
        value={'sepia' as (typeof OPTS)[number]['value']}
        onChange={() => {}}
      />,
    );
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('tabindex', '0');
    // No option is checked, since the value matches none of them.
    expect(screen.queryByRole('radio', { checked: true })).toBeNull();
  });
});
