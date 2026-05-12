import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StaleCommitOidBanner } from '../src/components/PrDetail/SubmitDialog/StaleCommitOidBanner';

function renderBanner(overrides: Partial<Parameters<typeof StaleCommitOidBanner>[0]> = {}) {
  const props = {
    currentHeadSha: 'abcdef1234567890',
    notReloadedYet: false,
    onCancel: vi.fn(),
    onResubmit: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<StaleCommitOidBanner {...props} />) };
}

describe('StaleCommitOidBanner', () => {
  it('renders the banner copy with the truncated head sha', () => {
    renderBanner({ currentHeadSha: 'abcdef1234567890' });
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/head commit changed/i);
    expect(alert).toHaveTextContent(/recreating the review/i);
    expect(alert).toHaveTextContent('abcdef1');
    expect(alert).not.toHaveTextContent('abcdef1234567890');
  });

  it('default (already-reloaded) variant: Recreate-and-resubmit enabled, no reload reminder', () => {
    renderBanner({ notReloadedYet: false });
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeEnabled();
    expect(screen.queryByText(/click reload first/i)).toBeNull();
  });

  it('not-reloaded-yet variant: Recreate-and-resubmit disabled + reload reminder + tooltip', () => {
    renderBanner({ notReloadedYet: true });
    const btn = screen.getByRole('button', { name: /recreate and resubmit/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', expect.stringMatching(/reload the pr first/i));
    expect(screen.getByText(/click reload first/i)).toBeInTheDocument();
  });

  it('Cancel is always enabled (the orphan was already deleted server-side)', () => {
    renderBanner({ notReloadedYet: true });
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
  });

  it('clicking the buttons fires the callbacks', () => {
    const onCancel = vi.fn();
    const onResubmit = vi.fn();
    renderBanner({ notReloadedYet: false, onCancel, onResubmit });
    fireEvent.click(screen.getByRole('button', { name: /recreate and resubmit/i }));
    expect(onResubmit).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders gracefully when currentHeadSha is empty', () => {
    renderBanner({ currentHeadSha: '' });
    expect(screen.getByRole('alert')).toHaveTextContent(/head commit changed/i);
  });
});
