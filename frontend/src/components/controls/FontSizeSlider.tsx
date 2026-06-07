import type { ContentScale } from '../../api/types';
import styles from './FontSizeSlider.module.css';

// Single ordered source of truth for both directions of the index↔enum mapping.
// Index 0–4; 'm' (Default) sits at the center, index 2.
const SCALE_ORDER = ['xs', 's', 'm', 'l', 'xl'] as const;
const STEP_NAMES: Record<ContentScale, string> = {
  xs: 'Extra small',
  s: 'Small',
  m: 'Default',
  l: 'Large',
  xl: 'Extra large',
};

export interface FontSizeSliderProps {
  value: ContentScale;
  onChange: (value: ContentScale) => void;
}

export function FontSizeSlider({ value, onChange }: FontSizeSliderProps) {
  // Math.max(0, …) keeps the slider reachable if an out-of-enum value is persisted.
  const index = Math.max(0, (SCALE_ORDER as readonly string[]).indexOf(value));
  return (
    <div className={styles.wrap}>
      <input
        type="range"
        min={0}
        max={SCALE_ORDER.length - 1}
        step={1}
        value={index}
        aria-label="Content font size"
        aria-valuetext={STEP_NAMES[SCALE_ORDER[index]]}
        className={styles.range}
        onChange={(e) => onChange(SCALE_ORDER[Number(e.target.value)])}
      />
      {/* Visual size legend: five "a" glyphs growing left→right. Decorative
          (aria-hidden) — the slider's aria-valuetext carries the accessible value. */}
      <div className={styles.ticks} aria-hidden="true">
        {SCALE_ORDER.map((step, i) => (
          <span key={step} className={styles.tick} style={{ fontSize: `${0.7 + i * 0.18}rem` }}>
            a
          </span>
        ))}
      </div>
    </div>
  );
}
