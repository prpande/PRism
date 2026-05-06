import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { InboxBanner } from '../src/components/Inbox/InboxBanner';

describe('InboxBanner', () => {
  it('renders summary and Reload + Dismiss buttons', () => {
    render(<InboxBanner summary="3 new updates" onReload={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText(/3 new updates/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('Reload click invokes onReload', async () => {
    const onReload = vi.fn();
    render(<InboxBanner summary="x" onReload={onReload} onDismiss={() => {}} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /reload/i }));
    expect(onReload).toHaveBeenCalledOnce();
  });

  it('Dismiss click invokes onDismiss', async () => {
    const onDismiss = vi.fn();
    render(<InboxBanner summary="x" onReload={() => {}} onDismiss={onDismiss} />);
    await userEvent.setup().click(screen.getByRole('button', { name: /dismiss/i }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
