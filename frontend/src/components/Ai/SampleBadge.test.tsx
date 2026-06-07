import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({ aiMode: 'preview' as 'off' | 'preview' | 'live' }));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { SampleBadge } from './SampleBadge';

beforeEach(() => { mock.aiMode = 'preview'; });

describe('SampleBadge', () => {
  it('renders the Sample pill in preview mode', () => {
    render(<SampleBadge />);
    const badge = screen.getByTestId('sample-badge');
    expect(badge).toHaveTextContent('Sample');
    expect(badge).toHaveAttribute('aria-label', 'Sample data — illustrative, not real AI output');
  });
  it('renders nothing in off mode', () => {
    mock.aiMode = 'off';
    render(<SampleBadge />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
  it('renders nothing in live mode', () => {
    mock.aiMode = 'live';
    render(<SampleBadge />);
    expect(screen.queryByTestId('sample-badge')).toBeNull();
  });
  it('applies the region class for the region variant', () => {
    render(<SampleBadge variant="region" />);
    expect(screen.getByTestId('sample-badge').className).toMatch(/region/);
  });
});
