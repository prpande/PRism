import { render, waitFor } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { AppearanceSync } from '../src/components/AppearanceSync';

// jsdom is not reset between tests, so the <html> data-* attributes written by
// one test would leak into the next; clear them so each test asserts against a
// clean document (order-independent).
afterEach(() => {
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  document.documentElement.style.removeProperty('--accent-h');
  document.documentElement.style.removeProperty('--accent-c');
});

// AppearanceSync replaces HeaderControls' old mount-effect as the headless
// boot-time applier of the saved theme/accent/density to <html>. The quick
// toggles were removed from the navbar (covered by Settings), but the
// apply-on-load side effect must survive — otherwise non-Settings pages render
// in the default light theme regardless of the user's saved preference.

function serverWith(ui: Record<string, unknown>) {
  return setupServer(
    http.get('/api/preferences', () =>
      HttpResponse.json({
        ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable', ...ui },
        inbox: { sections: {} },
        github: { host: 'https://github.com', configPath: '/c', logsPath: '/l' },
      }),
    ),
  );
}

describe('AppearanceSync', () => {
  it('applies the saved explicit theme to <html data-theme> on load', async () => {
    const server = serverWith({ theme: 'dark' });
    server.listen();
    try {
      render(<AppearanceSync />);
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    } finally {
      server.close();
    }
  });

  it('applies the saved compact density to <html data-density> on load', async () => {
    const server = serverWith({ density: 'compact' });
    server.listen();
    try {
      render(<AppearanceSync />);
      await waitFor(() =>
        expect(document.documentElement.getAttribute('data-density')).toBe('compact'),
      );
    } finally {
      server.close();
    }
  });

  it('renders nothing (headless)', () => {
    const server = serverWith({});
    server.listen();
    try {
      const { container } = render(<AppearanceSync />);
      expect(container).toBeEmptyDOMElement();
    } finally {
      server.close();
    }
  });
});
