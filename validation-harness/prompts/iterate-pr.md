# PRism Validation — Iterate on a Validation PR

You are Claude Code helping validate **PRism** by pushing a small follow-up commit and threaded replies on an existing validation PR. This exercises the iteration / banner-on-remote-change flow inside PRism.

This run is fully automated. When you finish, print a one-line summary and stop.

> **Cloud-env identity caveat.** This prompt is intended to run primarily from Claude Cloud under Pratyush's `prpande` identity (Option A in the design). All commit messages and reply bodies must include the `[cloud-env]` marker so the validation team can visually distinguish this activity from manual driving. When a separate bot identity is provisioned (Option B), the marker can be removed in a single edit.

---

## 1. Resolve the target repo

Same rules as `open-validation-pr.md`. Accept a slug, full URL, or `owner/repo`. Use the canonical slug table:

| Slug | Repo |
|---|---|
| `chat-bff` | `mindbody/Mindbody.BizApp.Chat.Bff` |
| `chat-agent-appointments` | `mindbody/Mindbody.BizApp.Chat.Agent.Appointments` |
| `api-codex` | `mindbody/Api.Codex` |
| `bizapp-bff` | `mindbody/Mindbody.BizApp.Bff` |
| `mobile-business-gateway` | `mindbody/Mindbody.Mobile.BusinessGateway` |

Resolve to `OWNER_REPO` and `SLUG`. If not provided, ask once.

---

## 2. Bootstrap

Identical to `open-validation-pr.md` step 2. In short:

> **Shell:** all commands below assume POSIX shell. On Windows, use the Bash tool (Git Bash), not PowerShell.

```bash
export MSYS_NO_PATHCONV=1                       # Git Bash on Windows only
gh --version && git --version                   # exit with install hint if missing
gh auth status                                  # gh auth login --web if not authed
                                                # gh auth refresh -s repo,workflow,read:org if scope missing
# Set git identity from gh user
GH_LOGIN=$(gh api user --jq '.login')
GH_NAME=$(gh api user --jq '.name // .login')
GH_EMAIL=$(gh api "users/$GH_LOGIN" --jq '.email // empty')
[ -z "$GH_EMAIL" ] && GH_EMAIL="${GH_LOGIN}@users.noreply.github.com"
git config --global user.name "$GH_NAME"
git config --global user.email "$GH_EMAIL"
# Confirm read access. On 404 the most common cause is SAML/SSO not authorized for the org;
# the message tells the user how to recover. Do NOT swallow this error silently.
gh api "repos/$OWNER_REPO" --jq '.full_name' >/dev/null 2>&1 || {
  echo "Cannot access $OWNER_REPO. If you're an org member, your GitHub PAT likely needs SAML/SSO authorization for that org."
  echo "Visit https://github.com/orgs/${OWNER_REPO%%/*}/sso, authorize the listed token, and re-run this prompt."
  exit 1
}
```

Save `GH_LOGIN` for the dedup logic in step 5.

---

## 3. Discover the target PR

Find the most recently updated open validation PR on this repo:

```bash
PR_NUMBER=$(gh pr list \
  --repo "$OWNER_REPO" \
  --label prism-validation \
  --state open \
  --json number,updatedAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0].number // empty')
```

Possible outcomes:

- **Empty** (no open validation PR): exit cleanly with `"No open validation PR on $OWNER_REPO. Run open-validation-pr first."` Do not proceed.
- **One found**: use it.
- **Multiple found**: `gh pr list` already returned them sorted; use the most recently updated one. Print the full list of candidate URLs as informational output before proceeding, so the user can see what was skipped.

Capture the PR's head branch and SHA:

```bash
PR_INFO=$(gh pr view "$PR_NUMBER" --repo "$OWNER_REPO" --json headRefName,headRefOid,url,author)
HEAD_BRANCH=$(echo "$PR_INFO" | jq -r '.headRefName')
PR_URL=$(echo "$PR_INFO" | jq -r '.url')
```

---

## 4. Workspace + checkout the PR's head branch

```bash
WORK_DIR="$HOME/prism-validation/$SLUG"

if [ -d "$WORK_DIR/.git" ]; then
  cd "$WORK_DIR"
else
  mkdir -p "$HOME/prism-validation"
  rm -rf "$WORK_DIR"
  cd "$HOME/prism-validation"
  gh repo clone "$OWNER_REPO" "$SLUG" -- --branch "$HEAD_BRANCH" --single-branch --depth 50
  cd "$SLUG"
fi

# Use an explicit refspec — works even if the existing clone is single-branch
# on a different branch (common when the workspace was created by open-validation-pr).
git fetch origin "+refs/heads/$HEAD_BRANCH:refs/remotes/origin/$HEAD_BRANCH"
git checkout -B "$HEAD_BRANCH" "refs/remotes/origin/$HEAD_BRANCH"
git reset --hard "refs/remotes/origin/$HEAD_BRANCH"
git clean -fd
```

If `git fetch` fails because the branch was deleted upstream, exit with `"PR head branch $HEAD_BRANCH no longer exists on $OWNER_REPO."`

---

## 5. Read review activity and pick actionable, unanswered comments

Pull every kind of comment on the PR:

```bash
# --paginate is mandatory: default page size silently truncates at ~30,
# and the dedup logic below NEEDS the full reply chain to work.

# Issue-style comments on the PR
gh api --paginate "repos/$OWNER_REPO/issues/$PR_NUMBER/comments" > /tmp/issue_comments.json

# Inline review comments (the diff comments)
gh api --paginate "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments" > /tmp/review_comments.json

# Top-level reviews (with their body and verdict)
gh api --paginate "repos/$OWNER_REPO/pulls/$PR_NUMBER/reviews" > /tmp/reviews.json
```

Identify **actionable** items:

- **Inline review comments** are the most actionable — they pin a concrete file + line.
- **Reviews with a body** can also be actionable if they reference specific files or issues.
- **Issue-style comments** are usually less actionable; consider but don't require addressing.

Identify **unanswered** items (dedup):

- For each inline review comment, check whether `$GH_LOGIN` has already replied to it. A reply has a non-null `in_reply_to_id` pointing to the original comment's `id`. Walk the chain: a comment is "answered by current user" if any descendant in `/tmp/review_comments.json` has `user.login == $GH_LOGIN` and an `in_reply_to_id` that resolves back to the original.
- For each top-level review, check whether `$GH_LOGIN` has posted a later review or issue comment that explicitly references it (look for `Addressed in <sha>` text from this user).

Filter to the set of comments that are:
- Authored by someone other than `$GH_LOGIN`
- Not yet answered by `$GH_LOGIN`
- Plausibly actionable (have enough specificity to act on)

Group multiple comments touching the same file into one fix.

If the resulting set is **empty**, print `"Nothing new to address on $PR_URL."` and exit cleanly. This is the idempotent no-op case — re-running with no new activity should print exactly this and stop.

---

## 6. Plan and apply a small fix commit

Hard limits:

- **Diff ≤20 lines added, ≤20 lines removed.**
- No new flaws — the goal is to make review activity look realistic, not to chain validation issues.
- No reverts of prior commits on this branch.
- Same never-modify rules as `open-validation-pr.md` step 6: no `*.csproj`, `*.sln`, Dockerfiles, `.github/` files, `appsettings.json`, `Program.cs`, `Startup.cs`.
- Never run `dotnet build`/`dotnet test`. Stay content-only.

For each addressable comment, make the smallest plausible fix:

- A frontmatter typo → fix the typo.
- A vague log message → make it more specific.
- A redundant XML doc → remove or improve it.
- A hardcoded literal → either remove it or move it into an existing constants/config section (NOT into `appsettings.json`, since that file is on the never-modify list).
- A "consider extracting to a constant" nitpick → extract to a `const` in the same class.
- A "missing language hint on code fence" → add the language hint.
- A broken internal link → either fix the link target or remove the reference.

If a comment is too vague to act on confidently (e.g., "this could be cleaner"), **skip it.** Do not invent a fix. Skipped comments are listed in the final summary as `(skipped: too vague)`.

If after filtering and skipping there's **nothing left to fix**, exit cleanly with the no-op message from step 5.

Stage and commit:

```bash
git add -A
git commit -m "validation: address review feedback [cloud-env]"
NEW_SHA=$(git rev-parse HEAD)
```

Push:

```bash
git push origin "$HEAD_BRANCH"
```

If push is rejected (someone else pushed in the meantime), `git pull --rebase`, resolve trivial conflicts, and retry once. If still rejected, exit with a clear message.

---

## 7. Reply to each addressed thread

For each inline review comment you addressed, post a reply. The GitHub API endpoint is:

```bash
gh api -X POST "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments/$ORIGINAL_COMMENT_ID/replies" \
  -f body="Addressed in $NEW_SHA. [cloud-env]"
```

For top-level reviews you addressed, post an issue-level comment:

```bash
gh api -X POST "repos/$OWNER_REPO/issues/$PR_NUMBER/comments" \
  -f body="Addressed feedback from review #$REVIEW_ID in $NEW_SHA. [cloud-env]"
```

Every reply body **must** end with `[cloud-env]`. This is the sentinel that lets the validation team distinguish cloud-driven activity from manual driving in PRism.

---

## 8. Done

Print one summary line:

```
Iteration on $PR_URL: addressed N comments in $NEW_SHA. Skipped M (too vague). [cloud-env]
```

Stop. Do not propose further actions.

---

## Hard constraints (reiterated)

1. Only operate on PRs labeled `prism-validation` and targeting `prism-validation`.
2. Never push to `main` or `master`. Never push to `prism-validation` directly.
3. Stay content-only. Never run `dotnet build`/`dotnet test`/`npm install`.
4. Never invent a fix for a vague comment. Skip and report.
5. Never introduce a new validation flaw.
6. Every commit message and reply body ends with `[cloud-env]` (until Option B).
7. Idempotent: running with no new activity is a clean no-op.

## Troubleshooting cheat sheet

| Symptom | Action |
|---|---|
| No open validation PR | Exit cleanly: "Run open-validation-pr first." |
| Multiple open validation PRs | Pick most recently updated; log all candidate URLs. |
| PR head branch deleted upstream | Exit with clear message. |
| `git fetch` fails | Retry once, then exit. |
| Push rejected | `git pull --rebase`, resolve trivial conflicts, retry once, then exit. |
| All comments are vague | Exit clean: "Nothing actionable. Skipped N comments as too vague." |
| GitHub API rate limit | Print rate-limit reset time and exit. |
