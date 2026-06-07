import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
        aiPreview: false,
        contentScale: 'm',
      },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));
beforeEach(() => set.mockClear());
afterEach(() => document.documentElement.removeAttribute('data-content-scale'));

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: /AI preview/i })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Content font size' })).toBeInTheDocument();
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

  it('writes the theme preference on change', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Light' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('theme', 'light'));
  });
});
