import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LoadingBarProvider, useTopProgress } from '../../contexts/LoadingBarContext';
import { TopProgressBar } from './TopProgressBar';

function Feeder({ active }: { active: boolean }) {
  useTopProgress('test', active);
  return null;
}

describe('TopProgressBar', () => {
  it('is present and marked aria-hidden, with a data-active attribute reflecting state', () => {
    const { rerender } = render(
      <LoadingBarProvider>
        <Feeder active={false} />
        <TopProgressBar />
      </LoadingBarProvider>,
    );
    const bar = screen.getByTestId('top-progress-bar');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).toHaveAttribute('data-active', 'false');

    rerender(
      <LoadingBarProvider>
        <Feeder active />
        <TopProgressBar />
      </LoadingBarProvider>,
    );
    expect(screen.getByTestId('top-progress-bar')).toHaveAttribute('data-active', 'true');
  });
});
