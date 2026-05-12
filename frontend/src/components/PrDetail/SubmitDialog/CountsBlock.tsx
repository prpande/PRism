// "This review will create N new thread(s) and M reply(ies)." — render 0
// explicitly, plural form for everything except exactly 1 (spec § 8.1 item 4).
interface Props {
  threadCount: number;
  replyCount: number;
}

function count(n: number, singular: string, plural: string): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export function CountsBlock({ threadCount, replyCount }: Props) {
  return (
    <p className="submit-dialog__counts" data-section-counts>
      This review will create {count(threadCount, 'new thread', 'new threads')} and{' '}
      {count(replyCount, 'reply', 'replies')}.
    </p>
  );
}
