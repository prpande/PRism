import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
      aiMode: 'off',
      density: 'comfortable',
      contentScale,
      providerTimeoutSeconds: 240,
      hunkAnnotationCap: 10,
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

// #330: with theme === 'system', applyThemeToDocument samples prefers-color-scheme
// at call time. AppearanceSync subscribes to the media query so an OS light↔dark
// switch re-resolves live instead of waiting for the next preference refetch. The
// global setup.ts matchMedia stub has a no-op addEventListener, so this installs a
// controllable one that can actually fire 'change'.
function installControllableMatchMedia(initialDark: boolean) {
  let matches = initialDark;
  const listeners = new Set<() => void>();
  const mql = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
    dispatchEvent: () => false,
  };
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: vi.fn().mockReturnValue(mql),
  });
  return {
    setDark(next: boolean) {
      matches = next;
      listeners.forEach((cb) => cb());
    },
  };
}

function restoreInertMatchMedia() {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

describe('AppearanceSync — live system-theme switch (#330)', () => {
  it('re-resolves the system theme when the OS switches light→dark', async () => {
    const os = installControllableMatchMedia(false); // OS starts light
    try {
      render(
        <PreferencesContext.Provider
          value={{
            preferences: prefs('m'), // theme is 'system' in the prefs() helper
            error: null,
            refetch: async () => {},
            set: async () => prefs('m'),
          }}
        >
          <AppearanceSync />
        </PreferencesContext.Provider>,
      );
      await waitFor(() => expect(document.documentElement.dataset.theme).toBe('light'));

      act(() => os.setDark(true)); // OS flips to dark

      await waitFor(() => expect(document.documentElement.dataset.theme).toBe('dark'));
    } finally {
      restoreInertMatchMedia();
    }
  });
});
