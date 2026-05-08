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

export interface PrDetailPr {
  reference: PrReference;
  title: string;
  body: string;
  author: string;
  state: string;
  headSha: string;
  baseSha: string;
  headBranch: string;
  baseBranch: string;
  mergeability: string;
  ciSummary: string;
  isMerged: boolean;
  isClosed: boolean;
  openedAt: string;
}

export type ClusteringQuality = 'ok' | 'low';

export interface CommitDto {
  sha: string;
  message: string;
  committedDate: string;
  additions: number;
  deletions: number;
}

export interface IterationDto {
  number: number;
  beforeSha: string;
  afterSha: string;
  commits: CommitDto[];
  hasResolvableRange: boolean;
}

export interface IssueCommentDto {
  id: number;
  author: string;
  createdAt: string;
  body: string;
}

export interface ReviewCommentDto {
  commentId: string;
  author: string;
  createdAt: string;
  body: string;
  editedAt: string | null;
}

export interface ReviewThreadDto {
  threadId: string;
  filePath: string;
  lineNumber: number;
  anchorSha: string;
  isResolved: boolean;
  comments: ReviewCommentDto[];
}

export interface PrDetailDto {
  pr: PrDetailPr;
  clusteringQuality: ClusteringQuality;
  iterations: IterationDto[] | null;
  commits: CommitDto[];
  rootComments: IssueCommentDto[];
  reviewComments: ReviewThreadDto[];
  timelineCapHit: boolean;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  body: string;
}

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  hunks: DiffHunk[];
}

export interface DiffDto {
  range: string;
  files: FileChange[];
  truncated: boolean;
}
