import type { Theme } from '../../api/types';

interface Props {
  theme: Theme;
  onClick: () => void;
}

export function ThemeToggle({ theme, onClick }: Props) {
  const label = `Theme (${theme})`;
  const symbol = theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';
  return (
    <button type="button" aria-label={label} onClick={onClick}>
      {symbol}
    </button>
  );
}
