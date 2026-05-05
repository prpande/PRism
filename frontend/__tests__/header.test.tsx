import { render, screen } from '@testing-library/react';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { MemoryRouter } from 'react-router-dom';
import { Header } from '../src/components/Header/Header';

const server = setupServer(
  http.get('/api/preferences', () =>
    HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
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
