import { apiClient, ApiError } from './client';
import type { DraftVerdict, PrReference, ReviewSessionDto, ReviewSessionPatch } from './types';

// Per-launch tab id used by SSE multi-tab consistency (spec § 4.5 / § 5.7).
// `crypto.randomUUID()` is available in jsdom v22+ and every browser the PoC
// targets.
let _tabId: string | null = null;

export function getTabId(): string {
  if (_tabId === null) _tabId = crypto.randomUUID();
  return _tabId;
}

// Vitest seam — call between tests so each test gets a fresh tab id.
export function __resetTabIdForTest(): void {
  _tabId = null;
}

// Single source of truth for the cross-tab header name. Re-exported so the
// other api/*.ts writers (submit.ts, markViewed.ts) don't each redeclare their
// own constant and drift apart on a future rename. The BE accepts this header
// on every writer endpoint as the SSE filter dimension.
export const TAB_ID_HEADER = 'X-PRism-Tab-Id';

function tabIdHeader(): Record<string, string> {
  return { [TAB_ID_HEADER]: getTabId() };
}

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

// PR3's PrDraftEndpoints validates verdict input as camelCase ("requestChanges").
// The frontend canonical type uses the GET-response shape ("request-changes").
// Translate at the wire boundary. See deferrals doc § "DraftVerdict wire shape
// asymmetric".
function verdictToWire(v: DraftVerdict): string {
  return v === 'request-changes' ? 'requestChanges' : v;
}

// Verdict-clear (spec § 10): null payload serializes to a present-null
// `draftVerdict` so PR3's JsonElement parser reads it as an explicit clear,
// not an absent field. Any value goes through the camelCase translation.
function verdictPatchValue(v: DraftVerdict | null): string | null {
  return v === null ? null : verdictToWire(v);
}

// Discriminated union → wire's "exactly one field set" body shape (spec § 4.2).
// The `default: never` clause guarantees adding a new patch kind without
// updating this switch produces a TS compile error.
export function serializePatch(patch: ReviewSessionPatch): Record<string, unknown> {
  switch (patch.kind) {
    case 'draftVerdict':
      return { draftVerdict: verdictPatchValue(patch.payload) };
    case 'draftSummaryMarkdown':
      return { draftSummaryMarkdown: patch.payload };
    case 'newDraftComment':
      return { newDraftComment: patch.payload };
    case 'newPrRootDraftComment':
      return { newPrRootDraftComment: patch.payload };
    case 'updateDraftComment':
      return { updateDraftComment: patch.payload };
    case 'deleteDraftComment':
      return { deleteDraftComment: patch.payload };
    case 'newDraftReply':
      return { newDraftReply: patch.payload };
    case 'updateDraftReply':
      return { updateDraftReply: patch.payload };
    case 'deleteDraftReply':
      return { deleteDraftReply: patch.payload };
    case 'confirmVerdict':
      // Per addendum A9: always emit `true`. The backend's
      // EnumerateSetFields treats `false` as "not set" and would reject
      // a payload `{ confirmVerdict: false }` as zero-set.
      return { confirmVerdict: true };
    case 'markAllRead':
      return { markAllRead: true };
    case 'overrideStale':
      return { overrideStale: patch.payload };
    default: {
      const _exhaustive: never = patch;
      throw new Error(`Unhandled patch kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export type SendPatchResult =
  | { ok: true; assignedId: string | null }
  | { ok: false; status: 404; kind: 'draft-not-found'; body: unknown }
  | { ok: false; status: 422; kind: 'invalid-body'; body: unknown }
  | { ok: false; status: 409; kind: 'conflict'; body: unknown }
  | { ok: false; status: 400; kind: 'bad-request'; body: unknown }
  | { ok: false; status: 0; kind: 'network'; body: unknown }
  | { ok: false; status: number; kind: 'other'; body: unknown };

export async function getDraft(prRef: PrReference): Promise<ReviewSessionDto> {
  return apiClient.get<ReviewSessionDto>(`${prPath(prRef)}/draft`, { headers: tabIdHeader() });
}

export async function sendPatch(
  prRef: PrReference,
  patch: ReviewSessionPatch,
): Promise<SendPatchResult> {
  const body = serializePatch(patch);
  const isCreate =
    patch.kind === 'newDraftComment' ||
    patch.kind === 'newPrRootDraftComment' ||
    patch.kind === 'newDraftReply';

  let resp: unknown;
  try {
    resp = await apiClient.put<unknown>(`${prPath(prRef)}/draft`, body, {
      headers: tabIdHeader(),
    });
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 404)
        return { ok: false, status: 404, kind: 'draft-not-found', body: e.body };
      if (e.status === 422) return { ok: false, status: 422, kind: 'invalid-body', body: e.body };
      if (e.status === 409) return { ok: false, status: 409, kind: 'conflict', body: e.body };
      if (e.status === 400) return { ok: false, status: 400, kind: 'bad-request', body: e.body };
      return { ok: false, status: e.status, kind: 'other', body: e.body };
    }
    // Non-ApiError = network / fetch / programmer error. sendPatch never
    // throws on this path so callers never have to wrap it in try/catch
    // (the auto-save flow's `await inFlightCreate.current` and the
    // discard handlers all rely on this no-throw contract).
    return {
      ok: false,
      status: 0,
      kind: 'network',
      body: e instanceof Error ? e.message : String(e),
    };
  }

  if (isCreate) {
    // Backend contract for create patches: 200 + { assignedId: string }
    // (PR3's AssignedIdResponse). A response missing the key OR with a
    // non-string value violates the contract — surface as a failure
    // rather than silently losing the assignedId, since downstream
    // callers (useComposerAutoSave.handleAssignedId(id: string)) require
    // a valid string.
    const hasField = typeof resp === 'object' && resp !== null && 'assignedId' in resp;
    const candidate = hasField ? (resp as { assignedId: unknown }).assignedId : undefined;
    if (typeof candidate === 'string' && candidate.length > 0) {
      return { ok: true, assignedId: candidate };
    }
    return {
      ok: false,
      status: 200,
      kind: 'other',
      body: { error: 'malformed-assigned-id', received: candidate },
    };
  }
  return { ok: true, assignedId: null };
}

export type ReloadConflictKind = 'reload-stale-head' | 'reload-in-progress' | 'conflict';

export type PostReloadResult =
  | { ok: true }
  | { ok: false; status: 409; kind: ReloadConflictKind; body: unknown }
  | { ok: false; status: 0; kind: 'network'; body: unknown }
  | { ok: false; status: number; kind: 'other'; body: unknown };

export async function postReload(prRef: PrReference, headSha: string): Promise<PostReloadResult> {
  try {
    await apiClient.post<unknown>(
      `${prPath(prRef)}/reload`,
      { headSha },
      { headers: tabIdHeader() },
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status === 409) {
        return { ok: false, status: 409, kind: parseReloadConflictKind(e.body), body: e.body };
      }
      return { ok: false, status: e.status, kind: 'other', body: e.body };
    }
    // Same no-throw contract as sendPatch — the reload caller in
    // FilesTab cannot recover meaningfully from a thrown network error
    // mid-await.
    return {
      ok: false,
      status: 0,
      kind: 'network',
      body: e instanceof Error ? e.message : String(e),
    };
  }
}

function parseReloadConflictKind(body: unknown): ReloadConflictKind {
  if (typeof body === 'object' && body !== null && 'error' in body) {
    const err = (body as { error?: unknown }).error;
    if (err === 'reload-stale-head') return 'reload-stale-head';
    if (err === 'reload-in-progress') return 'reload-in-progress';
  }
  return 'conflict';
}
