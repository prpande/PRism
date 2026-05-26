import { usePreferences } from '../../hooks/usePreferences';
import { useCapabilities } from '../../hooks/useCapabilities';
import { applyThemeToDocument } from '../../utils/applyTheme';
import type { Accent, Theme } from '../../api/types';
import styles from './SettingsSections.module.css';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'] as const;
const ACCENTS: readonly { value: Accent; label: string }[] = [
  { value: 'indigo', label: 'Indigo' },
  { value: 'amber', label: 'Amber' },
  { value: 'teal', label: 'Teal' },
];

// Spec § 2.4 + 2026-05-25 Plan-resync: every input uses an explicit
// `<label htmlFor="…"><input id="…">` association so the PR7 a11y audit
// has nothing to fix here. The radio group uses a `<fieldset><legend>`
// to group the three accent radios under a single semantic label.
export function AppearanceSection() {
  const { preferences, set } = usePreferences();
  const { refetch: refetchCapabilities } = useCapabilities();
  if (!preferences) return null;

  // usePreferences() in HeaderControls and here are independent useState
  // instances — updating one won't notify the other until the next focus
  // refetch. Apply directly to documentElement so the chosen theme/accent is
  // visible immediately regardless of which picker the user touched.
  const onTheme = (value: Theme) => {
    applyThemeToDocument(value, preferences.ui.accent);
    void set('theme', value);
  };
  const onAccent = (value: Accent) => {
    applyThemeToDocument(preferences.ui.theme, value);
    void set('accent', value);
  };
  const onAiToggle = async (next: boolean) => {
    await set('aiPreview', next);
    void refetchCapabilities();
  };

  return (
    <section aria-labelledby="appearance-heading" className={styles.section}>
      <h2 id="appearance-heading">Appearance</h2>

      <div className={styles.row}>
        <label htmlFor="appearance-theme">Theme</label>
        <select
          id="appearance-theme"
          value={preferences.ui.theme}
          onChange={(e) => onTheme(e.target.value as Theme)}
        >
          {THEMES.map((t) => (
            <option key={t} value={t}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <fieldset className={styles.row}>
        <legend>Accent</legend>
        {ACCENTS.map(({ value, label }) => (
          <label key={value} className={styles.radioLabel}>
            <input
              type="radio"
              name="appearance-accent"
              value={value}
              checked={preferences.ui.accent === value}
              onChange={() => onAccent(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>

      <div className={styles.row}>
        <label htmlFor="appearance-ai-preview">AI preview</label>
        <input
          id="appearance-ai-preview"
          type="checkbox"
          role="switch"
          checked={preferences.ui.aiPreview}
          onChange={(e) => void onAiToggle(e.target.checked)}
        />
      </div>
    </section>
  );
}
