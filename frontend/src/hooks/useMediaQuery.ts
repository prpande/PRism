import { useEffect, useState } from 'react';

// Reactive `window.matchMedia(query).matches`. SSR-safe (returns false when
// `window` / `matchMedia` is unavailable) and tolerant of the legacy
// addListener/removeListener API. Used by the closed/merged bulk-discard button
// to shorten its label below the spec § 8.5 600px breakpoint.
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    // Legacy Safari < 14.
    if (typeof mql.addListener === 'function') {
      mql.addListener(onChange);
      return () => mql.removeListener(onChange);
    }
    return undefined;
  }, [query]);

  return matches;
}
