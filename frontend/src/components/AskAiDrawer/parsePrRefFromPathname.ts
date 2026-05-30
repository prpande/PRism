import type { PrReference } from '../../api/types';

/**
 * Parse the leading /pr/:owner/:repo/:number segments from a pathname.
 *
 * Returns null when the pathname does not match a PR Detail route. Used at App level
 * (where useParams() returns empty) to derive the current PR ref from useLocation().pathname.
 */
export function parsePrRefFromPathname(pathname: string): PrReference | null {
  const m = /^\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/.*)?$/.exec(pathname);
  if (!m) return null;
  return {
    owner: m[1],
    repo: m[2],
    number: parseInt(m[3], 10),
  };
}
