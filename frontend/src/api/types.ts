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
// Note on clear-verdict / clear-summary: S5 PR3 switched PUT /draft to
// JsonElement parsing, so the backend now accepts `{"draftVerdict": null}`
// (and `{"draftSummaryMarkdown": null}`) as an explicit clear (spec § 10).
// PR4's verdict picker (spec § 10 / § 8.3) wires the clear semantics: the
// `{ kind: 'draftVerdict'; payload: null }` variant below maps to a
// `{ draftVerdict: null }` body in serializePatch.
export type ReviewSessionPatch =
  | { kind: 'draftVerdict'; payload: DraftVerdict | null }
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

// S5 PR3 submit-pipeline SSE events (spec § 7.4 / § 7.5 / § 13.2). Counts + IDs only — the
// per-PR fanout is broader-than-spec, so payloads never carry thread/reply bodies, the orphan
// review id, or pendingReviewId (threat-model defense). step / status are the C# enum names.

export type SubmitStep =
  | 'DetectExistingPendingReview'
  | 'BeginPendingReview'
  | 'AttachThreads'
  | 'AttachReplies'
  | 'Finalize';

export type SubmitStepStatus = 'Started' | 'Succeeded' | 'Failed';

export interface SubmitProgressEvent {
  prRef: string;
  step: SubmitStep;
  status: SubmitStepStatus;
  done: number;
  total: number;
  errorMessage: string | null;
}

export interface SubmitForeignPendingReviewEvent {
  prRef: string;
  pullRequestReviewId: string;
  commitOid: string;
  createdAt: string;
  threadCount: number;
  replyCount: number;
}

export interface SubmitStaleCommitOidEvent {
  prRef: string;
  orphanCommitOid: string;
}

export interface SubmitOrphanCleanupFailedEvent {
  prRef: string;
}

export interface SubmitDuplicateMarkerDetectedEvent {
  prRef: string;
  draftId: string;
}

// S5 PR4 — submit-pipeline frontend types.

// POST /api/pr/{ref}/submit body verdict is PascalCase (the C# Verdict enum
// name), distinct from the kebab-case DraftVerdict the session/PUT-draft path
// uses. api/submit.ts:verdictToSubmitWire bridges DraftVerdict → Verdict.
export type Verdict = 'Approve' | 'RequestChanges' | 'Comment';

// IPreSubmitValidator result (spec § 14.1). PoC's NoopPreSubmitValidator
// returns []; under aiPreview the slot renders frontend-side canned data.
export type ValidatorSeverity = 'Suggestion' | 'Concern' | 'Blocking';

export interface ValidatorResult {
  severity: ValidatorSeverity;
  message: string;
}

// Imported thread/reply shapes from POST /submit/foreign-pending-review/resume's
// 200 response (spec § 7.2 / § 11.1) — full marker-stripped bodies. PR5 consumes
// these; PR4 declares the types for the api/submit.ts client helper signature.
export interface ImportedThread {
  id: string;
  filePath: string;
  lineNumber: number;
  side: string;
  isResolved: boolean;
  body: string;
  replies: { id: string; body: string }[];
}

export interface ResumeForeignPendingReviewResponse {
  pullRequestReviewId: string;
  commitOid: string;
  createdAt: string;
  threadCount: number;
  replyCount: number;
  threads: ImportedThread[];
}
