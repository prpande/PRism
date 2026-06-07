import styles from './LoadingBar.module.css';

interface LoadingBarProps {
  active: boolean;
  'data-testid'?: string;
}

/**
 * Indeterminate progress bar pinned to the TOP of its containing element.
 *
 * Self-contained: an absolutely-positioned bar inside a zero-height relative
 * slot, so it overlays the container's top edge without shifting layout and
 * needs no positioned ancestor. Rendered PER SURFACE — each open PR tab (and,
 * later, the inbox) drops one at its own content boundary, rather than one
 * global bar pinned to the screen top. aria-hidden: the per-surface skeleton
 * carries the busy state for assistive tech, so this would be redundant noise.
 */
export function LoadingBar({ active, 'data-testid': testId = 'loading-bar' }: LoadingBarProps) {
  return (
    <div className={styles.slot} aria-hidden="true">
      <div className={styles.bar} data-active={active} data-testid={testId}>
        <div className={styles.fill} />
      </div>
    </div>
  );
}
