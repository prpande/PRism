import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { HeaderControls } from '../src/components/Header/HeaderControls';

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('HeaderControls', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/preferences', () =>
        HttpResponse.json({ theme: 'system', accent: 'indigo', aiPreview: false }),
      ),
    );
  });

  it('renders three buttons (theme/accent/ai)', async () => {
    render(<HeaderControls />);
    expect(await screen.findByRole('button', { name: /theme/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accent/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /ai preview/i })).toBeInTheDocument();
  });

  it('cycles theme on click and posts a single-field patch', async () => {
    let requestBody: unknown;
    server.use(
      http.post('/api/preferences', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({ theme: 'light', accent: 'indigo', aiPreview: false });
      }),
    );
    render(<HeaderControls />);
    const themeButton = await screen.findByRole('button', { name: /theme/i });
    await userEvent.click(themeButton);
    expect(requestBody).toEqual({ theme: 'light' });
  });
});
