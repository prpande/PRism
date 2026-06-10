import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppearanceSync } from './AppearanceSync';
import { PreferencesContext } from '../contexts/PreferencesContext';
import type { PreferencesResponse } from '../api/types';

function prefs(contentScale: PreferencesResponse['ui']['contentScale']): PreferencesResponse {
  return {
    ui: {
      theme: 'system',
      accent: 'indigo',
      aiMode: 'off',
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

afterEach(() => document.documentElement.removeAttribute('data-content-scale'));

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
});
