import { describe, it, expect } from 'vitest';
import { readKey, writeKey } from './PreferencesContext';
import type { PreferencesResponse } from '../api/types';

function base(): PreferencesResponse {
  return {
    ui: {
      theme: 'dark',
      accent: 'indigo',
      aiMode: 'preview',
      density: 'comfortable',
      contentScale: 'm',
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
    github: { host: 'https://github.com', configPath: 'c', logsPath: 'l' },
  };
}

describe('PreferencesContext AI numeric keys', () => {
  it('readKey returns the two AI numeric values', () => {
    expect(readKey(base(), 'ui.ai.providerTimeoutSeconds')).toBe(240);
    expect(readKey(base(), 'ui.ai.hunkAnnotationCap')).toBe(10);
  });

  it('writeKey updates providerTimeoutSeconds without touching inbox sections', () => {
    const next = writeKey(base(), 'ui.ai.providerTimeoutSeconds', 300);
    expect(next.ui.providerTimeoutSeconds).toBe(300);
    expect(next.inbox.sections['review-requested']).toBe(true); // not corrupted by the fall-through
  });

  it('writeKey updates hunkAnnotationCap', () => {
    const next = writeKey(base(), 'ui.ai.hunkAnnotationCap', 25);
    expect(next.ui.hunkAnnotationCap).toBe(25);
  });
});
