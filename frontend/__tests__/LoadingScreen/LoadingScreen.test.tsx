import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { LoadingScreen } from '../../src/components/LoadingScreen';

afterEach(() => {
  vi.useRealTimers();
});

describe('LoadingScreen', () => {
  it('renders default label "Loading…"', () => {
    render(<LoadingScreen />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('renders a custom label when provided', () => {
    render(<LoadingScreen label="Booting…" />);
    expect(screen.getByText('Booting…')).toBeInTheDocument();
  });

  it('renders a single decorative logo image (no background watermark)', () => {
    const { container } = render(<LoadingScreen />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(1);
    expect(imgs[0]).toHaveAttribute('aria-hidden', 'true');
    expect(imgs[0]).toHaveAttribute('alt', '');
  });

  it('shows a decorative spinner while loading and removes it once timed out', () => {
    vi.useFakeTimers();
    const { container } = render(<LoadingScreen timeoutMs={1000} />);
    // The decorative spinner is a lone aria-hidden <span> (no nested status
    // region); the logo is an <img>, so this selector isolates the ring.
    expect(container.querySelector('span[aria-hidden="true"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  // role="status" carries implicit aria-live="polite" + aria-atomic="true" per
  // WAI-ARIA; explicit aria-live="polite" was dropped to avoid the redundant-
  // live-region pattern that axe-core can flag in PR7's a11y audit.
  it('uses role=status + aria-busy=true while loading (implicit polite live region)', () => {
    const { container } = render(<LoadingScreen />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).not.toHaveAttribute('aria-live');
  });

  // Per ARIA: aria-busy=true tells assistive tech to defer announcements within
  // the region. Keeping it true after the content settles would suppress the
  // very Reload-state update the live region exists to announce, so we toggle
  // it off when timedOut flips true.
  it('toggles aria-busy off once the timeout fires so the new content is announced', () => {
    vi.useFakeTimers();
    const { container } = render(<LoadingScreen timeoutMs={1000} timeoutLabel="Stalled…" />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('aria-busy', 'true');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(root).toHaveAttribute('aria-busy', 'false');
  });

  it('resets to the default label when timeoutMs changes after a timeout fired', () => {
    vi.useFakeTimers();
    const { rerender } = render(<LoadingScreen timeoutMs={500} timeoutLabel="Stalled…" />);

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.getByText('Stalled…')).toBeInTheDocument();

    // Parent bumps timeoutMs — useEffect re-runs and timedOut resets so the
    // user sees the loading state again, not a stuck Reload screen.
    rerender(<LoadingScreen timeoutMs={5000} timeoutLabel="Stalled…" />);
    expect(screen.queryByText('Stalled…')).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();
  });

  it('after timeoutMs elapses, swaps label to timeoutLabel and reveals Reload button', () => {
    vi.useFakeTimers();
    render(<LoadingScreen timeoutMs={1000} timeoutLabel="Still working…" />);
    expect(screen.queryByText('Still working…')).toBeNull();
    expect(screen.queryByRole('button', { name: /reload/i })).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByText('Still working…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });
});
