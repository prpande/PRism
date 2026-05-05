interface Props {
  scope: string;
}

export function ScopePill({ scope }: Props) {
  const copy = () => {
    void navigator.clipboard.writeText(scope);
  };
  return (
    <span>
      <code>{scope}</code>
      <button type="button" onClick={copy} aria-label={`Copy ${scope}`}>
        copy
      </button>
    </span>
  );
}
