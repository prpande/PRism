import type { ReviewActionMenuSection } from './reviewActionState';
import type { DraftVerdict } from '../../../api/types';
export function ReviewActionMenu(_: {
  sections: ReviewActionMenuSection[];
  onClose: () => void;
  onSelect: (id: string, verdict?: DraftVerdict) => void;
}) { return null; }
