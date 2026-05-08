export interface DiffTruncationBannerProps {
  prUrl: string;
}

export function DiffTruncationBanner({ prUrl }: DiffTruncationBannerProps) {
  return (
    <div className="diff-truncation-banner" role="status">
      <p>
        PRism shows GitHub&apos;s first portion of this diff. Full-diff support is on the roadmap.{' '}
        <a href={prUrl} target="_blank" rel="noopener noreferrer">
          Open on github.com
        </a>
      </p>
    </div>
  );
}
