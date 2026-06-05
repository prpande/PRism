import { useState } from 'react';
import styles from './Avatar.module.css';

const SIZE_CLASS: Record<'sm' | 'md' | 'lg', string> = {
  sm: 'avatar-sm',
  md: '',
  lg: 'avatar-lg',
};

export interface AvatarProps {
  src?: string | null;
  login: string;
  size?: 'sm' | 'md' | 'lg';
}

function initial(login: string): string {
  // Strip a trailing [bot] suffix so bot logins initial on their name, not the bracket.
  const base = login.replace(/\[bot\]$/i, '');
  return base.charAt(0).toUpperCase();
}

export function Avatar({ src, login, size = 'md' }: AvatarProps) {
  // Error state is scoped to the CURRENT src, not the component lifetime: instances
  // are reused across inbox refresh ticks, so a lifetime-wide flag would pin a row to
  // initials forever after one transient blip. A new src re-attempts the load.
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const showImg = !!src && src.startsWith('https://') && erroredSrc !== src;
  // filter(Boolean) drops the empty md class so there's no double space (md has no
  // size-suffix class — the base `avatar` token is the 24px default).
  const className = ['avatar', SIZE_CLASS[size], styles.avatar].filter(Boolean).join(' ');

  return (
    <span className={className} aria-hidden="true" title={login || undefined} data-testid="avatar">
      <span className={styles.initial}>{initial(login)}</span>
      {showImg && (
        <img
          key={src}
          className={styles.img}
          src={src}
          alt=""
          loading={size === 'sm' ? 'lazy' : 'eager'}
          referrerPolicy="no-referrer"
          onError={() => setErroredSrc(src)}
        />
      )}
    </span>
  );
}
