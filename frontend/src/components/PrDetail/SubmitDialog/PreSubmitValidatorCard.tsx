import { MarkdownRenderer } from '../../Markdown/MarkdownRenderer';
import type { ValidatorResult, ValidatorSeverity } from '../../../api/types';

// Pre-submit validator slot (spec § 14.1). PoC's NoopPreSubmitValidator
// returns []; under aiPreview the header feeds frontend-side canned data —
// there is no IPreSubmitValidator.ValidateAsync call. Renders null when empty
// (mirrors AiSummaryCard's "data-or-nothing" gating).
interface Props {
  results: ValidatorResult[];
}

const CHIP_CLASS: Record<ValidatorSeverity, string> = {
  Suggestion: 'chip-status-suggestion',
  Concern: 'chip-status-concern',
  Blocking: 'chip-status-blocking',
};

export function PreSubmitValidatorCard({ results }: Props) {
  if (results.length === 0) return null;
  return (
    <section className="ai-validator-card ai-tint" aria-label="AI pre-submit checks">
      <div className="ai-validator-card__chip muted">
        AI preview — sample content, not generated from this PR
      </div>
      <ul className="ai-validator-card__list">
        {results.map((r) => (
          <li key={`${r.severity}:${r.message}`} className="ai-validator-card__item">
            <span className={`chip ${CHIP_CLASS[r.severity]}`}>{r.severity}</span>
            <span className="ai-validator-card__message">
              <MarkdownRenderer source={r.message} className="ai-validator-card__md" />
            </span>
            {/* Dead link in placeholder mode — kept out of the tab order; v2
                wires real navigation into the same slot. */}
            <button
              type="button"
              className="ai-validator-card__show-me"
              disabled
              aria-disabled="true"
            >
              Show me
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
