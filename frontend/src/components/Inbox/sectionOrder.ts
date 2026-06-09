import type { InboxSection } from '../../api/types';

// Single source of truth for the canonical inbox WORK-section order. recently-closed
// is NOT here — it is an archive, pinned to the bottom of the inbox and never part of
// the persisted/reorderable set (#275 spec, scope decision 2). Every consumer (the
// render-time sort, the Settings pane rows, the restore-default button) imports from
// here so the id list can never drift between layers.
export const CANONICAL_WORK_ORDER = [
  'review-requested',
  'awaiting-author',
  'authored-by-me',
  'mentioned',
] as const;

export type WorkSectionId = (typeof CANONICAL_WORK_ORDER)[number];

// The persisted default string (what config.json holds out of the box, what
// restore-default writes, and the disabled-when-equal comparison key).
export const CANONICAL_DEFAULT_ORDER_STRING = CANONICAL_WORK_ORDER.join(',');

const RECENTLY_CLOSED = 'recently-closed';

// Sentinel rank that forces a section to the very bottom of the inbox, below every
// work section. recently-closed (the archive) is the only id that gets it today.
const PINNED_LAST_RANK = Number.MAX_SAFE_INTEGER;

function parseSavedIds(savedOrder: string | undefined): string[] {
  return (savedOrder ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Render-time sort. Lenient by contract (strict-write / lenient-read, #275 spec):
// - sections in the saved order sort by their saved index;
// - a section NOT in the saved order sorts AFTER the listed ones, in canonical order
//   (so a future/new section is appended, never dropped — acceptance criterion #3);
// - a saved id matching no live section is harmlessly ignored;
// - recently-closed is ALWAYS forced last regardless of the saved/canonical order.
// Array.prototype.sort is stable (Node/V8), so equal-rank ties keep input order.
export function orderInboxSections(
  sections: InboxSection[],
  savedOrder: string | undefined,
): InboxSection[] {
  const saved = parseSavedIds(savedOrder);
  const rank = (id: string): number => {
    if (id === RECENTLY_CLOSED) return PINNED_LAST_RANK;
    const savedIndex = saved.indexOf(id);
    if (savedIndex >= 0) return savedIndex;
    const canonicalIndex = (CANONICAL_WORK_ORDER as readonly string[]).indexOf(id);
    return saved.length + (canonicalIndex >= 0 ? canonicalIndex : CANONICAL_WORK_ORDER.length);
  };
  return [...sections].sort((a, b) => rank(a.id) - rank(b.id));
}

// The four work-section ids in display order for the Settings pane. Guarantees exactly
// the four ids: valid saved ids first (in order, deduped), then any canonical id not yet
// present. Unknown / pinned ids in the saved string are dropped.
export function orderedWorkSectionIds(savedOrder: string | undefined): WorkSectionId[] {
  const seen = new Set<WorkSectionId>();
  const valid: WorkSectionId[] = [];
  for (const id of parseSavedIds(savedOrder)) {
    if ((CANONICAL_WORK_ORDER as readonly string[]).includes(id) && !seen.has(id as WorkSectionId)) {
      const wid = id as WorkSectionId;
      seen.add(wid);
      valid.push(wid);
    }
  }
  return [...valid, ...CANONICAL_WORK_ORDER.filter((id) => !seen.has(id))];
}
