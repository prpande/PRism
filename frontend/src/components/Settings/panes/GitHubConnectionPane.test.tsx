import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi } from 'vitest';
import { GitHubConnectionPane } from './GitHubConnectionPane';

vi.mock('../../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: {
      ui: {},
      inbox: { sections: {} },
      github: { host: 'api.github.com', configPath: 'C:/x/config.json', logsPath: 'C:/x/logs' },
    },
  }),
}));
const inFlight = { current: { inFlight: false, prRef: null as string | null } };
vi.mock('../../../hooks/useSubmitInFlight', () => ({ useSubmitInFlight: () => inFlight.current }));

describe('GitHubConnectionPane', () => {
  it('shows the host and an enabled Replace token link', () => {
    inFlight.current = { inFlight: false, prRef: null };
    render(
      <MemoryRouter>
        <GitHubConnectionPane />
      </MemoryRouter>,
    );
    expect(screen.getByText('api.github.com')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: 'Replace token' });
    expect(link).toHaveAttribute('href', '/setup?replace=1');
    expect(link).not.toHaveAttribute('aria-disabled', 'true');
  });

  it('disables Replace token while a submit is in flight', () => {
    inFlight.current = { inFlight: true, prRef: 'o/r#1' };
    render(
      <MemoryRouter>
        <GitHubConnectionPane />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: 'Replace token' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });
});
