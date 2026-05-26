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

  it('marks both logo images aria-hidden so SRs do not announce them', () => {
    const { container } = render(<LoadingScreen />);
    const imgs = container.querySelectorAll('img');
    expect(imgs.length).toBe(2);
    imgs.forEach((img) => {
      expect(img).toHaveAttribute('aria-hidden', 'true');
      expect(img).toHaveAttribute('alt', '');
    });
  });

  it('uses role=status with aria-busy=true + aria-live=polite on the root', () => {
    const { container } = render(<LoadingScreen />);
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveAttribute('role', 'status');
    expect(root).toHaveAttribute('aria-busy', 'true');
    expect(root).toHaveAttribute('aria-live', 'polite');
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
