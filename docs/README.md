# PRism — Documentation

PRism is a local-first, single-user PR review tool that runs as a web app on the reviewer's own machine. It reads from GitHub, lets the reviewer compose a complete review locally (drafts, replies, verdict, summary), and finalizes everything together via a GitHub *pending review* — invisible to others until the user clicks Submit, then revealed at once. v2 layers AI augmentation on top via Claude (using the user's Claude subscription).

This directory contains the full specification for the PoC and the prioritized backlog for v2 and beyond.

---

## Document map

### Specification (`docs/spec/`)

Read in order if you're implementing the PoC. The numbering matches the file-prefix on disk so a future contributor adding e.g. `01.5-something.md` does not have to renumber this map.

0. [`00-verification-notes.md`](spec/00-verification-notes.md) — what was verified against external API behavior; cross-references throughout the spec point here.
1. [`01-vision-and-acceptance.md`](spec/01-vision-and-acceptance.md) — what we're building, why, and the definition of done.
2. [`02-architecture.md`](spec/02-architecture.md) — stack, project layout, distribution, the `IReviewService` interface, GHES host configuration.
3. [`03-poc-features.md`](spec/03-poc-features.md) — every user-facing PoC feature, fully specified.
4. [`04-ai-seam-architecture.md`](spec/04-ai-seam-architecture.md) — the interfaces, frontend slots, capability registry, and Claude Code integration that v2 plugs into.
5. [`05-non-goals.md`](spec/05-non-goals.md) — what's explicitly **not** in the PoC.

### Backlog (`docs/backlog/`)

Read [`00-priority-methodology.md`](backlog/00-priority-methodology.md) first to understand how priorities and dependencies work, then read by priority tier.

- [`00-priority-methodology.md`](backlog/00-priority-methodology.md) — how items are prioritized, the dependency graph, and how to convert backlog items into spec items.
- [`01-P0-foundations.md`](backlog/01-P0-foundations.md) — infrastructure prerequisites that block AI features.
- [`02-P1-core-ai.md`](backlog/02-P1-core-ai.md) — first-wave AI features users will see.
- [`03-P2-extended-ai.md`](backlog/03-P2-extended-ai.md) — higher-touch AI features (composer assist, validators, chat with repo access).
- [`05-P4-polish.md`](backlog/05-P4-polish.md) — quality-of-life features and smaller wins.

(There is no `04-P3-multi-platform.md`; the multi-platform tier was dropped along with the provider abstraction. PoC and v2 commit to GitHub — cloud and GHES — as the only backend.)

### Design

- [`claude-design-prompt.md`](claude-design-prompt.md) — the prompt to feed to Claude Design (or any visual-design agent) to generate the UI/UX styling.

### Review

- [`spec-review.md`](spec-review.md) — the latest adversarial pass over the corpus; remediation lands in the spec text and is tracked at the section level. Treat this file as transient working notes — its findings are absorbed into `00-verification-notes.md` and the spec proper as each pass completes. Read it for context on *why* certain decisions in the spec read the way they do.

---

## Reading orders by audience

**"I'm building the PoC."**
1. `spec/00-verification-notes.md` — start here. Falsifies the claims you'd otherwise build on (no `synchronize` GraphQL event; REST submit has no `in_reply_to`; MCP is the only custom-tool path) so the rest of the spec makes sense.
2. `spec/01-vision-and-acceptance.md` — get the why
3. `spec/02-architecture.md` — get the stack
4. `spec/03-poc-features.md` — get the what
5. `spec/04-ai-seam-architecture.md` — understand the seams you have to put in (no AI is built in PoC, but the seams are required)
6. `spec/05-non-goals.md` — fight scope creep
7. `claude-design-prompt.md` — generate the visuals

**"I'm planning v2."**
1. `spec/00-verification-notes.md` — the falsifications inform every architectural call in the backlog (especially P0-7 MCP, P2-2 chat).
2. `backlog/00-priority-methodology.md` — understand priorities
3. `backlog/01-P0-foundations.md` — what unblocks everything
4. `backlog/02-P1-core-ai.md` and `03-P2-extended-ai.md` — the AI roadmap
5. Then `05-P4-polish.md`

**"I just want to understand what this tool is."**
1. `spec/01-vision-and-acceptance.md` — that's it.

---

## Conventions used in these docs

- **Seam** = an interface or extension point in the PoC that exists specifically so v2 features can plug in without refactoring `PRism.Core`.
- **Slot** = a frontend component placeholder, capability-flag-gated, that renders nothing in PoC and is filled by v2 features.
- **PoC** = the initial proof-of-concept release. Single user, local, GitHub-only, no AI features built (but AI seams in place).
- **v2** = the next major release that lights up the AI seams and may add multi-platform.
