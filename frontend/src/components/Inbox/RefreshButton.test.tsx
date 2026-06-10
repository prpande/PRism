import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RefreshButton } from './RefreshButton';

describe('RefreshButton', () => {
  it('renders an accessible idle button and fires onRefresh on click', async () => {
    const onRefresh = vi.fn();
    render(<RefreshButton isRefreshing={false} justRefreshed={false} onRefresh={onRefresh} />);

    const btn = screen.getByRole('button', { name: 'Refresh inbox' });
    expect(btn).toBeEnabled();
    await userEvent.click(btn);
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it('is disabled and renamed while refreshing', () => {
    render(<RefreshButton isRefreshing justRefreshed={false} onRefresh={vi.fn()} />);
    const btn = screen.getByRole('button', { name: 'Refreshing inbox…' });
    expect(btn).toBeDisabled();
  });

  it('shows the transient confirmation when justRefreshed', () => {
    render(<RefreshButton isRefreshing={false} justRefreshed onRefresh={vi.fn()} />);
    expect(screen.getByTestId('inbox-refresh-confirm')).toHaveTextContent('Refreshed');
  });
});
