import { useState, type ChangeEvent } from 'react';
import styles from './MaskedInput.module.css';

interface Props {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  ariaLabel: string;
}

export function MaskedInput({ id, value, onChange, placeholder, ariaLabel }: Props) {
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
