import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitHubUnreachableSnackbar } from '../GitHubUnreachableSnackbar';

describe('GitHubUnreachableSnackbar', () => {
  it('shows the warning pill on a sustained failure', () => {
    render(<GitHubUnreachableSnackbar failing onRetry={vi.fn()} suppressed={false} />);
    expect(screen.getByText(/Couldn't reach GitHub/)).toBeInTheDocument();
    expect(screen.getByText('Retry now')).toBeInTheDocument();
  });

  it('is suppressed when the backend-connection snackbar is up', () => {
    render(<GitHubUnreachableSnackbar failing onRetry={vi.fn()} suppressed />);
    expect(screen.queryByText(/Couldn't reach GitHub/)).not.toBeInTheDocument();
  });

  it('renders nothing when not failing', () => {
    render(<GitHubUnreachableSnackbar failing={false} onRetry={vi.fn()} suppressed={false} />);
    expect(screen.queryByText(/Couldn't reach GitHub/)).not.toBeInTheDocument();
  });
});
