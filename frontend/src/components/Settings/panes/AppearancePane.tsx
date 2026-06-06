import { usePreferences } from '../../../hooks/usePreferences';
import { applyThemeToDocument, applyDensityToDocument } from '../../../utils/applyTheme';
import type { Accent, Density, Theme } from '../../../api/types';
import { SegmentedControl } from '../../controls/SegmentedControl';
import { AccentSwatches } from '../../controls/AccentSwatches';
import { Switch } from '../../controls/Switch';
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
  // No extra rollback needed (unlike theme/accent/density): those re-apply to
  // documentElement on failure because they wrote a DOM side-effect optimistically.
  // aiPreview has no such DOM write — usePreferences.set reverts its own state on a
  // failed POST (+ error toast), so the controlled Switch reflects the revert.
  // #221: the AI gates now derive from this shared preference (useCapabilities), so
  // the toggle propagates reactively — no capabilities refetch to chase.
  const onAiToggle = (next: boolean) => {
    void set('aiPreview', next).catch(() => {});
  };

  return (
    <section aria-labelledby="appearance-heading">
      <div className={pane.head}>
        <div>
          <h2 id="appearance-heading" className={pane.title}>
            Appearance
          </h2>
          <p className={pane.sub}>Theme, accent color, density, and AI preview</p>
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
          <label className={pane.label} htmlFor="appearance-ai-preview">
            AI preview
          </label>
          <div id="ai-help" className={pane.help}>
            Show AI-generated PR summaries and hotspots
          </div>
        </div>
        <div className={pane.spring}>
          <Switch
            id="appearance-ai-preview"
            label="AI preview"
            describedById="ai-help"
            checked={preferences.ui.aiPreview}
            onChange={onAiToggle}
          />
        </div>
      </div>
    </section>
  );
}
