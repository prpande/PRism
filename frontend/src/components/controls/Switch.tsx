import styles from './Switch.module.css';

export interface SwitchProps {
  id: string;
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  describedById?: string;
  disabled?: boolean;
}

// Styled restyle of the existing role="switch" checkbox. Keeps a real checkbox
// input for native keyboard/AT behavior; CSS paints the track + thumb. The
// visible label is supplied by the caller's row, so the input itself carries an
// aria-label to stay self-describing in tests and AT.
export function Switch({ id, checked, label, onChange, describedById, disabled }: SwitchProps) {
  return (
    <input
      id={id}
      type="checkbox"
      role="switch"
      className={styles.switch}
      aria-label={label}
      aria-describedby={describedById}
      checked={checked}
      disabled={disabled}
      onChange={(e) => onChange(e.target.checked)}
    />
  );
}
