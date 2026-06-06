import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { SettingsModalRoutes } from './SettingsModalRoutes';

vi.mock('./panes/AppearancePane', () => ({ AppearancePane: () => <div>appearance-pane</div> }));
vi.mock('./panes/InboxPane', () => ({ InboxPane: () => <div>inbox-pane</div> }));
vi.mock('./panes/GitHubConnectionPane', () => ({
  GitHubConnectionPane: () => <div>ghc-pane</div>,
}));
vi.mock('./panes/SystemPane', () => ({ SystemPane: () => <div>system-pane</div> }));

function StateProbe() {
  const loc = useLocation();
  return <pre data-testid="probe-state">{JSON.stringify(loc.state)}</pre>;
}

describe('SettingsModalRoutes', () => {
  it('renders nothing for non-settings paths', () => {
    render(
      <MemoryRouter initialEntries={['/']}>
        <SettingsModalRoutes isAuthed />
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('redirects /settings to /settings/appearance', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <SettingsModalRoutes isAuthed />
      </MemoryRouter>,
    );
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
  });

  it('preserves backgroundLocation through the /settings redirect', () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/settings', state: { backgroundLocation: { pathname: '/pr/o/r/1' } } },
        ]}
      >
        <SettingsModalRoutes isAuthed />
        <StateProbe />
      </MemoryRouter>,
    );
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
    expect(screen.getByTestId('probe-state').textContent).toContain('/pr/o/r/1');
  });

  it('renders the requested section pane inside the dialog', () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <SettingsModalRoutes isAuthed />
      </MemoryRouter>,
    );
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByText('system-pane')).toBeInTheDocument();
  });

  it('redirects an unauthenticated cold deep-link to /setup without rendering the dialog', () => {
    render(
      <MemoryRouter initialEntries={['/settings/github-connection']}>
        <Routes>
          <Route path="/setup" element={<div>setup-page</div>} />
          <Route path="*" element={<SettingsModalRoutes isAuthed={false} />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText('setup-page')).toBeInTheDocument();
  });

  it('falls back to appearance for an unknown section', () => {
    render(
      <MemoryRouter initialEntries={['/settings/ai-connection']}>
        <SettingsModalRoutes isAuthed />
      </MemoryRouter>,
    );
    expect(screen.getByText('appearance-pane')).toBeInTheDocument();
  });
});
