import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppearancePane } from './AppearancePane';

const set = vi.fn().mockResolvedValue(undefined);
const prefs = vi.hoisted(() => ({ aiMode: 'off' as 'off' | 'preview' | 'live' }));
vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'dark', accent: 'indigo', density: 'comfortable', aiMode: prefs.aiMode },
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
});
