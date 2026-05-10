import { apiClient, ApiError } from './client';
import type {
  AssignedIdResponse,
  DraftVerdict,
  PrReference,
  ReviewSessionDto,
  ReviewSessionPatch,
} from './types';

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

const TAB_ID_HEADER = 'X-PRism-Tab-Id';

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

// Discriminated union → wire's "exactly one field set" body shape (spec § 4.2).
// The `default: never` clause guarantees adding a new patch kind without
// updating this switch produces a TS compile error.
export function serializePatch(patch: ReviewSessionPatch): Record<string, unknown> {
  switch (patch.kind) {
    case 'draftVerdict':
      return { draftVerdict: verdictToWire(patch.payload) };
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
  try {
    const resp = await apiClient.put<unknown>(`${prPath(prRef)}/draft`, body, {
      headers: tabIdHeader(),
    });
    if (isCreate && typeof resp === 'object' && resp !== null && 'assignedId' in resp) {
      return { ok: true, assignedId: (resp as AssignedIdResponse).assignedId };
    }
    return { ok: true, assignedId: null };
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 404) return { ok: false, status: 404, kind: 'draft-not-found', body: e.body };
    if (e.status === 422) return { ok: false, status: 422, kind: 'invalid-body', body: e.body };
    if (e.status === 409) return { ok: false, status: 409, kind: 'conflict', body: e.body };
    if (e.status === 400) return { ok: false, status: 400, kind: 'bad-request', body: e.body };
    return { ok: false, status: e.status, kind: 'other', body: e.body };
  }
}

export type ReloadConflictKind = 'reload-stale-head' | 'reload-in-progress' | 'conflict';

export type PostReloadResult =
  | { ok: true }
  | { ok: false; status: 409; kind: ReloadConflictKind; body: unknown }
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
    if (!(e instanceof ApiError)) throw e;
    if (e.status === 409) {
      return { ok: false, status: 409, kind: parseReloadConflictKind(e.body), body: e.body };
    }
    return { ok: false, status: e.status, kind: 'other', body: e.body };
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
