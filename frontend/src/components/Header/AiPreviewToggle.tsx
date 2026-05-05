interface Props {
  on: boolean;
  onClick: () => void;
}

export function AiPreviewToggle({ on, onClick }: Props) {
  return (
    <button
      type="button"
      aria-label={`AI preview ${on ? 'on' : 'off'}`}
      aria-pressed={on}
      onClick={onClick}
    >
      ✦
    </button>
  );
}
