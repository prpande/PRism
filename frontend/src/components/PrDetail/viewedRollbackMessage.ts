import { ApiError } from '../../api/client';
import type { FileViewRollback } from '../../hooks/useFileViewState';

function problemType(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body;
  if (typeof body !== 'object' || body === null) return null;
  const type = (body as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

// Matched on the problem `type`, not the bare 409: stale-head-sha is the only 409 this route
// returns today, and keying recovery copy on that coincidence would silently mislabel the next
// 409 reason someone adds. A head that advanced under the mark is recovered by a reload, so it
// gets recovery-shaped copy instead of naming the file the user can no longer mark.
export function viewedRollbackMessage({ path, viewed, error }: FileViewRollback): string {
  if (problemType(error) === '/viewed/stale-head-sha') {
    return 'The PR has new commits — reload to update reviewed files.';
  }
  const name = path.split('/').pop() || path;
  return `Couldn't mark "${name}" as ${viewed ? 'reviewed' : 'not reviewed'}.`;
}
