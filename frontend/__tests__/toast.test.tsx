import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ToastContainer, useToast, ToastProvider } from '../src/components/Toast';

function Trigger({
  kind = 'error',
  message = 'kaboom',
  requestId = 'rid-1',
  label = 'show',
}: {
  kind?: 'info' | 'error';
  message?: string;
  requestId?: string;
  label?: string;
}) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show({ kind, message, requestId })}>
      {label}
    </button>
  );
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it('deduplicates a repeat (kind, message) toast so spam-clicks do not stack', async () => {
    // Regression: prior to useToast's de-dup, spam-clicking Submit during a
    // sticky head-sha drift stacked N identical "Couldn't submit" banners that
    // had to be dismissed one by one. Identity is (kind, message) — requestId
    // differences are ignored so the already-visible toast keeps its first id.
    render(
      <ToastProvider>
        <Trigger />
        <ToastContainer />
      </ToastProvider>,
    );
    const btn = screen.getByRole('button', { name: 'show' });
    await userEvent.click(btn);
    await userEvent.click(btn);
    await userEvent.click(btn);
    expect(screen.getAllByText('kaboom')).toHaveLength(1);
  });

  it('renders distinct (kind, message) toasts separately so de-dup is scoped to true duplicates', async () => {
    render(
      <ToastProvider>
        <Trigger kind="error" message="alpha" label="show-alpha" />
        <Trigger kind="error" message="beta" label="show-beta" />
        <ToastContainer />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'show-alpha' }));
    await userEvent.click(screen.getByRole('button', { name: 'show-beta' }));
    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.getByText('beta')).toBeInTheDocument();
  });

  it('auto-dismisses an info toast after 5s', () => {
    // userEvent.click awaits real microtasks even with advanceTimers, which
    // wedges this test under vi.useFakeTimers. Capture the show() handle
    // directly so triggering the toast is fully synchronous — that way the
    // fake-timer fast-forward owns time advancement end-to-end.
    let showToast: ((spec: { kind: 'info' | 'error'; message: string }) => void) | null = null;
    function Capture() {
      const toast = useToast();
      showToast = toast.show;
      return null;
    }
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Capture />
        <ToastContainer />
      </ToastProvider>,
    );
    act(() => {
      showToast!({ kind: 'info', message: 'heads up' });
    });
    expect(screen.getByText('heads up')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(screen.queryByText('heads up')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(screen.queryByText('heads up')).not.toBeInTheDocument();
  });

  it('auto-dismisses an error toast after 10s (longer window than info)', () => {
    // Regression: prior to AUTO_DISMISS_MS, only info dismissed; errors stayed
    // up forever. With a sticky drift that produced a wall of identical
    // banners that never cleared even after the user fixed the underlying state.
    let showToast: ((spec: { kind: 'info' | 'error'; message: string }) => void) | null = null;
    function Capture() {
      const toast = useToast();
      showToast = toast.show;
      return null;
    }
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Capture />
        <ToastContainer />
      </ToastProvider>,
    );
    act(() => {
      showToast!({ kind: 'error', message: 'bad thing' });
    });
    expect(screen.getByText('bad thing')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText('bad thing')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(5001);
    });
    expect(screen.queryByText('bad thing')).not.toBeInTheDocument();
  });
});
