import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { HostChangeModal } from '../src/components/HostChangeModal/HostChangeModal';

describe('HostChangeModal', () => {
  it('renders both hosts and Continue/Revert buttons', () => {
    render(
      <HostChangeModal
        oldHost="https://x.com"
        newHost="https://github.com"
        onContinue={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(screen.getByText(/x.com/)).toBeInTheDocument();
    expect(screen.getByText(/github.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revert/i })).toBeInTheDocument();
  });

  it('calls onContinue when Continue clicked', async () => {
    const onContinue = vi.fn();
    render(
      <HostChangeModal
        oldHost="https://x.com"
        newHost="https://github.com"
        onContinue={onContinue}
        onRevert={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

  it('calls onRevert when Revert clicked', async () => {
    const onRevert = vi.fn();
    render(
      <HostChangeModal
        oldHost="https://x.com"
        newHost="https://github.com"
        onContinue={vi.fn()}
        onRevert={onRevert}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(onRevert).toHaveBeenCalledOnce();
  });
});
