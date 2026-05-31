import { usePreferences } from '../../hooks/usePreferences';
import { useCapabilities } from '../../hooks/useCapabilities';
import { applyThemeToDocument, applyDensityToDocument } from '../../utils/applyTheme';
import type { Accent, Density, Theme } from '../../api/types';
import styles from './SettingsSections.module.css';

const THEMES: readonly Theme[] = ['system', 'light', 'dark'] as const;
const ACCENTS: readonly { value: Accent; label: string }[] = [
  { value: 'indigo', label: 'Indigo' },
  { value: 'amber', label: 'Amber' },
  { value: 'teal', label: 'Teal' },
];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'] as const;

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
  // visible immediately regardless of which picker the user touched. If the
  // POST rejects, usePreferences rolls back its state and shows an error
  // toast; we ALSO re-apply the original theme/accent to the DOM so the
  // visible UI matches the rolled-back state (otherwise the toast says
  // "reverted" but dark mode stays on).
  const onTheme = (value: Theme) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(value, priorAccent);
    void set('theme', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  const onAccent = (value: Accent) => {
    const priorTheme = preferences.ui.theme;
    const priorAccent = preferences.ui.accent;
    applyThemeToDocument(priorTheme, value);
    void set('accent', value).catch(() => applyThemeToDocument(priorTheme, priorAccent));
  };
  // PR9b-density: same key-scoped optimistic apply + on-failure rollback pattern
  // as onTheme/onAccent. applyDensityToDocument is a no-op write of `data-density`
  // on <html>, so the rollback path simply re-applies the prior value.
  const onDensity = (value: Density) => {
    const priorDensity = preferences.ui.density;
    applyDensityToDocument(value);
    void set('density', value).catch(() => applyDensityToDocument(priorDensity));
  };
  const onAiToggle = (next: boolean) => {
    // usePreferences.set rethrows on POST failure (after the rollback +
    // error toast). Catch here so the React onChange handler's void-prefix
    // doesn't surface as an unhandled promise rejection in the browser.
    set('aiPreview', next)
      .then(() => refetchCapabilities())
      .catch(() => {
        /* toast + rollback already happened in usePreferences */
      });
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
        <label htmlFor="appearance-density">Density</label>
        <select
          id="appearance-density"
          value={preferences.ui.density}
          onChange={(e) => onDensity(e.target.value as Density)}
        >
          {DENSITIES.map((d) => (
            <option key={d} value={d}>
              {d.charAt(0).toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.row}>
        <label htmlFor="appearance-ai-preview">AI preview</label>
        <input
          id="appearance-ai-preview"
          type="checkbox"
          role="switch"
          checked={preferences.ui.aiPreview}
          onChange={(e) => onAiToggle(e.target.checked)}
        />
      </div>
    </section>
  );
}
