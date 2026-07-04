# PRism release-notes style guide

These notes are for the people who **use** PRism — teammates trying the new
build — not for contributors reading a changelog. Explain what changed in terms
of what a reader can now see, do, or rely on. Never dump raw commit hashes or
author handles in the prose, and do not list every pull request.

## What the reader needs

Answer three questions for someone whose last build was the previous release:

1. What is genuinely new — features they did not have before?
2. What can they now do differently — new mechanisms, controls, or improvements?
3. What was broken and is now fixed?

## How your output becomes the notes

Your JSON `entries` are rendered into the release body by the project's own
template. Two conventions make that render read well — follow them exactly.

### 1. Lead with an overview entry

Emit **one** entry that is not about a single pull request:

- `tag`: `Overview`
- `pr`: `0`
- `description`: a single paragraph of roughly **80–120 words** that names the
  theme of the release and what a reader should take away, in plain language.
  Lead with whatever actually dominates this release. Close with a light
  hand-off into the detail (for example, "Here's the detail."). One or two
  tasteful emoji are welcome; don't pepper them.

This entry is rendered as the opening paragraph, above every section. It is the
only place an overview can appear, so always include it.

### 2. Every other entry is one user-facing change

For each real change, set:

- `description`: a **short bold lead-in label**, then an em dash, then the
  change in plain language. For example:
  `**Draft PR badge** — draft pull requests are clearly marked on the inbox row
  and the PR-detail header`.
  - **Every item gets the bold label — 🐛 Fixes and 🔧 Under the hood entries
    included.** Do not lapse into plain symptom sentences for those sections; a
    fix still leads with a label, e.g. `**Gutter line numbers** — added files
    show their line numbers at rest, not only on hover`.
  - Describe the observable benefit, not the implementation ("resolve and
    unresolve review threads directly in the diff", not "added an
    IReviewThreadWriter seam").
  - **Do NOT put a `(#123)` reference in the description.** The PR number is
    appended automatically from the `pr` field — adding your own duplicates it.
- `tag`: exactly one of these section headings, chosen by what the change is
  (copy the emoji and text verbatim):
  - `🚀 New features` — capabilities that did not exist before.
  - `✨ Improvements` — existing things that now work better, plus new
    mechanisms, controls, and settings.
  - `🐛 Fixes` — bugs resolved, described as the symptom a user would hit.
  - `🔧 Under the hood` — security, dependency, and stability work worth a brief
    mention. Keep it short.
- `pr`: the pull request number for this change (an integer).

## Ordering — follow the release, do not force a template

The overview leads; then sections are rendered in the order their tags first
appear in your entries, and items within a section in the order you emit them.
So **emit entries in the order you want them read**: most to least significant
by user impact, with the most important section first. Do **not** force any
single theme to the top — whatever genuinely dominates this release leads,
whether that is a set of new features, a major fix, or a new mechanism. Weigh
every kind of change the same way, with no category treated as special. Omit any
section that has no real content.

## Writing each item

- Fold related pull requests into a single entry when they add up to one
  user-facing change; set `pr` to the most representative one. Do not enumerate
  every PR — the release links a full changelog separately.
- Skip pull requests with no user-facing effect — branch merges, pure internal
  refactors that change no behavior, CI/tooling-only changes, version bumps.
  Put them in `skippedPRs` with a one-line reason, not in the notes. "Merged
  branch X into main" is never a release-note item; even the 🔧 Under the hood
  section is for work a user would care about (security, stability, dependency
  updates), not routine development process.
- **Vary your phrasing.** Do not start every item — especially fixes — with the
  same words (for example, "Resolve an issue where…"). Describe each one
  directly and differently.
- Address the reader as "you". Be friendly, plain, and concise. Avoid marketing
  words ("seamless", "powerful", "robust"), filler, and AI-writing tics (forced
  three-item lists, "delve", heavy em-dash use in running prose). Neither hype
  nor hedging. The bold-label em dash is a deliberate separator, not prose.
- If you are unsure what a change does for the reader, put it in
  `uncertainEntries` rather than guessing.

## Length

Scale to the release. A small release is the overview plus a few items; a large
one is the overview plus a handful of grouped items per section. Favor the
shortest version that still tells the reader what is new and what is fixed.
