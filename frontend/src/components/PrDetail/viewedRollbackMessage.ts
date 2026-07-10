import { ApiError } from '../../api/client';
import type { FileViewRollback } from '../../hooks/useFileViewState';

// Copy for the toast raised when a viewed-checkbox POST fails and the optimistic tick
// rolls back. A 409 means the head advanced under the mark, which a reload recovers, so it
// gets recovery-shaped copy instead of naming the file the user can no longer mark.
export function viewedRollbackMessage({ path, viewed, error }: FileViewRollback): string {
  if (error instanceof ApiError && error.status === 409) {
    return 'The PR has new commits — reload to update reviewed files.';
  }
  const name = path.split('/').pop() || path;
  return `Couldn't mark "${name}" as ${viewed ? 'reviewed' : 'not reviewed'}.`;
}
