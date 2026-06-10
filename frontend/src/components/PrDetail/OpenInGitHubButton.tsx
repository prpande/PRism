// "Open in GitHub" escape-hatch link in the PR-detail header .prActions.
// - href is the authoritative PrDetailPr.htmlUrl (host-correct for GHES).
// - Absent href → render nothing (no dead control).
// - Desktop: when the bridge method exists, intercept and open in the OS browser.
//   Gate on the METHOD's presence, not window.prism.isDesktop: an older/partial
//   desktop build can expose isDesktop:true with no openExternal, and gating on
//   isDesktop would preventDefault() then call undefined → a dead control.
// - Browser (or partial desktop): the native target="_blank" opens a new tab.
import { GitHubMark } from '../icons/GitHubMark';

interface OpenInGitHubButtonProps {
  href?: string | null;
}

export function OpenInGitHubButton({ href }: OpenInGitHubButtonProps) {
  if (!href) return null;

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (typeof window.prism?.openExternal === 'function') {
      e.preventDefault();
      void window.prism.openExternal(href);
    }
  };

  return (
    <a
      className="btn btn-icon open-in-github-button"
      href={href}
      target="_blank"
      rel="noreferrer"
      aria-label="Open in GitHub"
      title="Open in GitHub"
      data-testid="open-in-github-button"
      onClick={handleClick}
    >
      <GitHubMark />
    </a>
  );
}
