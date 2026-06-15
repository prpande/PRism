import { render, screen, fireEvent } from '@testing-library/react';
import { AiFailureToast } from './AiFailureToast';
import type { AiSeam } from './aiFailure';

function setup(over: { seams?: AiSeam[]; retrying?: boolean } = {}) {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(
    <AiFailureToast
      seams={over.seams ?? (['summary', 'file-focus', 'hunk-annotations'] as AiSeam[])}
      retrying={over.retrying ?? false}
      onRetry={onRetry}
      onDismiss={onDismiss}
    />,
  );
  return { onRetry, onDismiss };
}

it('lists failed seams using display names', () => {
  setup({ seams: ['summary', 'file-focus', 'hunk-annotations'] });
  expect(screen.getByText(/summary, hotspots, annotations/)).toBeInTheDocument();
});

it('Retry fires onRetry and is enabled when not retrying', () => {
  const { onRetry } = setup({ retrying: false });
  const btn = screen.getByRole('button', { name: 'Retry' });
  expect(btn).toBeEnabled();
  fireEvent.click(btn);
  expect(onRetry).toHaveBeenCalledOnce();
});

it('shows a disabled "Retrying…" button while retrying', () => {
  setup({ retrying: true });
  expect(screen.getByRole('button', { name: 'Retrying…' })).toBeDisabled();
});

it('Dismiss fires onDismiss', () => {
  const { onDismiss } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledOnce();
});
