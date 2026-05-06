export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'indigo' | 'amber' | 'teal';

export interface UiPreferences {
  theme: Theme;
  accent: Accent;
  aiPreview: boolean;
}

export interface AiCapabilities {
  summary: boolean;
  fileFocus: boolean;
  hunkAnnotations: boolean;
  preSubmitValidators: boolean;
  composerAssist: boolean;
  draftSuggestions: boolean;
  draftReconciliation: boolean;
  inboxEnrichment: boolean;
  inboxRanking: boolean;
}

export interface CapabilitiesResponse {
  ai: AiCapabilities;
}

export interface AuthState {
  hasToken: boolean;
  host: string;
  hostMismatch: { old: string; new: string } | null;
}

export interface ConnectResponse {
  ok: boolean;
  login?: string;
  host?: string;
  error?: string;
  detail?: string;
  warning?: 'no-repos-selected';
}
