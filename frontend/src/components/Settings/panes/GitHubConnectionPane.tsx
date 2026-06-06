import { Link } from 'react-router-dom';
import { usePreferences } from '../../../hooks/usePreferences';
import { useSubmitInFlight } from '../../../hooks/useSubmitInFlight';
import pane from './Pane.module.css';

export function GitHubConnectionPane() {
  const { preferences } = usePreferences();
  const { inFlight, prRef } = useSubmitInFlight();
  if (!preferences) return null;
  const { host } = preferences.github;
  const tooltipMsg = `Submit on ${prRef ?? 'a pull request'} in progress`;

  return (
    <section aria-labelledby="ghc-heading">
      <div className={pane.head}>
        <div>
          <h2 id="ghc-heading" className={pane.title}>GitHub Connection</h2>
          <p className={pane.sub}>How PRism authenticates and where it connects</p>
        </div>
      </div>

      <div className={pane.subhead}>Access token</div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>Personal access token</div>
          <div className={pane.help}>Connected · stored locally on this machine</div>
        </div>
        <div className={pane.spring}>
          {inFlight ? (
            <>
              <Link to="/setup?replace=1" aria-disabled="true" aria-describedby="ghc-replace-help" title={tooltipMsg} onClick={(e) => e.preventDefault()} className={pane.linkDisabled}>
                Replace token
              </Link>
              <span id="ghc-replace-help" className="sr-only">{tooltipMsg}</span>
            </>
          ) : (
            <Link to="/setup?replace=1">Replace token</Link>
          )}
        </div>
      </div>

      <div className={pane.subhead}>Host</div>
      <div className={pane.row}>
        <div>
          <div className={pane.label}>GitHub host</div>
          <div className={pane.help}>The endpoint this token connects to</div>
        </div>
        <div className={pane.spring}><code className={pane.mono}>{host}</code></div>
      </div>
    </section>
  );
}
