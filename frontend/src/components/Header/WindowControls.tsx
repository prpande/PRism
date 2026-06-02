import { useEffect, useState } from 'react';
import styles from './WindowControls.module.css';

// Glyphs are inline SVG (stroke = currentColor) rather than Unicode dingbats:
// the maximize/restore code points (e.g. ❐, ↗) render inconsistently across OS
// font stacks — notably Windows — so SVG guarantees pixel-identical icons on
// every platform and a consistent stroke weight.
const ICON = { width: 8, height: 8, viewBox: '0 0 10 10', fill: 'none' } as const;
const STROKE = {
  stroke: 'currentColor',
  strokeWidth: 1.3,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

const MinimizeIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <line x1="2" y1="5" x2="8" y2="5" {...STROKE} />
  </svg>
);
const MaximizeIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <rect x="2" y="2" width="6" height="6" {...STROKE} />
  </svg>
);
const RestoreIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <rect x="2" y="3.5" width="4.5" height="4.5" {...STROKE} />
    <path d="M3.8 3.5 V2 H8 V6.2 H6.5" {...STROKE} />
  </svg>
);
const CloseIcon = () => (
  <svg {...ICON} aria-hidden="true">
    <path d="M2.5 2.5 L7.5 7.5 M7.5 2.5 L2.5 7.5" {...STROKE} />
  </svg>
);

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
    // isMaximized() can reject if the renderer/IPC channel tears down (e.g. during
    // shutdown). Swallow it so it never surfaces as an unhandled rejection.
    controls
      .isMaximized()
      .then((m) => {
        if (active) setMaximized(m);
      })
      .catch(() => {
        /* window closing — ignore */
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
          <MinimizeIcon />
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
          {maximized ? <RestoreIcon /> : <MaximizeIcon />}
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
          <CloseIcon />
        </span>
      </button>
    </div>
  );
}
