import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';
import { AppearanceSync } from './AppearanceSync';
import { PreferencesContext } from '../contexts/PreferencesContext';
import type { PreferencesResponse } from '../api/types';

// jsdom is not reset between tests, so the <html> data-* attributes / custom
// properties written by one test would leak into the next; clear them all so each
// test asserts against a clean document (order-independent).
afterEach(() => {
  document.documentElement.removeAttribute('data-content-scale');
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.density;
  document.documentElement.style.removeProperty('--accent-h');
  document.documentElement.style.removeProperty('--accent-c');
});

function prefs(contentScale: PreferencesResponse['ui']['contentScale']): PreferencesResponse {
  return {
    ui: {
      theme: 'system',
      accent: 'indigo',
      aiPreview: false,
      density: 'comfortable',
      contentScale,
    },
    inbox: {
      sections: {
        'review-requested': true,
        'awaiting-author': true,
        'authored-by-me': true,
        mentioned: true,
        'recently-closed': true,
      },
      defaultSort: 'updated',
      sectionOrder: 'review-requested,awaiting-author,authored-by-me,mentioned',
      showActivityRail: false,
      groupByRepo: true,
    },
    github: { host: 'h', configPath: 'c', logsPath: 'l' },
  };
}

// AppearanceSync replaces HeaderControls' old mount-effect as the headless
// boot-time applier of the saved theme/accent/density/contentScale to <html>. The
// quick toggles were removed from the navbar (covered by Settings), but the
// apply-on-load side effect must survive — otherwise non-Settings pages render in
// the default light theme regardless of the user's saved preference.
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
  it('applies the saved contentScale to <html> on load', () => {
    render(
      <PreferencesContext.Provider
        value={{
          preferences: prefs('xl'),
          error: null,
          refetch: async () => {},
          set: async () => prefs('xl'),
        }}
      >
        <AppearanceSync />
      </PreferencesContext.Provider>,
    );
    expect(document.documentElement.getAttribute('data-content-scale')).toBe('xl');
  });

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
