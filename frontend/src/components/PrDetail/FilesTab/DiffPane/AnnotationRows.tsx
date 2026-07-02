import type { HunkAnnotation } from '../../../../api/types';
import { AiHunkAnnotation } from './AiHunkAnnotation';
import styles from './DiffPane.module.css';

// Builds the full-width AI-annotation rows emitted after a hunk header (hunks
// mode) or before the first line of a hunk (whole-file mode). One shared
// builder for the four emit sites in the unified/split row loops; the caller
// keeps today's exact key scheme via keyPrefix (`ann-${idx}`) so React
// reconciliation keys are unchanged.
export function annotationRows({
  annotations,
  colSpan,
  keyPrefix,
}: {
  annotations: readonly HunkAnnotation[];
  colSpan: number;
  keyPrefix: string;
}): React.ReactElement[] {
  return annotations.map((a, aidx) => (
    <tr key={`${keyPrefix}-${aidx}`} className={styles.aiHunkRow}>
      <td colSpan={colSpan}>
        <AiHunkAnnotation annotation={a} />
      </td>
    </tr>
  ));
}
