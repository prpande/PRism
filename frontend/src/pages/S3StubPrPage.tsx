import { Link, useParams } from 'react-router-dom';

export function S3StubPrPage() {
  const { owner, repo, number } = useParams();
  return (
    <main>
      <h1>PR detail lands in S3</h1>
      <p>
        Parsed reference:{' '}
        <code>
          {owner}/{repo}#{number}
        </code>
      </p>
      <Link to="/">Back to Inbox</Link>
    </main>
  );
}
