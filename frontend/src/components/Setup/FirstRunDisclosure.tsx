// Spec § 14 OQ 1 resolution: single-source `navigator.platform`. The deprecation
// warning is real, but the modern `navigator.userAgentData.platform` is gated
// behind secure-context + spotty cross-browser support, and the unknown-platform
// branch already renders BOTH Windows and macOS blocks — degrading gracefully
// rather than silently hiding the trust copy.
function detectPlatform(): 'windows' | 'macos' | 'unknown' {
  const p = navigator.platform.toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('mac')) return 'macos';
  return 'unknown';
}

export function FirstRunDisclosure() {
  const platform = detectPlatform();
  return (
    <details>
      <summary>First run on this machine?</summary>
      {(platform === 'windows' || platform === 'unknown') && (
        <section>
          <h3>Windows</h3>
          <p>
            The first time you run PRism, Windows shows a SmartScreen warning (&ldquo;Windows
            protected your PC&rdquo;) because PRism isn&rsquo;t code-signed for the PoC. Click{' '}
            <strong>More info</strong>, then <strong>Run anyway</strong>. Code signing arrives
            post-PoC.
          </p>
        </section>
      )}
      {(platform === 'macos' || platform === 'unknown') && (
        <section>
          <h3>macOS</h3>
          <p>
            If macOS Gatekeeper blocks the binary, right-click the app and pick{' '}
            <strong>Open</strong> the first time. The first time PRism reads your token, macOS asks{' '}
            <strong>Allow / Always Allow / Deny</strong> &mdash; click <strong>Always Allow</strong>{' '}
            so you aren&rsquo;t asked again. Code signing arrives post-PoC.
          </p>
        </section>
      )}
    </details>
  );
}
