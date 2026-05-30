import { diffWords } from 'diff';
import styles from './WordDiffOverlay.module.css';

export interface WordDiffOverlayProps {
  oldText: string;
  newText: string;
  type: 'insert' | 'delete';
}

export function WordDiffOverlay({ oldText, newText, type }: WordDiffOverlayProps) {
  const changes = diffWords(oldText, newText);

  return (
    <span className={`word-diff-overlay ${styles.wordDiffOverlay}`} data-testid="word-diff-overlay">
      {changes.map((change, i) => {
        if (change.added && type === 'insert') {
          return (
            <span key={i} className={`word-diff-insert ${styles.wordDiffInsert}`}>
              {change.value}
            </span>
          );
        }
        if (change.removed && type === 'delete') {
          return (
            <span key={i} className={`word-diff-delete ${styles.wordDiffDelete}`}>
              {change.value}
            </span>
          );
        }
        if (!change.added && !change.removed) {
          return <span key={i}>{change.value}</span>;
        }
        return null;
      })}
    </span>
  );
}
