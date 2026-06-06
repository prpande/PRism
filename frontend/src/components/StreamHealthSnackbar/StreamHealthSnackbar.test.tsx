import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StreamHealthSnackbar } from './StreamHealthSnackbar';

// vi.mock factories are hoisted above the module body, so anything they close
// over must also be hoisted — otherwise the factory captures TDZ'd bindings.
// vi.hoisted lifts these alongside the mock so the reference is always valid.
const { retry, mockState } = vi.hoisted(() => ({
  retry: vi.fn(),
  mockState: { healthy: true },
}));

vi.mock('../../hooks/useStreamHealth', () => ({
  useStreamHealth: () => ({ healthy: mockState.healthy, retry }),
}));

beforeEach(() => {
  mockState.healthy = true;
  retry.mockClear();
});

describe('StreamHealthSnackbar', () => {
  it('renders nothing while healthy', () => {
    const { container } = render(<StreamHealthSnackbar />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the snackbar when unhealthy', () => {
    mockState.healthy = false;
    render(<StreamHealthSnackbar />);
    expect(screen.getByRole('status')).toHaveTextContent(/connection lost/i);
    expect(screen.getByRole('button', { name: /retry now/i })).toBeInTheDocument();
  });

  it('Retry now calls retry()', () => {
    mockState.healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /retry now/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('dismiss (×) hides it for the current outage', () => {
    mockState.healthy = false;
    render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('re-shows on a new healthy→unhealthy edge after dismiss', () => {
    mockState.healthy = false;
    const { rerender } = render(<StreamHealthSnackbar />);
    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    mockState.healthy = true;
    rerender(<StreamHealthSnackbar />); // recover
    mockState.healthy = false;
    rerender(<StreamHealthSnackbar />); // fresh outage
    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
