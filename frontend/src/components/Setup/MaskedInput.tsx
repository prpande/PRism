import { useState, type ChangeEvent } from 'react';
import styles from './MaskedInput.module.css';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
  hasError?: boolean;
  // Id of the error element to associate when hasError is true (WCAG 1.3.1 /
  // 3.3.1 — programmatic link between the field and its error text). (#213)
  errorId?: string;
}

export function MaskedInput({
  id,
  value,
  onChange,
  placeholder,
  ariaLabel,
  hasError,
  errorId,
}: Props) {
  const [shown, setShown] = useState(false);
  return (
    <div className={styles.wrap}>
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={hasError || undefined}
        aria-describedby={hasError && errorId ? errorId : undefined}
        className={styles.input}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide token' : 'Show token'}
        className={`${styles.eye} btn-icon`}
      >
        {shown ? '🙈' : '👁'}
      </button>
    </div>
  );
}
