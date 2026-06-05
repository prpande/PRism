import styles from './DiffTruncationBanner.module.css';

export interface DiffTruncationBannerProps {
  // Authoritative PR web URL (PrDetailPr.htmlUrl). Absent → omit the link.
  prUrl?: string;
}

export function DiffTruncationBanner({ prUrl }: DiffTruncationBannerProps) {
  return (
    <div
      className={`diff-truncation-banner banner banner-warning ${styles.diffTruncationBanner}`}
      role="status"
      data-testid="diff-truncation-banner"
    >
      <p>
        PRism shows GitHub&apos;s first portion of this diff. Full-diff support is on the roadmap.{' '}
        {prUrl && (
          <a href={prUrl} target="_blank" rel="noopener noreferrer">
            Open on GitHub
          </a>
        )}
      </p>
    </div>
  );
}
