import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getEgressDisclosure, postAiConsent } from './aiConsent';
import type { EgressDisclosure } from './aiConsent';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn<(path: string) => Promise<EgressDisclosure>>(),
  postMock: vi.fn<(path: string, body?: unknown) => Promise<void>>(),
}));

vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return { ...actual, apiClient: { get: getMock, post: postMock } };
});

describe('aiConsent api', () => {
  beforeEach(() => vi.clearAllMocks());

  it('gets disclosure', async () => {
    getMock.mockResolvedValue({
      recipient: 'A',
      dataCategories: ['x'],
      disclosureVersion: '1',
      alreadyConsented: false,
    });
    expect((await getEgressDisclosure()).disclosureVersion).toBe('1');
  });

  it('posts consent', async () => {
    postMock.mockResolvedValue(undefined);
    await postAiConsent('1');
    expect(postMock).toHaveBeenCalledWith('/api/ai/consent', { disclosureVersion: '1' });
  });
});
