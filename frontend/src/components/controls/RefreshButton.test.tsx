import { render, screen } from '@testing-library/react';
import { RefreshButton } from './RefreshButton';

const inboxProps = {
  label: 'Refresh inbox',
  refreshingLabel: 'Refreshing inbox…',
  title: 'Refresh inbox',
  testId: 'inbox-refresh-button',
  confirmTestId: 'inbox-refresh-confirm',
};

it('idle: shows the refresh arrow with the accessible name', () => {
  render(
    <RefreshButton
      {...inboxProps}
      isRefreshing={false}
      justRefreshed={false}
      onRefresh={() => {}}
    />,
  );
  const btn = screen.getByTestId('inbox-refresh-button');
  expect(btn).toHaveAttribute('aria-label', 'Refresh inbox');
  expect(btn).not.toBeDisabled();
});

it('refreshing: spinner + disabled + refreshing label', () => {
  render(<RefreshButton {...inboxProps} isRefreshing justRefreshed={false} onRefresh={() => {}} />);
  const btn = screen.getByTestId('inbox-refresh-button');
  expect(btn).toBeDisabled();
  expect(btn).toHaveAttribute('aria-label', 'Refreshing inbox…');
});

it('just-refreshed: shows the confirm checkmark, enabled', () => {
  render(<RefreshButton {...inboxProps} isRefreshing={false} justRefreshed onRefresh={() => {}} />);
  expect(screen.getByTestId('inbox-refresh-confirm')).toBeInTheDocument();
  expect(screen.getByTestId('inbox-refresh-button')).not.toBeDisabled();
});

it('parameterizes pr-detail strings + testids', () => {
  render(
    <RefreshButton
      label="Refresh PR"
      refreshingLabel="Refreshing PR…"
      title="Refresh PR"
      testId="pr-refresh-button"
      confirmTestId="pr-refresh-confirm"
      isRefreshing={false}
      justRefreshed
      onRefresh={() => {}}
    />,
  );
  expect(screen.getByTestId('pr-refresh-button')).toHaveAttribute('aria-label', 'Refresh PR');
  expect(screen.getByTestId('pr-refresh-confirm')).toBeInTheDocument();
});
