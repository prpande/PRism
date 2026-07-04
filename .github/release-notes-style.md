# PRism release-notes style guide

These notes are for the people who **use** PRism — teammates trying the new
build — not for contributors reading a changelog. Explain what changed in terms
of what a reader can now see, do, or rely on. Never dump raw pull requests,
commit hashes, or author handles in the prose. (A short `(#123)` reference at the
end of an item is fine; a PR-by-PR list is not.)

## Goal

Answer three questions for someone whose last build was the previous release:

1. What is genuinely new — features they did not have before?
2. What can they now do differently — new mechanisms, controls, or improvements?
3. What was broken and is now fixed?

## Shape of the notes

1. **Overview first.** Open with a single short paragraph — roughly 80–120
   words — that names the theme of the release and what a reader should take
   away, in plain language, before any section heading. Lead with whatever
   actually dominates this release. Close it with a light hand-off into the
   detail (for example, "Here's the detail."). One or two tasteful emoji in the
   overview are welcome; don't pepper them.
2. **Then the grouped detail**, under only the headings that apply, ordered by
   significance. Use these emoji headings exactly:
   - `## 🚀 New features` — capabilities that did not exist before.
   - `## ✨ Improvements` — existing things that now work better, plus new
     mechanisms, controls, and settings.
   - `## 🐛 Fixes` — bugs resolved, described as the symptom a user would hit.
   - `## 🔧 Under the hood` — a short, optional note for security, dependency,
     and stability work worth mentioning. Keep it brief.

   Omit any section with no real content. Do not pad. Do NOT add a "What's
   Changed", changelog, contributors, or full-changelog-link section — anything
   after the grouped detail is added outside these notes.

## Ordering — follow the release, do not force a template

Judge significance by user impact, then order the sections, and the items inside
each one, from most to least significant. Do **not** force any single theme to
the top: whatever genuinely dominates this release leads, whether that is a set
of new features, a major fix, or a new mechanism. Weigh every kind of change the
same way — by how much it matters to the reader — with no category treated as
special.

## Writing each item

- One bullet per item. Open with a **short bold lead-in label**, then an em dash,
  then the description in plain language, then an optional `(#123)`:
  `- **Draft PR badge** — draft pull requests are clearly marked on the inbox row
  and the PR-detail header. (#535)`
- Describe the observable benefit, not the implementation: "Resolve and unresolve
  review threads directly in the diff", not "added an IReviewThreadWriter seam".
- Fold related pull requests into a single item when they add up to one
  user-facing change. Do not enumerate every PR.
- **Vary your phrasing.** Do not start every item — especially fixes — with the
  same words (for example, "Resolve an issue where…"). Describe each one directly
  and differently.
- Address the reader as "you". Be friendly, plain, and concise. Avoid marketing
  words ("seamless", "powerful", "robust"), filler, and AI-writing tics (forced
  three-item lists, "delve", heavy em-dash use in running prose). Neither hype
  nor hedging. The bold-label em dash above is a deliberate separator, not prose.
- If you are unsure what a change does for the reader, flag it as uncertain
  rather than guessing.

## Length

Scale to the release. A small release is the overview plus a few bullets; a large
one is the overview plus a handful of grouped items per section. Favor the
shortest version that still tells the reader what is new and what is fixed.
