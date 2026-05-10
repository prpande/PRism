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

export interface PrSummary {
  body: string;
  category: string;
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

// S4 — draft session types (spec § 5.9, wire shapes per spec § 4).

export type DraftStatus = 'draft' | 'moved' | 'stale';

// GET /api/pr/{ref}/draft serializes the C# DraftVerdict enum via
// JsonStringEnumConverter + KebabCaseJsonNamingPolicy, so RequestChanges
// arrives as 'request-changes'. PUT input accepts the camelCase form
// ('requestChanges'); api/draft.ts:serializePatch translates before sending.
export type DraftVerdict = 'approve' | 'request-changes' | 'comment';

export type DraftVerdictStatus = 'draft' | 'needs-reconfirm';

export type DraftSide = 'left' | 'right';

export interface DraftCommentDto {
  id: string;
  filePath: string | null;
  lineNumber: number | null;
  side: DraftSide | null;
  anchoredSha: string | null;
  anchoredLineContent: string | null;
  bodyMarkdown: string;
  status: DraftStatus;
  isOverriddenStale: boolean;
}

export interface DraftReplyDto {
  id: string;
  parentThreadId: string;
  replyCommentId: string | null;
  bodyMarkdown: string;
  status: DraftStatus;
  isOverriddenStale: boolean;
}

// Empty in S4 — backend's IterationOverrideDto is a placeholder for future
// iteration-override metadata (see PRism.Web/Endpoints/PrDraftDtos.cs).
export type IterationOverrideDto = Record<string, never>;

export interface FileViewStateDto {
  viewedFiles: Record<string, string>;
}

export interface ReviewSessionDto {
  draftVerdict: DraftVerdict | null;
  draftVerdictStatus: DraftVerdictStatus;
  draftSummaryMarkdown: string | null;
  draftComments: DraftCommentDto[];
  draftReplies: DraftReplyDto[];
  iterationOverrides: IterationOverrideDto[];
  pendingReviewId: string | null;
  pendingReviewCommitOid: string | null;
  fileViewState: FileViewStateDto;
}

// Patch payloads (spec § 4.2). Mirror the backend records in PrDraftDtos.cs.

export interface NewDraftCommentPayload {
  filePath: string;
  lineNumber: number;
  side: DraftSide;
  anchoredSha: string;
  anchoredLineContent: string;
  bodyMarkdown: string;
}

export interface NewPrRootDraftCommentPayload {
  bodyMarkdown: string;
}

export interface UpdateDraftCommentPayload {
  id: string;
  bodyMarkdown: string;
}

export interface NewDraftReplyPayload {
  parentThreadId: string;
  bodyMarkdown: string;
}

export interface UpdateDraftReplyPayload {
  id: string;
  bodyMarkdown: string;
}

export interface DeleteDraftPayload {
  id: string;
}

export interface OverrideStalePayload {
  id: string;
}

// ReviewSessionPatch as a frontend-side discriminated union (spec § 5.9).
// api/draft.ts:serializePatch unwraps to the wire's "exactly one field set"
// shape (spec § 4.2). The exhaustiveness check in the serializer guarantees
// every kind is handled at compile time.
//
// Note on draftVerdict: `payload: null` is intentionally excluded. Spec
// § 4.2 lists null as a valid wire value, but PR3's backend
// `EnumerateSetFields` (PrDraftEndpoints.cs:331) filters null DraftVerdict
// as "not set", which would round-trip a "clear verdict" intent through
// the multi-field guard as zero-set and 400. Until the backend accepts
// null as "clear", the frontend cannot represent a clear-verdict patch.
export type ReviewSessionPatch =
  | { kind: 'draftVerdict'; payload: DraftVerdict }
  | { kind: 'draftSummaryMarkdown'; payload: string }
  | { kind: 'newDraftComment'; payload: NewDraftCommentPayload }
  | { kind: 'newPrRootDraftComment'; payload: NewPrRootDraftCommentPayload }
  | { kind: 'updateDraftComment'; payload: UpdateDraftCommentPayload }
  | { kind: 'deleteDraftComment'; payload: DeleteDraftPayload }
  | { kind: 'newDraftReply'; payload: NewDraftReplyPayload }
  | { kind: 'updateDraftReply'; payload: UpdateDraftReplyPayload }
  | { kind: 'deleteDraftReply'; payload: DeleteDraftPayload }
  | { kind: 'confirmVerdict' }
  | { kind: 'markAllRead' }
  | { kind: 'overrideStale'; payload: OverrideStalePayload };

export interface AssignedIdResponse {
  assignedId: string;
}

// SSE event payloads added in PR3 (spec § 4.5). sourceTabId is null for events
// not originating from an HTTP request; the multi-tab subscriber filters
// matching tab ids to suppress own-tab refetch noise.
export interface StateChangedEvent {
  prRef: string;
  fieldsTouched: string[];
  sourceTabId: string | null;
}

export interface DraftSavedEvent {
  prRef: string;
  draftId: string;
  sourceTabId: string | null;
}

export interface DraftDiscardedEvent {
  prRef: string;
  draftId: string;
  sourceTabId: string | null;
}
