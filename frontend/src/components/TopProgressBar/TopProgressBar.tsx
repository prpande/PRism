import { useLoadingBar } from '../../contexts/LoadingBarContext';
import styles from './TopProgressBar.module.css';

/**
 * Global indeterminate progress bar pinned to the top of the viewport. Visible
 * while any LoadingBar source is active; CSS opacity transition handles the
 * fade-out on idle. aria-hidden — the per-surface skeletons carry the busy state
 * for assistive tech, so this would be redundant noise.
 */
export function TopProgressBar() {
  const { active } = useLoadingBar();
  return (
    <div
      className={styles.bar}
      data-active={active}
      aria-hidden="true"
      data-testid="top-progress-bar"
    >
      <div className={styles.fill} />
    </div>
  );
}
