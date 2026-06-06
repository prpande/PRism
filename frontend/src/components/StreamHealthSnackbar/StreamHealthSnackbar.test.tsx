import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StreamHealthSnackbar } from './StreamHealthSnackbar';

const retry = vi.fn();
let healthy = true;
vi.mock('../../hooks/useStreamHealth', () => ({
  useStreamHealth: () => ({ healthy, retry }),
}));

beforeEach(() => {
  healthy = true;
  retry.mockClear();
});

describe('StreamHealthSnackbar', () => {
  it('renders nothing while healthy', () => {
    const { container } = render(<StreamHealthSnackbar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the snackbar when unhealthy', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    expect(screen.getByRole('status')).toHaveTextContent(/connection lost/i);
    expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument();
  });

  it('Retry now calls retry()', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /retry now/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('dismiss (×) hides it for the current outage', () => {
    healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('re-shows on a new healthy→unhealthy edge after dismiss', () => {
    healthy = false;
    const { rerender } = render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    healthy = true;
    rerender(<StreamHealthSnackbar />); // recover
    healthy = false;
    rerender(<StreamHealthSnackbar />); // fresh outage
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
