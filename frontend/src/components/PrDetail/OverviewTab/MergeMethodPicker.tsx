import type { Ref } from 'react';
import type { AllowedMergeMethods } from '../../../api/types';
import type { MergeMethodWire } from '../../../api/prLifecycle';
import styles from './PrActionsPanel.module.css';

const ORDER: MergeMethodWire[] = ['merge', 'squash', 'rebase'];
const LABEL: Record<MergeMethodWire, string> = {
  merge: 'Merge commit',
  squash: 'Squash',
  rebase: 'Rebase',
};

export function allowedList(a: AllowedMergeMethods): MergeMethodWire[] {
  const list = ORDER.filter((m) => a[m]);
  return list.length > 0 ? list : [...ORDER]; // none flagged → offer all (server is authority via 405)
}
export function firstAllowed(a: AllowedMergeMethods): MergeMethodWire {
  return allowedList(a)[0];
}

interface Props {
  allowed: AllowedMergeMethods;
  value: MergeMethodWire;
  onChange: (m: MergeMethodWire) => void;
  disabled?: boolean;
  onEscape?: () => void;
  rootRef?: Ref<HTMLDivElement>;
}

export function MergeMethodPicker({
  allowed,
  value,
  onChange,
  disabled,
  onEscape,
  rootRef,
}: Props) {
  const list = allowedList(allowed);
  if (list.length <= 1) return null; // single method → conveyed by the Confirm button label

  const move = (dir: 1 | -1) => {
    const i = list.indexOf(value);
    const next = list[(i + dir + list.length) % list.length];
    onChange(next);
  };

  return (
    <div
      ref={rootRef}
      role="radiogroup"
      aria-label="Merge method"
      className={styles.methodPicker}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onEscape?.();
          return;
        }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {list.map((m) => {
        const selected = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`${styles.methodOption} ${selected ? styles.methodOptionSelected : ''}`}
            onClick={() => onChange(m)}
          >
            {LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
