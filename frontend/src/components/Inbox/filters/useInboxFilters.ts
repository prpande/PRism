import { useCallback, useMemo, useState } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import {
  applyInboxFilters,
  isFilterActive,
  type InboxFilters,
  type SortKey,
} from './applyInboxFilters';

const EMPTY: InboxFilters = { text: '', ci: [], repos: [], authors: [] };

function distinct(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export function useInboxFilters(sections: InboxSection[], initialSort: SortKey) {
  const [filters, setFilters] = useState<InboxFilters>(EMPTY);
  const [sort, setSort] = useState<SortKey>(initialSort);

  // Facet value lists derive from the FULL snapshot (no cascading) — spec decision.
  const repoValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.repo))),
    [sections],
  );
  const authorValues = useMemo(
    () => distinct(sections.flatMap((s) => s.items.map((p) => p.author))),
    [sections],
  );

  const result = useMemo(
    () => applyInboxFilters(sections, filters, sort),
    [sections, filters, sort],
  );

  const setText = useCallback((text: string) => setFilters((f) => ({ ...f, text })), []);
  const toggleCi = useCallback(
    (v: CiStatus) => setFilters((f) => ({ ...f, ci: toggle(f.ci, v) })),
    [],
  );
  const toggleRepo = useCallback(
    (v: string) => setFilters((f) => ({ ...f, repos: toggle(f.repos, v) })),
    [],
  );
  const toggleAuthor = useCallback(
    (v: string) => setFilters((f) => ({ ...f, authors: toggle(f.authors, v) })),
    [],
  );
  const clear = useCallback(() => setFilters(EMPTY), []);

  return {
    filters,
    sort,
    setSort,
    setText,
    toggleCi,
    toggleRepo,
    toggleAuthor,
    clear,
    repoValues,
    authorValues,
    result,
    active: isFilterActive(filters),
  };
}
