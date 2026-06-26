export type Theme = 'light' | 'dark' | 'system';
export type Accent = 'indigo' | 'amber' | 'teal';
export type Density = 'comfortable' | 'compact';
export type AiMode = 'off' | 'preview' | 'live';
export type ContentScale = 'xs' | 's' | 'm' | 'l' | 'xl';

// #496: why an AI seam failed, surfaced via the 503 body { reason }. Drives the timeout-specific
// toast copy + "Adjust timeout" deep-link. A missing/unknown reason defaults to 'provider-error'.
export type AiFailureReason = 'timeout' | 'provider-error';

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
  aiMode: AiMode;
  density: Density;
  contentScale: ContentScale;
  // #496 AI Settings tab — clamped, hot-reloaded knobs. The GET DTO already clamps these for display.
  providerTimeoutSeconds: number;
  hunkAnnotationCap: number;
  // #525 best-effort summary character cap (500–5000, default 1000). GET clamps for display; fed into
  // the summarizer prompt and stamped onto PrSummary.generatedMaxChars so the card can detect a cap change.
  summaryMaxChars: number;
  // #485 AI onboarding dialog: true once the user has dismissed the dialog via any committing exit
  // (Off, Preview "Maybe later", or Manage AI settings). Esc does NOT set this — re-shows next launch.
  onboardingSeen: boolean;
  // #536 per-feature AI enablement flags. Backend defaults all nine to true; treat as possibly-absent at
  // runtime (older configs / test fixtures may omit). All read sites use `preferences.ui.features?.[k] ?? true`.
  features?: AiFeatures;
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
  // #283 gates the (non-AI) activity rail; decoupled from the AI-preview toggle onto
  // this dedicated flag (default false). #137 wired the rail to real /api/activity
  // data and surfaced this flag as a Settings toggle (InboxPane).
  showActivityRail: boolean;
  // #219 when false, the Inbox renders flat PR lists instead of repo-grouped
  // accordions. Default true (grouped). Pure frontend-render preference.
  groupByRepo: boolean;
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

// Per-feature user-enablement flags (#536). Structurally identical to AiCapabilities
// but a distinct concept: `features` = what the user turned on/off; `capabilities` =
// what the AI mode makes available. The gate is capability && feature-enabled.
export interface AiFeatures {
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
// shape: since #221 the SPA derives capabilities from the shared aiMode
// preference (useCapabilities) rather than calling this endpoint, but D112 will
// restore an independent fetch that consumes this type. See useCapabilities.ts.
export interface CapabilitiesResponse {
  ai: AiCapabilities;
}

export interface AuthState {
  hasToken: boolean;
  host: string;
  hostMismatch: { old: string; new: string } | null;
  githubCredentialInvalid: boolean;
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

// Checks tab (#138) — kebab-case wire enums (match the C# JsonStringEnumConverter output).
export type CheckRunStatus = 'queued' | 'in-progress' | 'completed';
export type CheckConclusion =
  | 'success'
  | 'failure'
  | 'cancelled'
  | 'timed-out'
  | 'skipped'
  | 'neutral'
  | 'action-required'
  | 'stale'
  | 'startup-failure';
export type DegradedReason = 'none' | 'auth' | 'transient';

export interface CheckRun {
  name: string;
  status: CheckRunStatus;
  conclusion: CheckConclusion | null;
  source: 'check-run' | 'status';
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  summary: string | null;
  appName: string | null;
  body: string | null;
}

export interface ChecksResponse {
  checks: CheckRun[];
  headSha: string;
  degraded: DegradedReason;
}

// Imported for use in PrInboxItem below, and re-exported so consumers can import
// from the single api/types barrel without reaching into the component tree.
import type { MergeReadiness } from '../components/shared/mergeReadiness';
export type { MergeReadiness };

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

// #593 — a reviewer surfaced in the merge-readiness popover. `login` doubles as a team name for
// team review requests (those carry no avatar). Mirrors the backend Reviewer record.
export interface Reviewer {
  login: string;
  avatarUrl?: string | null;
}

export interface PrInboxItem {
  reference: PrReference;
  title: string;
  author: string;
  avatarUrl?: string | null;
  repo: string;
  updatedAt: string;
  pushedAt: string;
  commitCount: number;
  changedFiles: number;
  commentCount: number;
  additions: number;
  deletions: number;
  headSha: string;
  ci: CiStatus;
  lastViewedHeadSha: string | null;
  lastSeenCommentId: number | null;
  mergedAt: string | null;
  closedAt: string | null;
  isDraft: boolean;
  // #593 merge-readiness fields — optional so existing fixtures / route-mock bodies that
  // omit them stay valid (backend defaults to 'none' / null on older payloads).
  mergeReadiness?: MergeReadiness;
  approvals?: number | null;
  changesRequested?: number | null;
  // #593 reviewer name-lists for the readiness popover people section.
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
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
  aiEnrichmentSettled: string[];
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
  isDraft: boolean;
  openedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  mergeReadiness?: MergeReadiness;
  approvals?: number | null;
  changesRequested?: number | null;
  // #593 reviewer name-lists for the readiness popover people section.
  approvers?: Reviewer[] | null;
  changesRequestedBy?: Reviewer[] | null;
  awaitingReviewers?: Reviewer[] | null;
  updatedAt?: string;
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
  viewerReview?: ViewerReview | null;
}

// Shared four-value AI load state (spec §1). "off" is NOT a state — it is the
// useAiGate(...) capability gate; a disabled hook renders nothing. Surfaces map
// their hook's richer state down to this for the AiMarker / skeleton cue.
export type AiLoadState = 'loading' | 'ready' | 'empty' | 'error';

export interface PrSummary {
  body: string;
  category: string;
  // #525 the summary cap this summary was generated under (camelCase wire field). Optional/nullable so
  // legacy payloads + the ~existing `{ body, category }` test literals stay valid; a null/absent value is
  // never treated as stale. useAiSummary compares it to the live configured cap to offer Regenerate.
  generatedMaxChars?: number | null;
}

export type AiSummaryResult =
  | { kind: 'ok'; summary: PrSummary }
  | { kind: 'absent' }
  | { kind: 'auth' }
  | { kind: 'error'; reason: AiFailureReason };

// PR9b-ai-gating § 3.3. The backend `FocusLevel` enum carries 3 values;
// today's PlaceholderFileFocusRanker emits High + Medium. Wire-shape:
// kebab-case via JsonStringEnumConverter(new KebabCaseJsonNamingPolicy())
// — see JsonSerializerOptionsFactory.cs:44.
export type FocusLevel = 'high' | 'medium' | 'low';

export interface FileFocus {
  path: string;
  level: FocusLevel;
  rationale: string;
}

// Response envelope from GET …/ai/file-focus. `fallback` is the response-level all-medium signal.
export interface FileFocusResult {
  entries: FileFocus[];
  fallback: boolean;
}

// Discriminated UI status the shared fetch exposes (spec §8). `not-subscribed` is derived FE-side
// (the fetch is gated on subscription) and is Live-only; `loading` is in-flight; the rest map from
// the HTTP result.
export type FileFocusStatus =
  | 'loading'
  | 'ok'
  | 'empty'
  | 'no-changes'
  | 'not-subscribed'
  | 'error'
  | 'fallback';

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

// Kebab-case is the single canonical verdict wire form (#318): GET /draft,
// PUT /draft, and POST /submit all speak it. The C# DraftVerdict / SubmitEvent
// enums serialize via JsonStringEnumConverter + KebabCaseJsonNamingPolicy.
export type DraftVerdict = 'approve' | 'request-changes' | 'comment';

export type ReviewState = 'approved' | 'changes-requested' | 'commented';

export interface ViewerReview {
  state: ReviewState;
  submittedAt: string;
  commitSha: string | null;
}

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

// #450 — single-comment-posted: a single inline comment/reply was posted directly.
// Frontend triggers a PR-detail reload on receipt. reviewCommentId is carried on the wire
// for parity with the REST id but is currently unread by the subscriber (the reload + the
// loader's snapshot eviction handle freshness); kept for future de-dup, not yet consumed.
export interface SingleCommentPostedEvent {
  prRef: string;
  reviewCommentId: number;
}

// #392 — draft-submitted: a review was submitted (full success, after the server-side draft
// clear). Carries prRef only; the frontend uses it to reload PR detail so the just-posted
// threads + Overview comment surface without a manual reload.
export interface DraftSubmittedEvent {
  prRef: string;
}

// #566 — pr-lifecycle-changed: a PR's lifecycle state changed (merged, closed, reopened).
// Frontend clears the transition latch then reloads PR detail so the panel swaps button sets.
export interface PrLifecycleChangedEvent {
  prRef: string;
}

// S5 PR4 — submit-pipeline frontend types.

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

// #137 Activity rail (Phase 1 + Phase 2). Mirrors PRism.Core/Activity contracts; enums are
// the kebab-case wire strings. P2 adds ActivitySource 'notification', ActivityVerb
// 'review-requested'/'mentioned', WatchedRepoActivity, 3-flag ActivityDegradation,
// and ActivityResponse.watching — read leniently.
export type ActivityVerb =
  | 'opened'
  | 'reopened'
  | 'closed'
  | 'merged'
  | 'reviewed'
  | 'commented'
  | 'other'
  | 'review-requested'
  | 'mentioned'
  | 'ci-activity'
  | 'authored'
  | 'approved'
  | 'changes-requested'
  | 'pushed';

export type ActivitySource = 'received-event' | 'notification';

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
  notifications: boolean;
  watching: boolean;
}

export interface WatchedRepoActivity {
  repo: string;
  count: number;
  url: string;
}

export interface ActivityResponse {
  items: ActivityItem[];
  generatedAt: string;
  degraded: ActivityDegradation;
  watching: WatchedRepoActivity[];
}

// #517 — AI usage & spend. Mirrors PRism.Web/Ai/AiUsageReport.cs (camelCase wire shape).
export type AiUsageWindow = '24h' | '7d' | '30d' | 'all';

export interface AiUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
  cacheHits: number;
}

export interface AiUsageFeatureRow {
  component: string;
  displayName: string;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
}

export interface AiUsagePrRow {
  prRef: string;
  displayLabel: string;
  totalTokens: number;
  estimatedCostUsd: number;
  providerCalls: number;
}

export interface AiCacheStats {
  cacheHits: number;
  providerCalls: number;
  hitRate: number;
}

export interface AiUsageTrendBucket {
  bucketStart: string;
  granularity: string;
  estimatedCostUsd: number;
  totalTokens: number;
}

export interface AiUsageReport {
  window: AiUsageWindow;
  generatedAt: string;
  totals: AiUsageTotals;
  byFeature: AiUsageFeatureRow[];
  byPr: AiUsagePrRow[];
  totalPrCount: number;
  cache: AiCacheStats;
  trend: AiUsageTrendBucket[];
}
