export interface ActivityItem {
  who: string;
  what: string;
  pr: string;
  when: string;
  isSystem?: boolean;
}

export interface WatchedRepo {
  repo: string;
  count: number;
}

export const activityItems: ActivityItem[] = [
  { who: 'amelia.cho', what: 'pushed iter 3 to', pr: '#1842', when: '12m' },
  { who: 'noah.s', what: 'commented on', pr: '#1810', when: '1h' },
  { who: 'jules.t', what: 'force-pushed', pr: '#1827', when: '3h' },
  { who: 'rohan.k', what: 'opened', pr: '#1839', when: '1h' },
  { who: 'amelia.cho', what: 'replied to your comment on', pr: '#1842', when: '2h' },
  { who: 'ci-bot', what: 'marked CI failing on', pr: '#1827', when: '3h', isSystem: true },
];

export const watchedRepos: WatchedRepo[] = [
  { repo: 'platform/billing-svc', count: 2 },
  { repo: 'platform/tenants-api', count: 1 },
  { repo: 'platform/web-edge', count: 0 },
];
