export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'indigo' | 'amber' | 'teal';
export type Density = 'comfortable' | 'compact';
export type ContentScale = 'xs' | 's' | 'm' | 'l' | 'xl';

// S6 PR1 widened GET /api/preferences from the flat { theme, accent, aiPreview }
// shape to a nested { ui, inbox, github } shape (spec § 2.4). UiPreferences is now
// the inner `ui` block; PreferencesResponse wraps all three. PR3 will introduce
// the Settings page consumers; existing call sites (HeaderControls, InboxPage,
// PrHeader, OverviewTab, AiComposerAssistant) read via `preferences.ui.<field>`.
// PR9b-density added the `density` field; backend defaults to "comfortable" on
// legacy configs that lack the key.
export interface UiPreferences {
  theme: Theme;
  accent: Accent;
  aiPreview: boolean;
  density: Density;
  contentScale: ContentScale;
}

export interface InboxSectionsPreferences {
  'review-requested': boolean;
  'awaiting-author': boolean;
  'authored-by-me': boolean;
  mentioned: boolean;
  'recently-closed': boolean;
}

export interface InboxPreferences {
  sections: InboxSectionsPreferences;
  defaultSort: SortKey;
  sectionOrder: string;
  // #283 gates the (fabricated, non-AI) activity rail. Decoupled from the AI-preview
  // toggle onto this dedicated flag; default false (config-only, no Settings UI yet).
  showActivityRail: boolean;
}

export interface GithubPreferences {
  host: string;
  configPath: string;
  logsPath: string;
}

export interface PreferencesResponse {
  ui: UiPreferences;
  inbox: InboxPreferences;
  github: GithubPreferences;
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

// Wire contract for GET /api/capabilities. Retained as the endpoint's response
// shape: since #221 the SPA derives capabilities from the shared aiPreview
// preference (useCapabilities) rather than calling this endpoint, but D112 will
// restore an independent fetch that consumes this type. See useCapabilities.ts.
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

export type CiStatus = 'none' | 'pending' | 'failing' | 'passing';

export interface PrReference {
  owner: string;
  repo: string;
  number: number;
}

// Canonical "owner/repo/number" string form of a PrReference. This is the
// shape the backend's SSE `prRef` field uses, so every place that matches an
// SSE event against the current PR (useSubmit, useSubmitToasts, …) must derive
// it the same way — centralized here so the format can't drift.
export function prRefKey(reference: PrReference): string {
  return `${reference.owner}/${reference.repo}/${reference.number}`;
}

export interface PrInboxItem {
  reference: PrReference;
  title: string;
  author: string;
  avatarUrl?: string | null;
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
  mergedAt: string | null;
  closedAt: string | null;
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

export type SortKey = 'updated' | 'pushed' | 'diff' | 'comments';

export interface InboxResponse {
  sections: InboxSection[];
  enrichments: Record<string, InboxItemEnrichment>;
  lastRefreshedAt: string;
  tokenScopeFooterEnabled: boolean;
  ciProbeComplete: boolean;
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
  avatarUrl?: string | null;
  htmlUrl?: string | null;
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
  mergedAt: string | null;
  closedAt: string | null;
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
  avatarUrl?: string | null;
  createdAt: string;
  body: string;
}

export interface ReviewCommentDto {
  commentId: string;
  author: string;
  avatarUrl?: string | null;
  createdAt: string;
  body: string;
  editedAt: string | null;
  databaseId?: number | null; // #302 — REST numeric id for optimistic de-dup
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

// PR9b-ai-gating § 3.3. The backend `FocusLevel` enum carries 3 values;
// today's PlaceholderFileFocusRanker emits High + Medium. Wire-shape:
// kebab-case via JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())
// — see JsonSerializerOptionsFactory.cs:44.
export type FocusLevel = 'high' | 'medium' | 'low';

export interface FileFocus {
  path: string;
  level: FocusLevel;
}

// AnnotationTone carries 3 backend values (PRism.AI.Contracts/Dtos/
// HunkAnnotation.cs:5-10: Calm, HeadsUp, Concern). Today's placeholder
// emits Calm + HeadsUp only; widening the type ensures a future
// placeholder edit or v2 backend swap renders 'concern' deterministically
// rather than silently narrowing.
export type AnnotationTone = 'calm' | 'heads-up' | 'concern';

export interface HunkAnnotation {
  path: string;
  hunkIndex: number;
  body: string;
  tone: AnnotationTone;
}

export interface DraftSuggestion {
  filePath: string;
  lineNumber: number;
  body: string;
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

export interface DiffLine {
  type: 'context' | 'insert' | 'delete' | 'hunk-header';
  content: string;
  oldLineNum: number | null;
  newLineNum: number | null;
  isFilled?: true;
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
  postedCommentId: number | null;
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
// Note on clear-verdict: S5 PR3 switched PUT /draft to JsonElement parsing,
// so the backend now accepts `{"draftVerdict": null}` as an explicit clear
// (spec § 10). PR4's verdict picker (spec § 10 / § 8.3) wires the clear
// semantics: the `{ kind: 'draftVerdict'; payload: null }` variant below
// maps to a `{ draftVerdict: null }` body in serializePatch.
// draftSummaryMarkdown was removed in Task 15; the PR-root review summary
// is now a PR-root DraftComment (filePath/lineNumber null).
export type ReviewSessionPatch =
  | { kind: 'draftVerdict'; payload: DraftVerdict | null }
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

// Task 14 — root-comment-posted: PR-root draft posted as a GitHub issue comment.
// Frontend only triggers a refetch; issueCommentId is carried for completeness.
export interface RootCommentPostedEvent {
  prRef: string;
  issueCommentId: number;
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

// #137 Activity rail (Phase 1). Mirrors PRism.Core/Activity contracts; enums are
// the kebab-case wire strings. P2 grows ActivityResponse (Watching) + ActivityVerb
// (review-requested, mentioned) + degraded flags additively — read leniently.
export type ActivityVerb =
  | 'opened'
  | 'reopened'
  | 'closed'
  | 'merged'
  | 'reviewed'
  | 'commented'
  | 'other';

export type ActivitySource = 'received-event';

export interface ActivityItem {
  actorLogin: string | null;
  actorAvatarUrl: string | null;
  actorIsBot: boolean;
  verb: ActivityVerb;
  repo: string;
  prNumber: number;
  title: string | null;
  url: string;
  timestamp: string;
  source: ActivitySource;
}

export interface ActivityDegradation {
  receivedEvents: boolean;
}

export interface ActivityResponse {
  items: ActivityItem[];
  generatedAt: string;
  degraded: ActivityDegradation;
}
