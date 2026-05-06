import { useState, type FormEvent } from 'react';
import { MaskedInput } from './MaskedInput';
import styles from './SetupForm.module.css';

interface Props {
  host: string;
  onSubmit: (pat: string) => void | Promise<void>;
  error?: string;
  busy?: boolean;
}

const PERMISSIONS: ReadonlyArray<{ name: string; level: string }> = [
  { name: 'Pull requests', level: 'Read and write' },
  { name: 'Contents', level: 'Read' },
  { name: 'Checks', level: 'Read' },
  { name: 'Commit statuses', level: 'Read' },
];

export function SetupForm({ host, onSubmit, error, busy }: Props) {
  const [pat, setPat] = useState('');
  const patPageUrl = `${host.replace(/\/$/, '')}/settings/personal-access-tokens/new`;

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pat.trim().length === 0) return;
    void onSubmit(pat);
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      <h1>Connect to GitHub</h1>
      <p>PRism is local-first. Your token never leaves this machine.</p>
      <div>
        <strong>1.</strong>{' '}
        <a href={patPageUrl} target="_blank" rel="noreferrer">
          Generate a token
        </a>
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
      </div>
      <div>
        <strong>2.</strong> Paste it below
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder="ghp_… or github_pat_…"
          ariaLabel="Personal access token"
        />
      </div>
      {error && (
        <div role="alert" className={styles.error}>
          {error}
        </div>
      )}
      <button type="submit" className={styles.continue} disabled={pat.trim().length === 0 || busy}>
        {busy ? 'Validating…' : 'Continue'}
      </button>
    </form>
  );
}
