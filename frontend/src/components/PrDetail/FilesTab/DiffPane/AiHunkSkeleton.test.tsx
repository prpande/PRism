import { render, screen } from '@testing-library/react';
import { AiHunkSkeleton } from './AiHunkSkeleton';

it('renders a working AI marker and a skeleton body', () => {
  render(<AiHunkSkeleton />);
  expect(screen.getByTestId('ai-marker').getAttribute('data-ai-state')).toBe('working');
  expect(screen.getByTestId('ai-hunk-skeleton')).toBeInTheDocument();
});
