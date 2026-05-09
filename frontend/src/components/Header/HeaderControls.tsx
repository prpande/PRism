import { useEffect } from 'react';
import { usePreferences } from '../../hooks/usePreferences';
import { useCapabilities } from '../../hooks/useCapabilities';
import { ThemeToggle } from './ThemeToggle';
import { AccentPicker } from './AccentPicker';
import { AiPreviewToggle } from './AiPreviewToggle';
import styles from './HeaderControls.module.css';
import type { Theme, Accent } from '../../api/types';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'] as const;
const ACCENTS: readonly Accent[] = ['indigo', 'amber', 'teal'] as const;
const ACCENT_HUES: Record<Accent, { h: number; c: number }> = {
  indigo: { h: 245, c: 0.085 },
  amber: { h: 75, c: 0.1 },
  teal: { h: 195, c: 0.075 },
};

function applyToDocument(theme: Theme, accent: Accent) {
  if (typeof document === 'undefined') return;
  const resolved =
    theme === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  document.documentElement.dataset.theme = resolved;
  const hue = ACCENT_HUES[accent];
  document.documentElement.style.setProperty('--accent-h', String(hue.h));
  document.documentElement.style.setProperty('--accent-c', String(hue.c));
}

export function HeaderControls() {
  const { preferences, set } = usePreferences();
  const { refetch: refetchCapabilities } = useCapabilities();

  useEffect(() => {
    if (preferences) applyToDocument(preferences.theme, preferences.accent);
  }, [preferences]);

  if (!preferences) return null;

  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(preferences.theme) + 1) % THEMES.length];
    void set('theme', next);
  };
  const cycleAccent = () => {
    const next = ACCENTS[(ACCENTS.indexOf(preferences.accent) + 1) % ACCENTS.length];
    void set('accent', next);
  };
  // Capabilities mirror the same AiPreviewState the preference drives. Refetch
  // immediately after the preference flip so consumers (Overview's
  // AiSummaryCard, Inbox enrichment, etc.) see the new flag without waiting
  // for a window-focus event. Fire-and-forget — the refetch is idempotent and
  // the hook handles its own error state.
  const toggleAi = async () => {
    await set('aiPreview', !preferences.aiPreview);
    void refetchCapabilities();
  };

  return (
    <div className={styles.cluster}>
      <ThemeToggle theme={preferences.theme} onClick={cycleTheme} />
      <AccentPicker accent={preferences.accent} onClick={cycleAccent} />
      <AiPreviewToggle on={preferences.aiPreview} onClick={toggleAi} />
    </div>
  );
}
