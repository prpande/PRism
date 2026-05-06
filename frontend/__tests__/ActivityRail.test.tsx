import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ActivityRail } from '../src/components/ActivityRail/ActivityRail';

describe('ActivityRail', () => {
  it('renders the Activity section header', () => {
    render(<ActivityRail />);
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('last 24h')).toBeInTheDocument();
  });

  it('renders all 6 activity items', () => {
    render(<ActivityRail />);
    expect(screen.getByText(/pushed iter 3 to/i)).toBeInTheDocument();
    expect(screen.getByText(/marked CI failing on/i)).toBeInTheDocument();
    // 6 list items in the activity section + 3 in the watching section = 9 total <li>
    expect(screen.getAllByRole('listitem')).toHaveLength(9);
  });

  it('renders the Watching section with watched repos', () => {
    render(<ActivityRail />);
    expect(screen.getByText('Watching')).toBeInTheDocument();
    expect(screen.getByText('platform/billing-svc')).toBeInTheDocument();
  });

  it('renders idle for repos with zero count', () => {
    render(<ActivityRail />);
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('exposes the rail with an aria-label', () => {
    render(<ActivityRail />);
    expect(screen.getByRole('complementary', { name: /activity/i })).toBeInTheDocument();
  });
});
