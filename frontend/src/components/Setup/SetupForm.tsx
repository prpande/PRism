import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FirstRunDisclosure } from './FirstRunDisclosure';
import { MaskedInput } from './MaskedInput';
import styles from './SetupForm.module.css';

interface Props {
  host: string;
  onSubmit: (pat: string) => void | Promise<void>;
  error?: string;
  busy?: boolean;
  // S6 PR4 — when the user reached /setup via Settings → Replace token, render a
  // Cancel link to bail out back to /settings without committing the new PAT.
  // SetupPage owns the URL-param read; keeping the boolean on the prop avoids
  // coupling SetupForm to react-router state and keeps the component testable
  // without a Router wrapper in existing tests (SetupForm tests render bare).
  isReplaceMode?: boolean;
}

const PERMISSIONS: ReadonlyArray<{ name: string; level: string }> = [
  { name: 'Pull requests', level: 'Read and write' },
  { name: 'Contents', level: 'Read' },
  { name: 'Checks', level: 'Read' },
  { name: 'Commit statuses', level: 'Read' },
];

export function SetupForm({ host, onSubmit, error, busy, isReplaceMode }: Props) {
  const [pat, setPat] = useState('');
  const patPageUrl = `${host.replace(/\/$/, '')}/settings/personal-access-tokens/new`;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pat.trim().length === 0) return;
    void onSubmit(pat);
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      {/* <div> not <header> — the App-level <Header /> already exposes a
          banner landmark, and <header> inside <form> is NOT excluded from
          the banner-role mapping per the HTML AAM (the exclusion list is
          article/aside/main/nav/section). Using <div> preserves the visual
          grouping without duplicating the banner role. */}
      <div className={styles.brand}>
        <h1 className={styles.title}>Connect to GitHub</h1>
        <p className={styles.sub}>PRism is local-first. Your token never leaves this machine.</p>
      </div>
      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>1</span>
          <a href={patPageUrl} target="_blank" rel="noreferrer" className={styles.link}>
            Generate a token
          </a>
        </h2>
        <dl className={styles.permissions}>
          {PERMISSIONS.map((p) => (
            <div key={p.name} className={styles.permissionRow}>
              <dt>{p.name}</dt>
              <dd>{p.level}</dd>
            </div>
          ))}
        </dl>
        <p className={styles.permissionsNote}>
          Metadata: Read is auto-included by GitHub. For Repository access, choose
          <em> All repositories</em> or <em>Select repositories</em>.
        </p>
        <p className={styles.footnote}>
          Already have a classic PAT? It needs the <code>repo</code>, <code>read:user</code>, and{' '}
          <code>read:org</code> scopes.
        </p>
      </section>
      <FirstRunDisclosure />
      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>2</span>
          Paste it below
        </h2>
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder="ghp_… or github_pat_…"
          ariaLabel="Personal access token"
        />
      </section>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      <button
        type="submit"
        className={`${styles.continue} btn btn-primary btn-lg`}
        disabled={pat.trim().length === 0 || busy}
      >
        {busy ? 'Validating…' : 'Continue'}
      </button>
      {isReplaceMode &&
        (busy ? (
          // While the replace POST is in flight, neutralize Cancel: the backend
          // has no abort path once /api/auth/replace reaches WriteTransientAsync
          // → ValidateCredentialsAsync → CommitAsync. A clickable Cancel that
          // navigates to /settings WITHOUT aborting the fetch would let the
          // server complete the swap (drafts preserved, Node IDs cleared) while
          // the user thinks they cancelled — the worst kind of silent commit.
          // Rendered as aria-disabled with the disabled-link CSS so the affordance
          // stays visible (consistent UI) but unreachable until Continue resolves.
          // role="link" is explicit (claude[bot] iter-5 F3): aria-disabled on a
          // bare <span> with no implicit role has no semantics for assistive tech;
          // screen readers won't announce "disabled" because there's no
          // interactive role to be disabled from. Matching role="link" (which the
          // non-busy <Link> branch implicitly carries) gives SR users a parallel
          // announcement across both states.
          <span
            role="link"
            aria-disabled="true"
            className={`${styles.cancel} ${styles.cancelDisabled}`}
          >
            Cancel
          </span>
        ) : (
          <Link to="/settings" className={styles.cancel}>
            Cancel
          </Link>
        ))}
    </form>
  );
}
