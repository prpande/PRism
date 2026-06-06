import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { FirstRunDisclosure } from './FirstRunDisclosure';
import { MaskedInput } from './MaskedInput';
import { SegmentedControl } from '../controls/SegmentedControl';
import { GitHubMark } from '../icons/GitHubMark';
import { DangerGlyph } from '../ErrorModal/DangerGlyph';
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
  // #212 — on a true first run (!hasToken), SetupPage passes this so the user can
  // return to the /welcome landing. Absent (not disabled) otherwise, so re-auth
  // and replace users see no phantom back-link. Kept as a boolean prop (mirroring
  // isReplaceMode) so SetupForm stays router-agnostic and unit-testable bare.
  //
  // Mutually exclusive with isReplaceMode: SetupPage derives this from
  // !authState.hasToken, and replace mode requires an existing token
  // (hasToken === true), so the two are never both set at the call site. The
  // component does NOT enforce this — passing both would render the Back link
  // (top) and the Cancel link (bottom) simultaneously. The invariant lives in
  // SetupPage, not here.
  showBackToWelcome?: boolean;
  // #213 — fired when the user switches token type so the parent can drop a
  // now-irrelevant connect error (a classic-scopes message must not persist
  // against the fine-grained panel, and vice versa). The parent owns `error`.
  onErrorClear?: () => void;
}

type TokenType = 'classic' | 'fine-grained';

const FG_PERMISSIONS: ReadonlyArray<{ name: string; level: string }> = [
  { name: 'Pull requests', level: 'Read and write' },
  { name: 'Contents', level: 'Read' },
  { name: 'Commit statuses', level: 'Read' },
];

const ExternalIcon = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M9.5 2.75A.75.75 0 0110.25 2h3.5a.25.25 0 01.25.25v3.5a.75.75 0 01-1.5 0V4.56L8.78 8.28a.75.75 0 01-1.06-1.06l3.72-3.72H10.25a.75.75 0 01-.75-.75z" />
    <path d="M3.75 2A1.75 1.75 0 002 3.75v8.5C2 13.216 2.784 14 3.75 14h8.5A1.75 1.75 0 0014 12.25v-3.5a.75.75 0 00-1.5 0v3.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5a.25.25 0 01.25-.25h3.5a.75.75 0 000-1.5z" />
  </svg>
);
const OrgIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M1.75 16A1.75 1.75 0 010 14.25V1.75C0 .784.784 0 1.75 0h8.5C11.216 0 12 .784 12 1.75v12.5c0 .085-.006.168-.018.25h2.268a.25.25 0 00.25-.25V8.285a.25.25 0 00-.111-.208l-1.055-.703a.75.75 0 11.832-1.248l1.055.703c.487.325.779.871.779 1.456v5.965A1.75 1.75 0 0114.25 16h-3.5a.766.766 0 01-.197-.026c-.099.017-.2.026-.303.026h-3a.75.75 0 01-.75-.75V14h-1v1.25a.75.75 0 01-.75.75zM1.75 1.5a.25.25 0 00-.25.25v12.5c0 .138.112.25.25.25H4v-1.25a.75.75 0 01.75-.75h2.5a.75.75 0 01.75.75v1.25h2.25a.25.25 0 00.25-.25V1.75a.25.25 0 00-.25-.25zM3.75 6h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5zM3 3.75A.75.75 0 013.75 3h.5a.75.75 0 010 1.5h-.5A.75.75 0 013 3.75zm4 3A.75.75 0 017.75 6h.5a.75.75 0 010 1.5h-.5A.75.75 0 017 6.75zM7.75 3h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5zM3 9.75A.75.75 0 013.75 9h.5a.75.75 0 010 1.5h-.5A.75.75 0 013 9.75zM7.75 9h.5a.75.75 0 010 1.5h-.5a.75.75 0 010-1.5z" />
  </svg>
);
const WarnIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0114.082 15H1.918a1.75 1.75 0 01-1.543-2.575zM8 5a.75.75 0 00-.75.75v2.5a.75.75 0 001.5 0v-2.5A.75.75 0 008 5zm1 6a1 1 0 10-2 0 1 1 0 002 0z" />
  </svg>
);
// Error-pill icon reuses the shared DangerGlyph (ErrorModal/DangerGlyph, #182) —
// same 14px circled-exclamation; no local duplicate.

export function SetupForm({
  host,
  onSubmit,
  error,
  busy,
  isReplaceMode,
  showBackToWelcome,
  onErrorClear,
}: Props) {
  const [pat, setPat] = useState('');
  const [tokenType, setTokenType] = useState<TokenType>('classic');
  const errorId = useId();
  const base = host.replace(/\/$/, '');
  const classicUrl = `${base}/settings/tokens/new`;
  const fineGrainedUrl = `${base}/settings/personal-access-tokens/new`;
  const placeholder = tokenType === 'classic' ? 'ghp_…' : 'github_pat_…';

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (pat.trim().length === 0) return;
    void onSubmit(pat);
  };

  return (
    <form onSubmit={handleSubmit} className={styles.form}>
      {showBackToWelcome && (
        <Link to="/welcome" className={styles.back}>
          <span aria-hidden="true">← </span>Back
        </Link>
      )}
      <div className={styles.brand}>
        <h1 className={styles.title}>
          <GitHubMark size={22} />
          Connect to GitHub
        </h1>
      </div>

      <section className={styles.section}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>1</span>
          Choose a token type
        </h2>
        <SegmentedControl<TokenType>
          variant="nav"
          label="Choose a token type"
          options={[
            { value: 'classic', label: 'Classic' },
            { value: 'fine-grained', label: 'Fine-grained' },
          ]}
          value={tokenType}
          onChange={(t) => {
            setTokenType(t);
            // Clear any stale connect error so a classic-scopes message can't persist
            // against the fine-grained panel (and vice versa). The parent owns `error`;
            // this asks it to drop it. (#213)
            onErrorClear?.();
          }}
        />

        {tokenType === 'classic' ? (
          <div className={styles.panel}>
            <a href={classicUrl} target="_blank" rel="noreferrer" className={styles.link}>
              Generate a classic token <ExternalIcon />
            </a>
            <p className={styles.lbl}>Required scopes</p>
            <div className={styles.scopes}>
              <code className={styles.chip}>repo</code>
              <code className={styles.chip}>read:org</code>
            </div>
            <div className={styles.callout}>
              <span className={styles.calloutIco}>
                <OrgIcon />
              </span>
              <span>
                Using <strong>SAML SSO</strong>? After creating the token, click{' '}
                <strong>Configure SSO → Authorize</strong> for your organization.
              </span>
            </div>
          </div>
        ) : (
          <div className={styles.panel}>
            <a href={fineGrainedUrl} target="_blank" rel="noreferrer" className={styles.link}>
              Generate a fine-grained token <ExternalIcon />
            </a>
            <p className={styles.lbl}>Fine-grained permissions</p>
            <dl className={styles.permissions}>
              {FG_PERMISSIONS.map((p) => (
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
            <div className={styles.warn}>
              <span className={styles.warnIco}>
                <WarnIcon />
              </span>
              <span>
                Can&rsquo;t read <strong>GitHub Actions</strong> check results — Actions CI status
                won&rsquo;t show in PRism. Other CI providers still work.
              </span>
            </div>
          </div>
        )}
      </section>

      <FirstRunDisclosure />

      <section className={`${styles.section} ${styles.sectionLast}`}>
        <h2 className={styles.sectionHead}>
          <span className={styles.num}>2</span>
          Paste it below
        </h2>
        <MaskedInput
          id="pat"
          value={pat}
          onChange={setPat}
          placeholder={placeholder}
          ariaLabel="Personal access token"
          hasError={!!error}
          errorId={errorId}
        />
      </section>

      {error && (
        <div role="alert" id={errorId} className={styles.error}>
          <DangerGlyph />
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
