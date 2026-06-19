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

  it('renders the nav variant as an accessible radiogroup and toggles', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        variant="nav"
        label="Choose a token type"
        options={[
          { value: 'classic', label: 'Classic' },
          { value: 'fine-grained', label: 'Fine-grained' },
        ]}
        value="classic"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Choose a token type' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Classic' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Fine-grained' }));
    expect(onChange).toHaveBeenCalledWith('fine-grained');

    // Arrow-key selection (spec a11y requirement): focus the selected radio and
    // press ArrowRight — the nav variant must keep SegmentedControl's onKeyDown.
    onChange.mockClear();
    screen.getByRole('radio', { name: 'Classic' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('fine-grained');
  });
});

const opts = [
  { value: 'off', label: 'Off' },
  { value: 'preview', label: 'Preview' },
  { value: 'live', label: 'Live' },
] as const;

describe('SegmentedControl selectedDataRole', () => {
  it('marks only the selected radio with data-modal-role', () => {
    render(
      <SegmentedControl
        label="AI mode"
        options={opts}
        value="preview"
        onChange={vi.fn()}
        selectedDataRole="cancel"
      />,
    );
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute(
      'data-modal-role',
      'cancel',
    );
    expect(screen.getByRole('radio', { name: 'Off' })).not.toHaveAttribute('data-modal-role');
  });

  it('adds no attribute when the prop is omitted', () => {
    render(<SegmentedControl label="AI mode" options={opts} value="preview" onChange={vi.fn()} />);
    expect(screen.getByRole('radio', { name: 'Preview' })).not.toHaveAttribute('data-modal-role');
  });
});
