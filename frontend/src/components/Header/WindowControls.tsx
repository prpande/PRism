import { useEffect, useState } from 'react';
import styles from './WindowControls.module.css';

// Custom in-navbar window controls for the Electron desktop shell. macOS-style
// traffic-light dots, but positioned on the right (Windows order: minimize →
// maximize → close) and rendered identically on Windows AND macOS — the native
// OS controls are suppressed by the shell so the experience matches everywhere.
// Self-gating: in a plain browser tab `window.prism` is undefined and this
// renders nothing, so the web navbar is unaffected.
export function WindowControls() {
  const controls = typeof window !== 'undefined' ? window.prism?.windowControls : undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let active = true;
    void controls.isMaximized().then((m) => {
      if (active) setMaximized(m);
    });
    const unsubscribe = controls.onMaximizedChange((m) => setMaximized(m));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [controls]);

  if (!controls) return null;

  const maximizeLabel = maximized ? 'Restore' : 'Maximize';

  return (
    <div className={styles.controls} role="group" aria-label="Window controls">
      <button
        type="button"
        className={`${styles.dot} ${styles.minimize}`}
        onClick={() => controls.minimize()}
        aria-label="Minimize"
        title="Minimize"
      >
        <span className={styles.glyph} aria-hidden="true">
          &#x2212;
        </span>
      </button>
      <button
        type="button"
        className={`${styles.dot} ${styles.maximize}`}
        onClick={() => controls.toggleMaximize()}
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        <span className={styles.glyph} aria-hidden="true">
          {maximized ? '❐' : '↗'}
        </span>
      </button>
      <button
        type="button"
        className={`${styles.dot} ${styles.close}`}
        onClick={() => controls.close()}
        aria-label="Close"
        title="Close"
      >
        <span className={styles.glyph} aria-hidden="true">
          &#x2715;
        </span>
      </button>
    </div>
  );
}
