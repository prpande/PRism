import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeNavControls } from './ChangeNavControls';

const base = { total: 7, currentIdx: 2, canPrev: true, canNext: true, onPrev: () => {}, onNext: () => {} };

describe('ChangeNavControls', () => {
  it('shows the 1-based counter N / M', () => {
    const { getByText } = render(<ChangeNavControls {...base} />);
    expect(getByText('3 / 7')).toBeInTheDocument();
  });

  it('shows — / M above the first change', () => {
    const { getByText } = render(<ChangeNavControls {...base} currentIdx={-1} canPrev={false} />);
    expect(getByText('— / 7')).toBeInTheDocument();
  });

  it('disables prev at the first change and next at the last', () => {
    const { getByRole, rerender } = render(
      <ChangeNavControls {...base} currentIdx={0} canPrev={false} />,
    );
    expect((getByRole('button', { name: /previous change/i }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<ChangeNavControls {...base} currentIdx={6} canNext={false} />);
    expect((getByRole('button', { name: /next change/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('calls onNext / onPrev', async () => {
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const { getByRole } = render(<ChangeNavControls {...base} onNext={onNext} onPrev={onPrev} />);
    await userEvent.click(getByRole('button', { name: /next change/i }));
    await userEvent.click(getByRole('button', { name: /previous change/i }));
    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it('announces the position in a status live region', () => {
    const { getByRole } = render(<ChangeNavControls {...base} />);
    expect(getByRole('status')).toHaveTextContent('change 3 of 7');
  });

  it('announces the at-top state when above the first change', () => {
    const { getByRole } = render(<ChangeNavControls {...base} currentIdx={-1} canPrev={false} />);
    expect(getByRole('status')).toHaveTextContent('at top, 7 changes');
  });
});
