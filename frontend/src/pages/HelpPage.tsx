import { Link } from 'react-router-dom';
import styles from './HelpPage.module.css';

export function HelpPage() {
  return (
    <main className={styles.page} data-testid="help-page" tabIndex={-1}>
      <h1 className={styles.title}>Help</h1>
      <p className={styles.lede}>
        PRism is a local-first workspace for reviewing pull requests without leaving your machine.
      </p>

      <section className={styles.section}>
        <h2 id="what-is-prism" className={styles.sectionHeading}>
          What PRism is
        </h2>
        <p>
          PRism connects to GitHub with your personal access token and gives you a focused review
          workspace. Your token and PR data stay on this device.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="core-workflow" className={styles.sectionHeading}>
          The review loop
        </h2>
        <p>
          To review a PR: open it from the <strong>Inbox</strong>, read the change in the PR detail
          view, leave comments on the <strong>Files</strong> tab, then use <strong>Submit</strong>{' '}
          to send your review back to GitHub.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="surfaces" className={styles.sectionHeading}>
          The main surfaces
        </h2>
        <p>
          The <strong>Inbox</strong> lists the PRs awaiting you. Opening one shows the PR detail
          with an <strong>Overview</strong> and a <strong>Files</strong> tab. The gear opens{' '}
          <strong>Settings</strong> (appearance, inbox, GitHub connection).
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="connect-token" className={styles.sectionHeading}>
          Connecting or replacing your token
        </h2>
        <p>
          When you need to connect or replace your GitHub token, open{' '}
          <Link to="/settings/github-connection">Settings → GitHub connection</Link>. PRism
          recommends a classic token; the connect screen explains which token type you need.
        </p>
      </section>

      <section className={styles.section}>
        <h2 id="shortcuts" className={styles.sectionHeading}>
          Keyboard shortcuts
        </h2>
        <p>
          Press <kbd>?</kbd> (outside a text field) or <kbd>⌘/</kbd> (or <kbd>Ctrl+/</kbd>) anywhere
          to open the keyboard-shortcut cheatsheet.
        </p>
      </section>
    </main>
  );
}
