import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getDraft,
  getTabId,
  postReload,
  sendPatch,
  serializePatch,
  __resetTabIdForTest,
} from '../src/api/draft';
import { ApiError } from '../src/api/client';
import type {
  NewDraftCommentPayload,
  NewDraftReplyPayload,
  NewPrRootDraftCommentPayload,
  PrReference,
  ReviewSessionDto,
  ReviewSessionPatch,
  UpdateDraftCommentPayload,
  UpdateDraftReplyPayload,
} from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const PR_PATH = '/api/pr/octocat/hello/42';

const SAMPLE_NEW_COMMENT: NewDraftCommentPayload = {
  filePath: 'src/Foo.cs',
  lineNumber: 42,
  side: 'right',
  anchoredSha: 'a'.repeat(40),
  anchoredLineContent: '    return 0;',
  bodyMarkdown: 'Consider returning 1',
};

const SAMPLE_NEW_PR_ROOT: NewPrRootDraftCommentPayload = { bodyMarkdown: 'PR-level remark' };
const SAMPLE_UPDATE_COMMENT: UpdateDraftCommentPayload = { id: 'uuid-c', bodyMarkdown: 'edited' };
const SAMPLE_UPDATE_REPLY: UpdateDraftReplyPayload = { id: 'uuid-r', bodyMarkdown: 'edited reply' };
const SAMPLE_NEW_REPLY: NewDraftReplyPayload = {
  parentThreadId: 'PRRT_kwDOCRphzc6S',
  bodyMarkdown: 'reply text',
};

beforeEach(() => {
  vi.restoreAllMocks();
  __resetTabIdForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helpers ----------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function captureFetch(response: Response | (() => Response)) {
  const fn = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve(typeof response === 'function' ? response() : response),
    );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function lastInit(fetchMock: ReturnType<typeof vi.fn>): RequestInit {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1] as RequestInit;
}

function lastBodyJson(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = lastInit(fetchMock);
  expect(typeof init.body).toBe('string');
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

function lastUrl(fetchMock: ReturnType<typeof vi.fn>): string {
  return fetchMock.mock.calls[fetchMock.mock.calls.length - 1][0] as string;
}

// Round-trip per patch kind ---------------------------------------------
// Each test asserts the wire body has exactly one top-level key set, matching
// PR3's PrDraftEndpoints.EnumerateSetFields contract (spec § 4.2).

describe('serializePatch — wire shape per patch kind', () => {
  function expectExactlyOneField(wire: Record<string, unknown>, expectedKey: string) {
    const keys = Object.keys(wire);
    expect(keys).toEqual([expectedKey]);
  }

  it('draftVerdict — approve passes through', () => {
    const wire = serializePatch({ kind: 'draftVerdict', payload: 'approve' });
    expectExactlyOneField(wire, 'draftVerdict');
    expect(wire).toEqual({ draftVerdict: 'approve' });
  });

  it('draftVerdict — comment passes through', () => {
    const wire = serializePatch({ kind: 'draftVerdict', payload: 'comment' });
    expect(wire).toEqual({ draftVerdict: 'comment' });
  });

  it('draftVerdict — request-changes translates to camelCase requestChanges', () => {
    // Wire-shape asymmetry: PUT input takes camelCase but GET response renders
    // kebab-case. Frontend canonical type is the GET shape; serializer translates.
    const wire = serializePatch({ kind: 'draftVerdict', payload: 'request-changes' });
    expect(wire).toEqual({ draftVerdict: 'requestChanges' });
  });

  // No "null clears the verdict" test — the backend's EnumerateSetFields
  // filters null DraftVerdict as "not set" (PrDraftEndpoints.cs:331), so a
  // null payload would round-trip as a zero-set patch and 400. The frontend
  // type excludes null for that reason.

  it('draftSummaryMarkdown', () => {
    const wire = serializePatch({ kind: 'draftSummaryMarkdown', payload: 'Looks good overall.' });
    expectExactlyOneField(wire, 'draftSummaryMarkdown');
    expect(wire).toEqual({ draftSummaryMarkdown: 'Looks good overall.' });
  });

  it('newDraftComment carries the line-anchored payload', () => {
    const wire = serializePatch({ kind: 'newDraftComment', payload: SAMPLE_NEW_COMMENT });
    expectExactlyOneField(wire, 'newDraftComment');
    expect(wire).toEqual({ newDraftComment: SAMPLE_NEW_COMMENT });
  });

  it('newPrRootDraftComment is a separate kind (no anchor fields)', () => {
    const wire = serializePatch({ kind: 'newPrRootDraftComment', payload: SAMPLE_NEW_PR_ROOT });
    expectExactlyOneField(wire, 'newPrRootDraftComment');
    expect(wire).toEqual({ newPrRootDraftComment: SAMPLE_NEW_PR_ROOT });
  });

  it('updateDraftComment', () => {
    const wire = serializePatch({ kind: 'updateDraftComment', payload: SAMPLE_UPDATE_COMMENT });
    expectExactlyOneField(wire, 'updateDraftComment');
    expect(wire).toEqual({ updateDraftComment: SAMPLE_UPDATE_COMMENT });
  });

  it('deleteDraftComment', () => {
    const wire = serializePatch({ kind: 'deleteDraftComment', payload: { id: 'uuid-c' } });
    expectExactlyOneField(wire, 'deleteDraftComment');
    expect(wire).toEqual({ deleteDraftComment: { id: 'uuid-c' } });
  });

  it('newDraftReply', () => {
    const wire = serializePatch({ kind: 'newDraftReply', payload: SAMPLE_NEW_REPLY });
    expectExactlyOneField(wire, 'newDraftReply');
    expect(wire).toEqual({ newDraftReply: SAMPLE_NEW_REPLY });
  });

  it('updateDraftReply', () => {
    const wire = serializePatch({ kind: 'updateDraftReply', payload: SAMPLE_UPDATE_REPLY });
    expectExactlyOneField(wire, 'updateDraftReply');
    expect(wire).toEqual({ updateDraftReply: SAMPLE_UPDATE_REPLY });
  });

  it('deleteDraftReply', () => {
    const wire = serializePatch({ kind: 'deleteDraftReply', payload: { id: 'uuid-r' } });
    expectExactlyOneField(wire, 'deleteDraftReply');
    expect(wire).toEqual({ deleteDraftReply: { id: 'uuid-r' } });
  });

  it('confirmVerdict — always emits true, never false (addendum A9)', () => {
    // The backend's EnumerateSetFields treats `false` as "not set"; emitting
    // false here would be rejected as zero-set. The serializer takes a
    // payloadless kind and forces `true`.
    const wire = serializePatch({ kind: 'confirmVerdict' });
    expect(wire).toEqual({ confirmVerdict: true });
  });

  it('markAllRead — always emits true', () => {
    const wire = serializePatch({ kind: 'markAllRead' });
    expect(wire).toEqual({ markAllRead: true });
  });

  it('overrideStale carries the draft id', () => {
    const wire = serializePatch({ kind: 'overrideStale', payload: { id: 'uuid-stale' } });
    expectExactlyOneField(wire, 'overrideStale');
    expect(wire).toEqual({ overrideStale: { id: 'uuid-stale' } });
  });
});

// HTTP path --------------------------------------------------------------

describe('getDraft', () => {
  it('GETs the canonical draft path and returns the parsed body', async () => {
    const sample: ReviewSessionDto = {
      draftVerdict: null,
      draftVerdictStatus: 'draft',
      draftSummaryMarkdown: null,
      draftComments: [],
      draftReplies: [],
      iterationOverrides: [],
      pendingReviewId: null,
      pendingReviewCommitOid: null,
      fileViewState: { viewedFiles: {} },
    };
    const fetchMock = captureFetch(jsonResponse(200, sample));
    const result = await getDraft(ref);
    expect(result).toEqual(sample);
    expect(lastUrl(fetchMock)).toBe(`${PR_PATH}/draft`);
    expect(lastInit(fetchMock).method).toBe('GET');
  });

  it('attaches X-PRism-Tab-Id on every request', async () => {
    const fetchMock = captureFetch(jsonResponse(200, {}));
    await getDraft(ref);
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get('X-PRism-Tab-Id')).toBe(getTabId());
  });
});

describe('sendPatch — HTTP wiring', () => {
  it('PUTs to /api/pr/{ref}/draft with serialized body and X-PRism-Tab-Id header', async () => {
    const fetchMock = captureFetch(jsonResponse(200, {}));
    const result = await sendPatch(ref, { kind: 'confirmVerdict' });
    expect(result.ok).toBe(true);
    expect(lastUrl(fetchMock)).toBe(`${PR_PATH}/draft`);
    expect(lastInit(fetchMock).method).toBe('PUT');
    expect(lastBodyJson(fetchMock)).toEqual({ confirmVerdict: true });
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get('X-PRism-Tab-Id')).toBe(getTabId());
  });

  it('returns assignedId from the AssignedIdResponse on create patches', async () => {
    const fetchMock = captureFetch(jsonResponse(200, { assignedId: 'uuid-new' }));
    const result = await sendPatch(ref, {
      kind: 'newDraftComment',
      payload: SAMPLE_NEW_COMMENT,
    });
    expect(result).toEqual({ ok: true, assignedId: 'uuid-new' });
    expect(lastBodyJson(fetchMock)).toEqual({ newDraftComment: SAMPLE_NEW_COMMENT });
  });

  it('returns assignedId: null on non-create successful patches', async () => {
    captureFetch(jsonResponse(200, {}));
    const result = await sendPatch(ref, {
      kind: 'updateDraftComment',
      payload: SAMPLE_UPDATE_COMMENT,
    });
    expect(result).toEqual({ ok: true, assignedId: null });
  });

  it('maps 404 to draft-not-found', async () => {
    captureFetch(jsonResponse(404, { error: 'draft-not-found' }));
    const result = await sendPatch(ref, {
      kind: 'updateDraftComment',
      payload: SAMPLE_UPDATE_COMMENT,
    });
    expect(result).toEqual({
      ok: false,
      status: 404,
      kind: 'draft-not-found',
      body: { error: 'draft-not-found' },
    });
  });

  it('maps 422 to invalid-body', async () => {
    captureFetch(jsonResponse(422, { error: 'body-too-large' }));
    const result = await sendPatch(ref, {
      kind: 'updateDraftComment',
      payload: SAMPLE_UPDATE_COMMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(422);
      expect(result.kind).toBe('invalid-body');
    }
  });

  it('maps 409 to conflict', async () => {
    captureFetch(jsonResponse(409, { error: 'reload-stale-head' }));
    const result = await sendPatch(ref, {
      kind: 'updateDraftComment',
      payload: SAMPLE_UPDATE_COMMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.kind).toBe('conflict');
    }
  });

  it('maps 400 to bad-request', async () => {
    captureFetch(jsonResponse(400, { error: 'invalid-patch-shape' }));
    const result = await sendPatch(ref, {
      kind: 'updateDraftComment',
      payload: SAMPLE_UPDATE_COMMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.kind).toBe('bad-request');
    }
  });

  it('passes through other ApiError statuses with kind: other', async () => {
    captureFetch(jsonResponse(500, { error: 'boom' }));
    const result = await sendPatch(ref, { kind: 'confirmVerdict' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.kind).toBe('other');
    }
  });

  it('maps non-ApiError failures (network / fetch / programmer) to kind: network', async () => {
    // sendPatch never throws — non-ApiError failures land as a
    // discriminated SendPatchResult so callers can switch on .kind
    // without try/catch around the await. The auto-save flow's
    // `await inFlightCreate.current` and the discard handlers all
    // depend on this no-throw contract.
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.reject(new TypeError('network')),
      ) as unknown as typeof fetch;
    const result = await sendPatch(ref, { kind: 'confirmVerdict' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('network');
      expect(result.status).toBe(0);
      expect(result.body).toBe('network');
    }
  });

  it('treats create patch with missing assignedId field as malformed (kind: other)', async () => {
    // Backend contract for create patches is { assignedId: string }.
    // A 200 with missing key is a protocol violation — previously this
    // silently returned { ok: true, assignedId: null } and downstream
    // consumers received the wrong type.
    captureFetch(jsonResponse(200, {}));
    const result = await sendPatch(ref, {
      kind: 'newDraftComment',
      payload: SAMPLE_NEW_COMMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('other');
    }
  });

  it('treats create patch with non-string assignedId as malformed', async () => {
    captureFetch(jsonResponse(200, { assignedId: null }));
    const result = await sendPatch(ref, {
      kind: 'newDraftComment',
      payload: SAMPLE_NEW_COMMENT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('other');
    }
  });

  it('treats create patch with empty-string assignedId as malformed', async () => {
    captureFetch(jsonResponse(200, { assignedId: '' }));
    const result = await sendPatch(ref, {
      kind: 'newDraftComment',
      payload: SAMPLE_NEW_COMMENT,
    });
    expect(result.ok).toBe(false);
  });
});

describe('postReload', () => {
  it('POSTs { headSha } with X-PRism-Tab-Id header', async () => {
    const fetchMock = captureFetch(jsonResponse(200, {}));
    const result = await postReload(ref, 'a'.repeat(40));
    expect(result).toEqual({ ok: true });
    expect(lastUrl(fetchMock)).toBe(`${PR_PATH}/reload`);
    expect(lastInit(fetchMock).method).toBe('POST');
    expect(lastBodyJson(fetchMock)).toEqual({ headSha: 'a'.repeat(40) });
    const headers = new Headers(lastInit(fetchMock).headers);
    expect(headers.get('X-PRism-Tab-Id')).toBe(getTabId());
  });

  it('parses 409 reload-stale-head', async () => {
    captureFetch(jsonResponse(409, { error: 'reload-stale-head', currentHeadSha: 'b'.repeat(40) }));
    const result = await postReload(ref, 'a'.repeat(40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.kind).toBe('reload-stale-head');
    }
  });

  it('parses 409 reload-in-progress', async () => {
    captureFetch(jsonResponse(409, { error: 'reload-in-progress' }));
    const result = await postReload(ref, 'a'.repeat(40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.kind).toBe('reload-in-progress');
    }
  });

  it('falls back to conflict for unrecognized 409 bodies', async () => {
    captureFetch(jsonResponse(409, { error: 'something-else' }));
    const result = await postReload(ref, 'a'.repeat(40));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('conflict');
    }
  });
});

describe('getTabId', () => {
  it('returns the same uuid across calls within a launch', () => {
    const a = getTabId();
    const b = getTabId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('test seam allows fresh ids per test', () => {
    const a = getTabId();
    __resetTabIdForTest();
    const b = getTabId();
    expect(a).not.toBe(b);
  });
});

describe('exhaustiveness check', () => {
  it('throws on a synthetic unknown kind (compile-time guarantee plus runtime guard)', () => {
    // The compile-time `default: never` rejects this construction, but the
    // runtime branch still throws so a future shape mismatch via JSON.parse
    // (or `as ReviewSessionPatch` casts) doesn't silently no-op.
    const synthetic = { kind: 'neverShipped' } as unknown as ReviewSessionPatch;
    expect(() => serializePatch(synthetic)).toThrow(/Unhandled patch kind/);
  });
});

describe('ApiError plumbing', () => {
  it('ApiError instance check is the discriminator', () => {
    expect(new ApiError(404, null, { error: 'x' })).toBeInstanceOf(ApiError);
  });
});
