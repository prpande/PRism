import { usePreferences } from '../../../hooks/usePreferences';
import { applyThemeToDocument, applyDensityToDocument } from '../../../utils/applyTheme';
import type { Accent, Density, Theme } from '../../../api/types';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { AccentSwatches } from '../../controls/AccentSwatches';
import pane from './Pane.module.css';

const THEMES = [
  { value: 'system' as Theme, label: 'System' },
  { value: 'dark' as Theme, label: 'Dark' },
  { value: 'light' as Theme, label: 'Light' },
];
const DENSITIES = [
  { value: 'comfortable' as Density, label: 'Comfortable' },
  { value: 'compact' as Density, label: 'Compact' },
];

export function AppearancePane() {
  const { preferences, set } = usePreferences();
  if (!preferences) return null;

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
  const density: Density = DENSITIES.some((d) => d.value === preferences.ui.density)
    ? preferences.ui.density
    : 'comfortable';
  const onDensity = (value: Density) => {
    applyDensityToDocument(value);
    void set('density', value).catch(() => applyDensityToDocument(density));
  };
  // A `live` config (not user-selectable in P0) is shown as Preview-selected.
  const aiModeShown: 'off' | 'preview' =
    preferences.ui.aiMode === 'live' ? 'preview' : preferences.ui.aiMode;
  // The AI gates derive from this shared preference (useCapabilities), so the
  // selector propagates reactively. usePreferences.set reverts its own state on a
  // failed POST (+ error toast); no DOM side-effect to roll back here.
  const onAiMode = (next: 'off' | 'preview') => {
    // SegmentedControl fires onChange even when the already-selected segment is
    // clicked. Guard the no-op so clicking the shown Preview on a live config does
    // not POST ui.ai.mode='preview' and silently downgrade it.
    if (next === aiModeShown) return;
    void set('ui.ai.mode', next).catch(() => {});
  };

  return (
    <section aria-labelledby="appearance-heading">
      <div className={pane.head}>
        <div>
          <h2 id="appearance-heading" className={pane.title}>
            Appearance
          </h2>
          <p className={pane.sub}>Theme, accent color, density, and AI mode</p>
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Theme</div>
          <div className={pane.help}>Match your system or pick a mode</div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="Theme"
            options={THEMES}
            value={preferences.ui.theme}
            onChange={onTheme}
          />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Accent</div>
          <div className={pane.help}>Highlight color across the app</div>
        </div>
        <div className={pane.spring}>
          <AccentSwatches value={preferences.ui.accent} onChange={onAccent} />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Density</div>
          <div className={pane.help}>Row height in lists and tables</div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="Density"
            options={DENSITIES}
            value={density}
            onChange={onDensity}
          />
        </div>
      </div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>AI mode</div>
          <div className={pane.help} id="ai-mode-help">
            Off · no AI. Preview · sample output, clearly labeled.
          </div>
        </div>
        <div className={pane.spring}>
          <SegmentedControl
            label="AI mode"
            describedById="ai-mode-help"
            options={[
              { value: 'off', label: 'Off' },
              { value: 'preview', label: 'Preview' },
            ]}
            value={aiModeShown}
            onChange={onAiMode}
          />
        </div>
      </div>
    </section>
  );
}
