import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { ToastContainer, useToast, ToastProvider } from '../src/components/Toast';

function Trigger() {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => toast.show({ kind: 'error', message: 'kaboom', requestId: 'rid-1' })}
    >
      show
    </button>
  );
}

describe('Toast', () => {
  it('shows the message and exposes Copy diagnostic info', async () => {
    render(
      <ToastProvider>
        <Trigger />
        <ToastContainer />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'show' }));
    expect(screen.getByText('kaboom')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy diagnostic info/i })).toBeInTheDocument();
  });
});
