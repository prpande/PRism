import { usePreferences } from '../../../hooks/usePreferences';
import { useCapabilities } from '../../../hooks/useCapabilities';
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
  const { refetch: refetchCapabilities } = useCapabilities();
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
  const onAiToggle = (next: boolean) => {
    set('aiPreview', next)
      .then(() => refetchCapabilities())
      .catch(() => {});
  };

  return (
    <section aria-labelledby="appearance-heading">
      <div className={pane.head}>
        <div>
          <h2 id="appearance-heading" className={pane.title}>Appearance</h2>
          <p className={pane.sub}>Theme, accent color, density, and AI preview</p>
        </div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Theme</div><div className={pane.help}>Match your system or pick a mode</div></div>
        <div className={pane.spring}><SegmentedControl label="Theme" options={THEMES} value={preferences.ui.theme} onChange={onTheme} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Accent</div><div className={pane.help}>Highlight color across the app</div></div>
        <div className={pane.spring}><AccentSwatches value={preferences.ui.accent} onChange={onAccent} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>Density</div><div className={pane.help}>Row height in lists and tables</div></div>
        <div className={pane.spring}><SegmentedControl label="Density" options={DENSITIES} value={density} onChange={onDensity} /></div>
      </div>
      <div className={pane.row}>
        <div><div className={pane.label}>AI preview</div><div id="ai-help" className={pane.help}>Show AI-generated PR summaries and hotspots</div></div>
        <div className={pane.spring}><Switch id="appearance-ai-preview" label="AI preview" describedById="ai-help" checked={preferences.ui.aiPreview} onChange={onAiToggle} /></div>
      </div>
    </section>
  );
}
