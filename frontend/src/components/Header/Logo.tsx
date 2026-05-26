import styles from './Logo.module.css';

export function Logo() {
  return (
    <img
      src="/prism-logo.png"
      alt="PRism"
      width={28}
      height={28}
      className={styles.logo}
    />
  );
}
