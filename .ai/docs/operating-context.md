# Operating in this repo right now

- Most edits at this stage are feature code, polish, and per-slice design/plan markdown under `docs/specs/` and `docs/plans/`. When a spec change has cross-cutting consequences, search the corpus for the affected term — many spec sections reference each other and `docs/spec/00-verification-notes.md` cross-links throughout.
- `docs/spec-review.md` is transient working notes from adversarial review passes; findings get absorbed into the spec proper. Don't edit it as if it were canonical.
- Claude code review is **opt-in, not automatic.** The `claude.yml` workflow fires only when an issue/PR comment (or an issue body/title) contains `@claude` — opening or pushing a PR does **not** trigger it. To request a bot review, comment `@claude review` on the PR.

## Spec and plan locations

- Per-slice / per-task design docs (output of brainstorming): `docs/specs/YYYY-MM-DD-<topic>-design.md`
- Per-slice / per-task implementation plans (output of writing-plans): `docs/plans/YYYY-MM-DD-<topic>.md`

These paths override the default `docs/superpowers/specs/` and `docs/superpowers/plans/` locations baked into the superpowers skills. The `docs/superpowers/` subtree no longer exists. Specs and plans live flat under `docs/` so other AI tools and contributors find them without traversing a tooling-specific subdirectory.
