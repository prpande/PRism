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
}

export type CiStatus = 'none' | 'pending' | 'failing';

export interface PrReference {
  owner: string;
  repo: string;
  number: number;
}

export interface PrInboxItem {
  reference: PrReference;
  title: string;
  author: string;
  repo: string;
  updatedAt: string;
  pushedAt: string;
  iterationNumber: number;
  commentCount: number;
  additions: number;
  deletions: number;
  headSha: string;
  ci: CiStatus;
  lastViewedHeadSha: string | null;
  lastSeenCommentId: number | null;
}

export interface InboxSection {
  id: string;
  label: string;
  items: PrInboxItem[];
}

export interface InboxItemEnrichment {
  prId: string;
  categoryChip: string | null;
  hoverSummary: string | null;
}

export interface InboxResponse {
  sections: InboxSection[];
  enrichments: Record<string, InboxItemEnrichment>;
  lastRefreshedAt: string;
  tokenScopeFooterEnabled: boolean;
}

export interface ParsePrUrlResponse {
  ok: boolean;
  ref: PrReference | null;
  error: 'host-mismatch' | 'not-a-pr-url' | 'malformed' | null;
  configuredHost: string | null;
  urlHost: string | null;
}

export interface InboxUpdatedEvent {
  changedSectionIds: string[];
  newOrUpdatedPrCount: number;
}
