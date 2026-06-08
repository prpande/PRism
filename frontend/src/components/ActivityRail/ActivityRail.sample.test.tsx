import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { ActivityRail } from './ActivityRail';

beforeEach(() => { mock.aiMode = 'preview'; });

describe('ActivityRail sample badge', () => {
  it('renders the region badge in preview', () => {
    render(<ActivityRail />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
  });
  it('omits the badge in off', () => {
    mock.aiMode = 'off';
    render(<ActivityRail />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
});
