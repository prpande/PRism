import styles from './DiffTruncationBanner.module.css';

export interface DiffTruncationBannerProps {
  // Authoritative PR web URL (PrDetailPr.htmlUrl). Absent → omit the link.
  htmlUrl?: string;
}

export function DiffTruncationBanner({ htmlUrl }: DiffTruncationBannerProps) {
  return (
    <div
      className={`diff-truncation-banner banner banner-warning ${styles.diffTruncationBanner}`}
      role="status"
      data-testid="diff-truncation-banner"
    >
      <p>
        PRism shows GitHub&apos;s first portion of this diff. Full-diff support is on the roadmap.{' '}
        {htmlUrl && (
          <a href={htmlUrl} target="_blank" rel="noreferrer">
            Open on GitHub
          </a>
        )}
      </p>
    </div>
  );
}
