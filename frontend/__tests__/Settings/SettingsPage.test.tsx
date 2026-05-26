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

  it('renders the "Replace token (lands in PR4)" stub as a native disabled button (not a tabbable span)', () => {
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    // Spec § 3.1: PR3 stubs Auth section; PR4 lands the real Replace-token UX.
    // Use a native <button disabled> rather than a role=link tabIndex=0 span so
    // keyboard users don't tab to an inert element with no Enter handler. The
    // title attribute carries the explanatory tooltip; the literal "lands in
    // PR4" string is a cross-PR pointer that PR4's grep-sweep step looks for.
    const stub = screen.getByRole('button', { name: /replace token \(lands in pr4\)/i });
    expect(stub).toBeDisabled();
    expect(stub).toHaveAttribute('title', expect.stringMatching(/lands in pr4/i));
  });
});
