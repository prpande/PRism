import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SettingsPage } from '../../src/pages/SettingsPage';

vi.mock('../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: { theme: 'system', accent: 'indigo', aiPreview: false },
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

  it('renders the "Replace token (lands in PR4)" disabled link with the PR4-pointer title', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    // Spec § 3.1: PR3 stubs Auth section with a disabled link; PR4 lands the real
    // Replace-token UX. The title attribute carries the explanatory tooltip per the
    // 2026-05-25 plan amendment ("hover/focus tooltip via title + sr-only span");
    // the visible label still flags the cross-PR pointer so it shows up in PR4's
    // Step-3 grep sweep.
    const stub = screen.getByText(/replace token \(lands in pr4\)/i);
    expect(stub).toBeInTheDocument();
    expect(stub).toHaveAttribute('aria-disabled', 'true');
    expect(stub).toHaveAttribute('title', expect.stringMatching(/lands in pr4/i));
  });
});
