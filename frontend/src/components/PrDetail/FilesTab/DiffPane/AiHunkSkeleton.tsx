import { AiMarker } from '../../../Ai/AiMarker';
import { Skeleton } from '../../../Skeleton/Skeleton';
import styles from './AiHunkAnnotation.module.css';

// Loading placeholder for in-flight hunk annotations (#508). Mirrors the .ai-hunk
// shape so the resolved annotation cross-fades into the same footprint. The working
// AiMarker (hue + reduced-motion-safe pulse) signals "AI is reviewing this file".
export function AiHunkSkeleton() {
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk-skeleton" aria-busy="true">
      <AiMarker variant="inline" state="working" decorative />
      <div className={styles.aiHunkBody}>
        <span className="sr-only" aria-live="polite">
          AI is reviewing this file…
        </span>
        <Skeleton height={12} width="40%" />
        <Skeleton height={12} width="90%" />
      </div>
    </div>
  );
}
