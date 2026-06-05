// DiffViewToggle.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffViewToggle } from './DiffViewToggle';

describe('DiffViewToggle', () => {
  it('renders two radios reflecting the current mode', () => {
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={() => {}} />);
    expect((getByRole('radio', { name: /unified/i }) as HTMLInputElement).checked).toBe(true);
    expect((getByRole('radio', { name: /split/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('fires onDiffModeChange with the selected mode', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={onChange} />);
    await userEvent.click(getByRole('radio', { name: /split/i }));
    expect(onChange).toHaveBeenCalledWith('side-by-side');
  });

  it('disables Split with a reason when splitDisabled', () => {
    const { getByRole } = render(
      <DiffViewToggle
        diffMode="unified"
        onDiffModeChange={() => {}}
        splitDisabled
        splitDisabledReason="Side-by-side needs a wider window."
      />,
    );
    const split = getByRole('radio', { name: /split/i }) as HTMLInputElement;
    expect(split.disabled).toBe(true);
    expect(split.closest('label')).toHaveAttribute('title', 'Side-by-side needs a wider window.');
    // Reason is also wired to the radiogroup for keyboard / screen-reader users
    // (the disabled Split radio isn't focusable, so title alone isn't announced).
    const group = getByRole('radiogroup', { name: /diff view/i });
    const describedById = group.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(document.getElementById(describedById as string)).toHaveTextContent(
      'Side-by-side needs a wider window.',
    );
  });

  it('omits aria-describedby when Split is enabled', () => {
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={() => {}} />);
    expect(getByRole('radiogroup', { name: /diff view/i })).not.toHaveAttribute('aria-describedby');
  });

  it('exposes a labelled radiogroup', () => {
    const { getByRole } = render(
      <DiffViewToggle diffMode="side-by-side" onDiffModeChange={() => {}} />,
    );
    expect(getByRole('radiogroup', { name: /diff view/i })).toBeInTheDocument();
  });

  it('moves selection with arrow keys (native radiogroup)', async () => {
    const onChange = vi.fn();
    const { getByRole } = render(<DiffViewToggle diffMode="unified" onDiffModeChange={onChange} />);
    getByRole('radio', { name: /unified/i }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('side-by-side');
  });
});
