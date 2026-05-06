import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { S3StubPrPage } from '../src/pages/S3StubPrPage';

describe('S3StubPrPage', () => {
  it('renders parsed PR reference from route params', () => {
    render(
      <MemoryRouter initialEntries={['/pr/foo/bar/42']}>
        <Routes>
          <Route path="/pr/:owner/:repo/:number" element={<S3StubPrPage />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText(/PR detail lands in S3/i)).toBeInTheDocument();
    expect(screen.getByText('foo/bar#42')).toBeInTheDocument();
  });

  it('Back to Inbox link navigates to /', async () => {
    render(
      <MemoryRouter initialEntries={['/pr/foo/bar/42']}>
        <Routes>
          <Route path="/" element={<div data-testid="inbox">inbox</div>} />
          <Route path="/pr/:owner/:repo/:number" element={<S3StubPrPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByText('Back to Inbox'));
    expect(await screen.findByTestId('inbox')).toBeInTheDocument();
  });
});
