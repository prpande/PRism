import { useCallback, useMemo, useState } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import {
  applyInboxFilters,
  isFilterActive,
  looksLikePrUrl,
  type InboxFilters,
  type SortKey,
} from './applyInboxFilters';

const EMPTY_FACETS: Omit<InboxFilters, 'text'> = { ci: [], repos: [], authors: [] };

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function useInboxFilters(sections: InboxSection[], initialSort: SortKey) {
  // The merged inbox input is a single text field doing double duty (filter / open).
  // We hold its RAW value in `query`; the EFFECTIVE text filter strips out a
  // URL-shaped value so a pasted PR URL never filters the inbox to empty (no
  // zero-state flash) — it just sits in the box with the "open" affordance.
  const [query, setQuery] = useState('');
  const [facets, setFacets] = useState<Omit<InboxFilters, 'text'>>(EMPTY_FACETS);
  const [sort, setSort] = useState<SortKey>(initialSort);

  const effectiveText = looksLikePrUrl(query) ? '' : query;
  const filters = useMemo<InboxFilters>(
    () => ({ text: effectiveText, ...facets }),
    [effectiveText, facets],
  );

  // Facet value lists derive from the FULL snapshot (no cascading) — spec decision.
  const repoValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.repo))),
    [sections],
  );
  const authorValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.author))),
    [sections],
  );

  // MUST stay memoized: FilterBar reports `result` up via a useEffect; a fresh object each render would loop (setFilterState → re-render → new result → effect → …).
  const result = useMemo(
    () => applyInboxFilters(sections, filters, sort),
    [sections, filters, sort],
  );

  // No debounce: filtering is a synchronous pass over the in-memory snapshot (no network), so per-keystroke is cheap and instant feels better than a 120ms lag.
  const toggleCi = useCallback(
    (v: CiStatus) => setFacets((f) => ({ ...f, ci: toggle(f.ci, v) })),
    [],
  );
  const toggleRepo = useCallback(
    (v: string) => setFacets((f) => ({ ...f, repos: toggle(f.repos, v) })),
    [],
  );
  const toggleAuthor = useCallback(
    (v: string) => setFacets((f) => ({ ...f, authors: toggle(f.authors, v) })),
    [],
  );
  const clear = useCallback(() => {
    setQuery('');
    setFacets(EMPTY_FACETS);
  }, []);

  return {
    filters,
    query,
    setQuery,
    sort,
    setSort,
    toggleCi,
    toggleRepo,
    toggleAuthor,
    clear,
    repoValues,
    authorValues,
    result,
    // `active`/filterCount treat a URL in the box as NO active text filter, because
    // the effective text is '' — the inbox is unfiltered, just showing the URL.
    active: isFilterActive(filters),
  };
}
