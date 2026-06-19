import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { NumberStepper } from './NumberStepper';

function setup(value = 240, onChange = vi.fn()) {
  render(
    <NumberStepper
      label="Provider timeout"
      value={value}
      min={30}
      max={600}
      step={30}
      unit="seconds"
      onChange={onChange}
    />,
  );
  return onChange;
}

describe('NumberStepper', () => {
  it('renders a spinbutton with aria-valuetext including the unit', () => {
    setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    expect(sb).toHaveAttribute('aria-valuenow', '240');
    expect(sb).toHaveAttribute('aria-valuemin', '30');
    expect(sb).toHaveAttribute('aria-valuemax', '600');
    expect(sb).toHaveAttribute('aria-valuetext', '240 seconds');
  });

  it('ArrowUp / ArrowDown compound off the optimistic display value', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith(270);
    // The displayed value advanced optimistically to 270 (the `value` prop is still 240 — the mock
    // doesn't echo). ArrowDown therefore steps from 270, NOT from the stale prop: 270 → 240.
    await userEvent.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith(240);
  });

  it('PageUp / PageDown use a large step (10×)', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{PageUp}'); // 240 + 300 (=step*10) = 540, on the step grid
    expect(onChange).toHaveBeenLastCalledWith(540);
  });

  it('Home / End jump to min / max', async () => {
    const onChange = setup(240);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith(30);
    await userEvent.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith(600);
  });

  it('reconciles the displayed value when the value prop changes (server echo)', () => {
    const { rerender } = render(
      <NumberStepper
        label="L"
        value={240}
        min={30}
        max={600}
        step={30}
        unit="seconds"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: 'L' })).toHaveAttribute('aria-valuenow', '240');
    rerender(
      <NumberStepper
        label="L"
        value={300}
        min={30}
        max={600}
        step={30}
        unit="seconds"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('spinbutton', { name: 'L' })).toHaveAttribute('aria-valuenow', '300');
  });

  it('disables decrement at min and increment at max', () => {
    const { rerender } = render(
      <NumberStepper
        label="L"
        value={30}
        min={30}
        max={600}
        step={30}
        unit="seconds"
        onChange={vi.fn()}
      />,
    );
    // Buttons are aria-hidden (AT-invisible) and carry no accessible name — query by their glyph text.
    expect(screen.getByText('−')).toBeDisabled();
    expect(screen.getByText('+')).not.toBeDisabled();
    rerender(
      <NumberStepper
        label="L"
        value={600}
        min={30}
        max={600}
        step={30}
        unit="seconds"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText('+')).toBeDisabled();
  });

  it('does not fire onChange when stepping past the boundary', async () => {
    const onChange = setup(600);
    const sb = screen.getByRole('spinbutton', { name: 'Provider timeout' });
    sb.focus();
    await userEvent.keyboard('{ArrowUp}'); // already at max → snap clamps to 600 == display → no-op
    expect(onChange).not.toHaveBeenCalled();
  });
});
