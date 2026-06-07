import { describe, it, expect } from 'vitest';
import { FEEDBACK_REPO_SLUG, buildFeedbackIssueUrl } from './feedbackRepo';

describe('feedbackRepo', () => {
  it('pins the public feedback repo slug (single-side-edit guard; matches backend FeedbackRepo.Slug)', () => {
    expect(FEEDBACK_REPO_SLUG).toBe('prpande/PRism-feedback');
  });

  it('builds an https issues/new URL with encoded title and body', () => {
    const url = buildFeedbackIssueUrl({
      title: '[Bug] a b',
      details: 'line1\nline2',
      context: 'route: /inbox',
    });
    const u = new URL(url);
    expect(u.protocol).toBe('https:');
    expect(u.host).toBe('github.com');
    expect(u.pathname).toBe('/prpande/PRism-feedback/issues/new');
    expect(u.searchParams.get('title')).toBe('[Bug] a b');
    expect(u.searchParams.get('body')).toContain('line1\nline2');
    expect(u.searchParams.get('body')).toContain('route: /inbox');
  });

  it('drops the context block first when over the cap, preserving details', () => {
    const details = 'D'.repeat(3000);
    const url = buildFeedbackIssueUrl({ title: 'x', details, context: 'C'.repeat(5000) });
    const body = new URL(url).searchParams.get('body')!;
    expect(url.length).toBeLessThanOrEqual(6144);
    expect(body).toContain('D'.repeat(2000)); // details substantially preserved
    expect(body).not.toContain('C'.repeat(100)); // context dropped
  });

  it('truncates details with a marker only when details alone still exceed the cap', () => {
    const url = buildFeedbackIssueUrl({ title: 'x', details: 'y'.repeat(10000), context: '' });
    expect(url.length).toBeLessThanOrEqual(6144);
    expect(new URL(url).searchParams.get('body')).toContain('(truncated');
  });
});
