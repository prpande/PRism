import { describe, it, expect } from 'vitest';
import {
  useCantEditRootBodyReason,
  type CantEditRootBodyReason,
} from './useCantEditRootBodyReason';
import type { ComposerOwnerKey } from './useDraftSession';

// useCantEditRootBodyReason is a pure function — no React context needed.
// Call it directly rather than via renderHook to keep tests lean.

function call(
  readOnly: boolean,
  ownerKey: ComposerOwnerKey,
  prRootHolder: ComposerOwnerKey | null,
): CantEditRootBodyReason {
  // useCantEditRootBodyReason is a pure function despite its `use*` name (see
  // header comment) — calling it directly here is safe. rules-of-hooks can't know
  // that from the name, so disable it for this one call. #331
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useCantEditRootBodyReason({ readOnly, ownerKey, prRootHolder });
}

describe('useCantEditRootBodyReason', () => {
  describe('readOnly gate', () => {
    it('returns editing-in-other-tab when readOnly is true, regardless of holder', () => {
      expect(call(true, 'reply-composer', null)).toBe('editing-in-other-tab');
      expect(call(true, 'reply-composer', 'reply-composer')).toBe('editing-in-other-tab');
      expect(call(true, 'files-tab', 'submit-dialog')).toBe('editing-in-other-tab');
    });
  });

  describe('no holder (prRootHolder === null)', () => {
    it('returns null — editing is permitted', () => {
      expect(call(false, 'reply-composer', null)).toBeNull();
      expect(call(false, 'submit-dialog', null)).toBeNull();
      expect(call(false, 'files-tab', null)).toBeNull();
      expect(call(false, 'drafts-tab', null)).toBeNull();
    });
  });

  describe('current composer is the holder (prRootHolder === ownerKey)', () => {
    it('returns null — the current surface is the one editing', () => {
      expect(call(false, 'reply-composer', 'reply-composer')).toBeNull();
      expect(call(false, 'submit-dialog', 'submit-dialog')).toBeNull();
      expect(call(false, 'files-tab', 'files-tab')).toBeNull();
      expect(call(false, 'drafts-tab', 'drafts-tab')).toBeNull();
    });
  });

  describe('reply-composer holds the draft, current is a different surface', () => {
    it('returns editing-in-overview-composer', () => {
      expect(call(false, 'submit-dialog', 'reply-composer')).toBe('editing-in-overview-composer');
      expect(call(false, 'files-tab', 'reply-composer')).toBe('editing-in-overview-composer');
      expect(call(false, 'drafts-tab', 'reply-composer')).toBe('editing-in-overview-composer');
    });
  });

  describe('submit-dialog holds the draft, current is a different surface', () => {
    it('returns editing-in-submit-dialog', () => {
      expect(call(false, 'reply-composer', 'submit-dialog')).toBe('editing-in-submit-dialog');
      expect(call(false, 'files-tab', 'submit-dialog')).toBe('editing-in-submit-dialog');
      expect(call(false, 'drafts-tab', 'submit-dialog')).toBe('editing-in-submit-dialog');
    });
  });

  describe('files-tab or drafts-tab holds the draft (inline-comment owner, not a PR-root surface)', () => {
    it('returns null — falls through; inline owners do not block PR-root editing by design', () => {
      // A files-tab/drafts-tab holder is an inline comment, not the PR-root.
      // The hook cannot return a meaningful reason for this case, so it falls
      // through to null. The PR-root body is not actually locked by an inline
      // composer — the caller should not wire getPrRootHolder() for inline ids.
      expect(call(false, 'reply-composer', 'files-tab')).toBeNull();
      expect(call(false, 'submit-dialog', 'drafts-tab')).toBeNull();
    });
  });
});
