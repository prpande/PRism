import type { Accent } from '../../api/types';

interface Props {
  accent: Accent;
  onClick: () => void;
}

export function AccentPicker({ accent, onClick }: Props) {
  return (
    <button type="button" aria-label={`Accent (${accent})`} onClick={onClick}>
      ●
    </button>
  );
}
