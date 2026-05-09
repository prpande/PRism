import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { ReviewFilesCta } from '../src/components/PrDetail/OverviewTab/ReviewFilesCta';

describe('ReviewFilesCta', () => {
  it('renders the primary "Review files" button', () => {
    render(<ReviewFilesCta hasFiles onReviewFiles={vi.fn()} />);
    expect(screen.getByRole('button', { name: /review files/i })).toBeInTheDocument();
  });

  it('fires onReviewFiles when the button is clicked', async () => {
    const onReviewFiles = vi.fn();
    render(<ReviewFilesCta hasFiles onReviewFiles={onReviewFiles} />);
    await userEvent.click(screen.getByRole('button', { name: /review files/i }));
    expect(onReviewFiles).toHaveBeenCalledTimes(1);
  });

  it('renders the keyboard hint footer "j next file · k previous · v mark viewed"', () => {
    render(<ReviewFilesCta hasFiles onReviewFiles={vi.fn()} />);
    expect(screen.getByText(/j/).textContent).toMatch(/j/);
    expect(screen.getByText(/next file/i)).toBeInTheDocument();
    expect(screen.getByText(/previous/i)).toBeInTheDocument();
    expect(screen.getByText(/mark viewed/i)).toBeInTheDocument();
  });

  it('disables the button and surfaces the empty-PR tooltip when hasFiles is false', () => {
    render(<ReviewFilesCta hasFiles={false} onReviewFiles={vi.fn()} />);
    const button = screen.getByRole('button', { name: /review files/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'No files to review yet');
  });

  it('does not fire onReviewFiles when the disabled button is clicked', async () => {
    const onReviewFiles = vi.fn();
    render(<ReviewFilesCta hasFiles={false} onReviewFiles={onReviewFiles} />);
    await userEvent.click(screen.getByRole('button', { name: /review files/i }));
    expect(onReviewFiles).not.toHaveBeenCalled();
  });

  it('does not set the disabled tooltip when hasFiles is true', () => {
    render(<ReviewFilesCta hasFiles onReviewFiles={vi.fn()} />);
    const button = screen.getByRole('button', { name: /review files/i });
    expect(button).not.toBeDisabled();
    expect(button).not.toHaveAttribute('title', 'No files to review yet');
  });
});
