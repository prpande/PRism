import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        theme: 'dark',
        accent: 'indigo',
        density: 'comfortable',
        contentScale: 'm',
      },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));

beforeEach(() => {
  set.mockClear();
});
afterEach(() => {
  document.documentElement.removeAttribute('data-content-scale');
  vi.clearAllMocks();
});

describe('AppearancePane', () => {
  it('renders theme/accent/density controls and NOT the AI-mode control', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'AI mode' })).toBeNull();
  });

  it('writes the contentScale preference on slider change', async () => {
    render(<AppearancePane />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' },
    });
    await waitFor(() => expect(set).toHaveBeenCalledWith('contentScale', 'xl'));
  });

  it('rolls back the optimistic content-scale apply when the save fails', async () => {
    set.mockRejectedValueOnce(new Error('save failed'));
    render(<AppearancePane />);
    fireEvent.change(screen.getByRole('slider', { name: 'Content font size' }), {
      target: { value: '4' }, // 'xl'
    });
    // Optimistic write set the attribute to 'xl'; the rejected save reverts to
    // the prior value 'm', which removes the attribute entirely.
    await waitFor(() =>
      expect(document.documentElement.hasAttribute('data-content-scale')).toBe(false),
    );
    expect(set).toHaveBeenCalledWith('contentScale', 'xl');
  });
});
