import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiPreview: false }, inbox: { sections: {} }, github: {} },
    set,
  }),
}));
vi.mock('../../../hooks/useCapabilities', () => ({ useCapabilities: () => ({ refetch: vi.fn() }) }));

beforeEach(() => set.mockClear());

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /AI preview/i })).toBeInTheDocument();
  });

  it('writes the theme preference on change', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('theme', 'light'));
  });
});
