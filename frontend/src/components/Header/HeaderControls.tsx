import { useEffect } from 'react';
import { usePreferences } from '../../hooks/usePreferences';
import { useCapabilities } from '../../hooks/useCapabilities';
import { ThemeToggle } from './ThemeToggle';
import { AccentPicker } from './AccentPicker';
import { AiPreviewToggle } from './AiPreviewToggle';
import { applyThemeToDocument } from '../../utils/applyTheme';
import styles from './HeaderControls.module.css';
import type { Theme, Accent } from '../../api/types';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'] as const;
const ACCENTS: readonly Accent[] = ['indigo', 'amber', 'teal'] as const;

export function HeaderControls() {
  const { preferences, set } = usePreferences();
  const { refetch: refetchCapabilities } = useCapabilities();

  useEffect(() => {
    if (preferences) applyThemeToDocument(preferences.ui.theme, preferences.ui.accent);
  }, [preferences]);

  if (!preferences) return null;

  // Spec § 2.4 widened GET /api/preferences to a nested shape; the legacy bare
  // `theme`/`accent`/`aiPreview` POST keys still work via the back-compat path in
  // ConfigStore.PatchAsync's allowlist, so `set('theme', next)` keeps functioning.
  // Each picker also calls applyThemeToDocument() directly so the visible UI
  // updates without waiting on the POST response or a focus-driven refetch.
  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(preferences.ui.theme) + 1) % THEMES.length];
    applyThemeToDocument(next, preferences.ui.accent);
    void set('theme', next);
  };
  const cycleAccent = () => {
    const next = ACCENTS[(ACCENTS.indexOf(preferences.ui.accent) + 1) % ACCENTS.length];
    applyThemeToDocument(preferences.ui.theme, next);
    void set('accent', next);
  };
  // Capabilities mirror the same AiPreviewState the preference drives. Refetch
  // immediately after the preference flip so consumers (Overview's
  // AiSummaryCard, Inbox enrichment, etc.) see the new flag without waiting
  // for a window-focus event. Fire-and-forget — the refetch is idempotent and
  // the hook handles its own error state.
  const toggleAi = async () => {
    await set('aiPreview', !preferences.ui.aiPreview);
    void refetchCapabilities();
  };

  return (
    <div className={styles.cluster}>
      <ThemeToggle theme={preferences.ui.theme} onClick={cycleTheme} />
      <AccentPicker accent={preferences.ui.accent} onClick={cycleAccent} />
      <AiPreviewToggle on={preferences.ui.aiPreview} onClick={toggleAi} />
    </div>
  );
}
