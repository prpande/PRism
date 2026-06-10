import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {
        theme: 'dark',
        accent: 'indigo',
        density: 'comfortable',
        contentScale: 'm',
        aiMode: prefs.aiMode,
      },
      inbox: { sections: {} },
      github: {},
    },
    set,
  }),
}));
beforeEach(() => {
  set.mockClear();
  prefs.aiMode = 'off';
});
afterEach(() => document.documentElement.removeAttribute('data-content-scale'));

describe('AppearancePane', () => {
  it('renders theme/accent/density/AI-mode controls', () => {
    render(<AppearancePane />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Accent' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Density' })).toBeInTheDocument();
    const aiMode = screen.getByRole('radiogroup', { name: 'AI mode' });
    expect(aiMode).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Off' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Preview' })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: 'Live' })).toBeNull();
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

  it('writes ui.ai.mode on selecting Preview', async () => {
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    await waitFor(() => expect(set).toHaveBeenCalledWith('ui.ai.mode', 'preview'));
  });

  it('shows a live config as Preview and issues no POST on render', () => {
    prefs.aiMode = 'live';
    render(<AppearancePane />);
    expect(screen.getByRole('radio', { name: 'Preview' })).toHaveAttribute('aria-checked', 'true');
    expect(set).not.toHaveBeenCalled();
  });

  it('does not POST when the already-shown Preview is clicked on a live config', async () => {
    prefs.aiMode = 'live';
    render(<AppearancePane />);
    await userEvent.click(screen.getByRole('radio', { name: 'Preview' }));
    expect(set).not.toHaveBeenCalled();
  });
});
