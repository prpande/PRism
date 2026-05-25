import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '../src/components/Header/Header';

const server = setupServer(
  http.get('/api/preferences', () =>
    HttpResponse.json({
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
        configPath: '/fake/config.json',
        logsPath: '/fake/logs',
      },
    }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('Header', () => {
  it('renders logo + Inbox/Setup tabs + global-search placeholder', () => {
    render(
      <MemoryRouter>
        <Header />
      </MemoryRouter>,
    );
    expect(screen.getByText(/PRism/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /inbox/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /setup/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/jump to PR or file/i)).toBeInTheDocument();
  });
});
