import { usePreferences } from '../../hooks/usePreferences';
import { useToast } from '../Toast';
import styles from './SettingsSections.module.css';

// Spec § 2.7 (renamed from `GithubSection` in the 2026-05-25 adversarial round
// because SR-by-heading navigation lands on "GitHub" and finds a "Copy logs
// path" button that is not a GitHub-scoped concept; "Connection" covers Host +
// configPath + logsPath under one operational concept). Wire field names stay
// `github.*` — they're keyed by config namespace, not user-facing presentation.
export function ConnectionSection() {
  const { preferences } = usePreferences();
  const { show } = useToast();
  if (!preferences) return null;
  const { host, configPath, logsPath } = preferences.github;

  const copyConfigPath = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(configPath);
        show({ kind: 'success', message: 'Path copied — paste into your editor.' });
      } catch {
        show({
          kind: 'error',
          message: 'Could not copy path. Select it from the field next to the button.',
        });
      }
    })();
  };

  const copyLogsPath = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(logsPath);
        show({
          kind: 'success',
          message: 'Logs path copied — paste into a terminal or file browser.',
        });
      } catch {
        show({
          kind: 'error',
          message: 'Could not copy path. Select it from the field next to the button.',
        });
      }
    })();
  };

  return (
    <section aria-labelledby="connection-heading" className={styles.section}>
      <h2 id="connection-heading">Connection</h2>

      <div className={styles.row}>
        <span>Host</span>
        <code>{host}</code>
      </div>

      <div className={styles.row}>
        <label htmlFor="connection-config-path">
          Path to <code>config.json</code>
        </label>
        <input
          id="connection-config-path"
          type="text"
          readOnly
          value={configPath}
          aria-label="Path to config.json"
        />
        <button type="button" onClick={copyConfigPath}>
          Copy config.json path
        </button>
      </div>

      <div className={styles.row}>
        <label htmlFor="connection-logs-path">Path to PRism logs</label>
        <input
          id="connection-logs-path"
          type="text"
          readOnly
          value={logsPath}
          aria-label="Path to PRism logs"
        />
        <button type="button" onClick={copyLogsPath}>
          Copy logs path
        </button>
      </div>
    </section>
  );
}
