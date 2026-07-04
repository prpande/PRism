# PRism release-notes style guide

These notes are for the people who **use** PRism — teammates trying the new
build — not for contributors reading a changelog. Explain what changed in terms
of what a reader can now see, do, or rely on. Never list raw pull requests,
commit hashes, PR numbers, or author handles in the prose.

## Goal

Answer three questions for someone whose last build was the previous release:

1. What is genuinely new — features they did not have before?
2. What can they now do differently — new mechanisms, controls, or improvements?
3. What was broken and is now fixed?

## Ordering — follow the release, do not force a template

Lead with whatever is actually the biggest, most useful change in *this*
release. Judge significance by user impact, then order sections and the items
inside them from most to least significant.

- Do **not** force any single theme to the top. If a major fix or a new
  mechanism is the headline, it leads.
- AI features are treated like any other change. Describe them in proportion to
  how much they matter in this release. Put AI first **only** when it is
  genuinely the main change; otherwise place it where its significance lands, or
  leave it out entirely if nothing user-facing shipped for it.
- Omit any section with no real content this release. Do not pad.

## Structure

Open with one short sentence naming the theme of the release — what a reader
should take away. Then group items under only the headings that apply, ordered
by significance:

- **New features** — capabilities that did not exist before.
- **Improvements** — existing things that now work better, plus new mechanisms,
  controls, and settings.
- **Fixes** — bugs resolved, described as the symptom a user would have hit.
- **Under the hood** — a short, optional note for security, dependency, and
  stability work worth mentioning. Keep it brief.

## Writing

- Address the reader as "you". Be friendly, plain, and concise.
- One line per item. Describe the observable benefit, not the implementation:
  "Resolve and unresolve review threads directly in the diff", not "added an
  IReviewThreadWriter seam".
- Fold related pull requests into a single item when they add up to one
  user-facing change. Do not enumerate every PR.
- Use concrete verbs. Avoid marketing words ("seamless", "powerful", "robust"),
  filler, and the usual AI-writing tics (forced three-item lists, "delve",
  heavy em-dash use). Neither hype nor hedging.
- If you are unsure what a change does for the user, flag it as uncertain rather
  than guessing.

## Length

Scale to the release. A small release is a few lines; a large one is a handful
of grouped items per section. Favor the shortest version that still tells the
reader what is new and what is fixed.
