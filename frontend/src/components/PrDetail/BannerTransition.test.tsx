import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { BannerTransition } from './BannerTransition';

describe('BannerTransition', () => {
  it('renders merged copy', () => {
    render(<BannerTransition state="merged" onReload={vi.fn()} />);
    expect(screen.getByText(/just merged/i)).toBeInTheDocument();
    expect(screen.getByText(/Unsubmitted drafts can no longer be submitted/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reload to read-only view/i })).toBeInTheDocument();
  });

  it('renders closed copy', () => {
    render(<BannerTransition state="closed" onReload={vi.fn()} />);
    expect(screen.getByText(/just closed/i)).toBeInTheDocument();
  });

  it('has role=status and aria-live=polite for screen readers', () => {
    render(<BannerTransition state="merged" onReload={vi.fn()} />);
    const el = screen.getByRole('status');
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute('aria-live', 'polite');
  });

  it('does NOT have a dismiss control', () => {
    render(<BannerTransition state="merged" onReload={vi.fn()} />);
    expect(screen.queryByLabelText(/dismiss/i)).not.toBeInTheDocument();
    // Only one button: the Reload button
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('fires onReload when the Reload button is clicked', async () => {
    const onReload = vi.fn();
    render(<BannerTransition state="merged" onReload={onReload} />);
    await userEvent.click(screen.getByRole('button', { name: /Reload to read-only view/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('applies banner and banner-warning CSS classes', () => {
    render(<BannerTransition state="closed" onReload={vi.fn()} />);
    const el = screen.getByRole('status');
    expect(el).toHaveClass('banner');
    expect(el).toHaveClass('banner-warning');
  });
});
