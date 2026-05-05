import { useState, type FormEvent } from 'react';
import { MaskedInput } from './MaskedInput';
import { ScopePill } from './ScopePill';
import styles from './SetupForm.module.css';

interface Props {
  host: string;
  onSubmit: (pat: string) => void | Promise<void>;
  error?: string;
  busy?: boolean;
}

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
        <div className={styles.scopes}>
          <ScopePill scope="repo" />
          <ScopePill scope="read:user" />
          <ScopePill scope="read:org" />
        </div>
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
      <button
        type="submit"
        className={styles.continue}
        disabled={pat.trim().length === 0 || busy}
      >
        {busy ? 'Validating…' : 'Continue'}
      </button>
    </form>
  );
}
