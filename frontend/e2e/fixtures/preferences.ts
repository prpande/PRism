// Canonical Playwright fixtures for the mocked-mode e2e specs (originally
// PR9b-density; #332 promoted this to the single source). The authed-auth +
// all-off-capabilities + default-preferences shapes back 10+ specs — directly
// and via helpers/base-mocks.ts (which wires the three constant routes from
// authedAuthState + allOffCapabilities). Add a wire field HERE once, not in N
// per-spec copies.

export const authedAuthState = {
  hasToken: true,
  host: 'https://github.com',
  hostMismatch: null,
  githubCredentialInvalid: false,
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
      contentScale: 'm' as const,
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
      // #275: the real GET /api/preferences always emits sectionOrder; keep the
      // shared mock in contract with it (canonical order = no reorder applied).
      // Canonical default leads with authored-by-me (your own PRs first).
      sectionOrder: 'authored-by-me,review-requested,awaiting-author,mentioned',
      // #283: real GET always emits showActivityRail. The PRODUCT default is now ON
      // (#439), but this shared mock deliberately pins it OFF so the rail doesn't appear
      // in mock-mode specs that aren't testing it (e.g. ai-gating-sweep asserts it stays
      // hidden under AI-on to prove the decouple). The rail-on appearance is covered by
      // the dedicated `inbox-activity-rail` parity baseline; specs that exercise the rail
      // set the flag explicitly.
      showActivityRail: false,
      // #219: real GET always emits groupByRepo; default true (Inbox grouped by repo).
      groupByRepo: true,
    },
    github: {
      host: 'https://github.com',
      configPath: '/Users/x/AppData/Local/PRism/config.json',
      logsPath: '/Users/x/AppData/Local/PRism/logs',
    },
  };
}

export type DensityPreferences = ReturnType<typeof makeDefaultPreferences>;
