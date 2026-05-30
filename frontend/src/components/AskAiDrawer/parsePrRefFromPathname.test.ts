import { describe, expect, it } from 'vitest';
import { parsePrRefFromPathname } from './parsePrRefFromPathname';

describe('parsePrRefFromPathname', () => {
  it('parses /pr/owner/repo/123 into { owner, repo, number: 123 }', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('parses /pr/owner/repo/123/files (sub-route)', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123/files')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('parses /pr/owner/repo/123/drafts', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/123/drafts')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 123,
    });
  });

  it('returns null for /', () => {
    expect(parsePrRefFromPathname('/')).toBeNull();
  });

  it('returns null for /setup', () => {
    expect(parsePrRefFromPathname('/setup')).toBeNull();
  });

  it('returns null for /settings', () => {
    expect(parsePrRefFromPathname('/settings')).toBeNull();
  });

  it('returns null for /pr (no segments)', () => {
    expect(parsePrRefFromPathname('/pr')).toBeNull();
  });

  it('returns null for /pr/acme (only owner)', () => {
    expect(parsePrRefFromPathname('/pr/acme')).toBeNull();
  });

  it('returns null for /pr/acme/api/abc (non-numeric number)', () => {
    expect(parsePrRefFromPathname('/pr/acme/api/abc')).toBeNull();
  });

  it('parses /pr/owner-with-dashes/repo.with.dots/42', () => {
    expect(parsePrRefFromPathname('/pr/owner-with-dashes/repo.with.dots/42')).toEqual({
      owner: 'owner-with-dashes',
      repo: 'repo.with.dots',
      number: 42,
    });
  });
});
