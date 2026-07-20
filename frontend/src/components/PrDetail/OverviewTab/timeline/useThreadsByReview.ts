import { useMemo } from 'react';
import type { ReviewThreadDto } from '../../../../api/types';

/**
 * Groups a PR's review threads by the database id of the review that owns them, so the
 * Activity timeline can hang each thread under its `review:{databaseId}` card (#774). Threads
 * with no owning review (`reviewDatabaseId == null`) are omitted — they stay visible in the
 * Files tab if anchored. Each review's threads are ordered by first-comment createdAt ascending.
 */
export function useThreadsByReview(
  reviewComments: ReviewThreadDto[],
): Map<number, ReviewThreadDto[]> {
  return useMemo(() => {
    const map = new Map<number, ReviewThreadDto[]>();
    for (const t of reviewComments) {
      if (t.reviewDatabaseId == null) continue;
      const list = map.get(t.reviewDatabaseId);
      if (list) list.push(t);
      else map.set(t.reviewDatabaseId, [t]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => firstCreatedAt(a).localeCompare(firstCreatedAt(b)));
    }
    return map;
  }, [reviewComments]);
}

function firstCreatedAt(t: ReviewThreadDto): string {
  return t.comments.length > 0 ? t.comments[0].createdAt : '';
}
