import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';

interface PrDescriptionProps {
  title: string;
  body: string;
  aiPreview: boolean;
}

export function PrDescription({ title, body, aiPreview }: PrDescriptionProps) {
  const isEmptyBody = body.trim().length === 0;
  const cardClass = aiPreview
    ? 'overview-card pr-description'
    : 'overview-card pr-description overview-card-hero-no-ai';

  return (
    <section className={cardClass}>
      {!aiPreview && <div className="pr-description-title">{title}</div>}
      {isEmptyBody ? (
        <p className="pr-description-empty muted">No description provided</p>
      ) : (
        <MarkdownRenderer source={body} className="pr-description-body" />
      )}
    </section>
  );
}
