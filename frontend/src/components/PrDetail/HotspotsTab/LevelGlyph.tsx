import type { FocusLevel } from '../../../api/types';
import styles from './HotspotsTab.module.css';

// Signal-bars severity glyph (#520, D6): the active-bar COUNT and the hue both
// encode level, so level is never conveyed by color alone (WCAG 1.4.1). Purely
// decorative — the row (and the Low footer copy) provide the accessible text.
const ACTIVE_BARS: Record<FocusLevel, number> = { high: 3, medium: 2, low: 1 };

const BARS = [
  { x: 0, y: 10, h: 6 },
  { x: 7, y: 5, h: 11 },
  { x: 14, y: 0, h: 16 },
];

export function LevelGlyph({ level }: { level: FocusLevel }) {
  const active = ACTIVE_BARS[level];
  return (
    <svg
      className={styles.glyph}
      data-level={level}
      width="16"
      height="14"
      viewBox="0 0 18 16"
      aria-hidden="true"
      focusable="false"
    >
      {BARS.map((bar, i) => {
        const isActive = i < active;
        return (
          <rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width="4"
            height={bar.h}
            rx="1"
            data-active={isActive}
            className={isActive ? styles.barActive : styles.barInactive}
          />
        );
      })}
    </svg>
  );
}
