// Shared Playwright fixtures for the density e2e specs (PR9b-density). The
// authed-auth + all-off-capabilities + default-preferences shapes are
// identical across density-toggle.spec.ts and density-cross-tab.spec.ts;
// extracting here means a future field add (e.g. when D87 PR9b-ai-gating
// ships) is a single-point edit instead of N duplicates.

export const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
} as const;

export const allOffCapabilities = {
  ai: {
    summary: false,
    fileFocus: false,
    hunkAnnotations: false,
    preSubmitValidators: false,
    composerAssist: false,
    draftSuggestions: false,
    draftReconciliation: false,
    inboxEnrichment: false,
    inboxRanking: false,
  },
} as const;

export function makeDefaultPreferences() {
  return {
    ui: {
      theme: 'system' as const,
      accent: 'indigo' as const,
      aiPreview: false,
      density: 'comfortable' as const,
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
    },
    github: {
      host: 'https://github.com',
      configPath: '/Users/x/AppData/Local/PRism/config.json',
      logsPath: '/Users/x/AppData/Local/PRism/logs',
    },
  };
}

export type DensityPreferences = ReturnType<typeof makeDefaultPreferences>;
