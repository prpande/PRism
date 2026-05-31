import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SettingsPage } from '../../src/pages/SettingsPage';

vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
      inbox: {
        sections: {
          'review-requested': true,
          'awaiting-author': true,
          'authored-by-me': true,
          mentioned: true,
          'ci-failing': true,
        },
      },
      github: {
        host: 'https://github.com',
        configPath: '/Users/x/AppData/Local/PRism/config.json',
        logsPath: '/Users/x/AppData/Local/PRism/logs',
      },
    },
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  }),
}));

vi.mock('../../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));

vi.mock('../../src/hooks/useSubmitInFlight', () => ({
  useSubmitInFlight: () => ({ inFlight: false, prRef: null }),
}));

describe('SettingsPage', () => {
  it('renders all four section headings (Appearance, Inbox sections, Connection, Auth)', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: /appearance/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /inbox sections/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /connection/i, level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /^auth$/i, level: 2 })).toBeInTheDocument();
  });

  it('renders the real Replace token link pointing at /setup?replace=1 (spec § 3.1)', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /^replace token$/i });
    expect(link).toHaveAttribute('href', '/setup?replace=1');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
  });
});
