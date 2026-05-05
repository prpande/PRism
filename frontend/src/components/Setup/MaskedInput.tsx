import { useState, type ChangeEvent } from 'react';

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
    <div style={{ position: 'relative' }}>
      <input
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? 'Hide token' : 'Show token'}
      >
        {shown ? '👁' : '👁'}
      </button>
    </div>
  );
}
