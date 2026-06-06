import { usePreferences } from '../../../hooks/usePreferences';
import { useToast } from '../../Toast';
import pane from './Pane.module.css';

export function SystemPane() {
  const { preferences } = usePreferences();
  const { show } = useToast();
  if (!preferences) return null;
  const { configPath, logsPath } = preferences.github;

  const copy = (value: string, ok: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(value);
        show({ kind: 'success', message: ok });
      } catch {
        show({
          kind: 'error',
          message: 'Could not copy path. Select it from the field next to the button.',
        });
      }
    })();
  };

  return (
    <section aria-labelledby="system-heading">
      <div className={pane.head}>
        <div>
          <h2 id="system-heading" className={pane.title}>
            Files &amp; logs
          </h2>
          <p className={pane.sub}>Local file locations on this machine</p>
        </div>
      </div>
      <div className={pane.row}>
        <label htmlFor="system-config-path" className={pane.label} style={{ flex: 'none' }}>
          config.json
        </label>
        <input
          id="system-config-path"
          type="text"
          readOnly
          value={configPath}
          className={pane.field}
        />
        <button
          type="button"
          onClick={() => copy(configPath, 'Path copied — paste into your editor.')}
        >
          Copy config.json path
        </button>
      </div>
      <div className={pane.row}>
        <label htmlFor="system-logs-path" className={pane.label} style={{ flex: 'none' }}>
          Logs
        </label>
        <input id="system-logs-path" type="text" readOnly value={logsPath} className={pane.field} />
        <button
          type="button"
          onClick={() =>
            copy(logsPath, 'Logs path copied — paste into a terminal or file browser.')
          }
        >
          Copy logs path
        </button>
      </div>
    </section>
  );
}
