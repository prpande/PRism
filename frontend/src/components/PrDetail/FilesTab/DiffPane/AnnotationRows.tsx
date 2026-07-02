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

// Whole-file mode: the annotation rows queued to render before row `idx`
// (see DiffPane's annotationsByRowIdx re-anchoring map). Returns [] when the
// map is null or has no entry, keeping the callers' guard-free spread; the
// `ann-${idx}` key scheme matches the hunk-mode emit sites.
export function preLineAnnotationRows(
  annotationsByRowIdx: Map<number, HunkAnnotation[]> | null,
  idx: number,
  colSpan: number,
): React.ReactElement[] {
  const annotations = annotationsByRowIdx?.get(idx);
  if (!annotations) return [];
  return annotationRows({ annotations, colSpan, keyPrefix: `ann-${idx}` });
}

// Hunks mode: the annotation rows for hunk `hunkIdx`, emitted after its
// hunk-header row at `rowIdx`. Lookup key (hunk index) and React key prefix
// (row index) intentionally differ — the key scheme stays `ann-${rowIdx}`
// like every other emit site. Returns [] when the map is null or has no entry.
export function hunkAnnotationRows(
  annotationsForFile: Map<number, HunkAnnotation[]> | null,
  hunkIdx: number,
  rowIdx: number,
  colSpan: number,
): React.ReactElement[] {
  const annotations = annotationsForFile?.get(hunkIdx);
  if (!annotations) return [];
  return annotationRows({ annotations, colSpan, keyPrefix: `ann-${rowIdx}` });
}
