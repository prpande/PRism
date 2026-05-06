# PRism Validation — Act as a Second Reviewer

You are Claude Code helping validate **PRism** by posting a small review pass on an existing validation PR. The goal is to add comment-author diversity to the PR — beyond the original PR author and the auto-reviewer bot — so PRism sees realistic multi-voice review threads.

This run is fully automated. When you finish, print a one-line summary and stop.

> **Cloud-env identity caveat.** Currently runs under Pratyush's `prpande` identity (Option A in the design). All comment bodies must be prefixed with `[cloud-env] ` so the validation team can visually distinguish this activity from manual driving. When a separate bot identity is provisioned (Option B), the prefix can be removed in a single edit.
>
> **Hard rule:** this prompt **never** approves and **never** requests changes. Only `Comment` verdict, ever.

---

## 1. Resolve the target repo

Same rules as the other prompts. Accept slug, full URL, or `owner/repo`.

| Slug | Repo |
|---|---|
| `chat-bff` | `mindbody/Mindbody.BizApp.Chat.Bff` |
| `chat-agent-appointments` | `mindbody/Mindbody.BizApp.Chat.Agent.Appointments` |
| `api-codex` | `mindbody/Api.Codex` |
| `bizapp-bff` | `mindbody/Mindbody.BizApp.Bff` |
| `mobile-business-gateway` | `mindbody/Mindbody.Mobile.BusinessGateway` |

Resolve to `OWNER_REPO`. If not provided, ask once.

---

## 2. Bootstrap

Identical to the other two prompts:

> **Shell:** all commands below assume POSIX shell. On Windows, use the Bash tool (Git Bash), not PowerShell.

```bash
export MSYS_NO_PATHCONV=1
gh --version && git --version
gh auth status
# gh auth login --web --git-protocol https            # if not authed
# gh auth refresh -s repo,workflow,read:org           # if scope missing

GH_LOGIN=$(gh api user --jq '.login')
gh api "repos/$OWNER_REPO" --jq '.full_name' >/dev/null
```

Save `GH_LOGIN` for the dedup logic in step 4.

> No working directory or git clone is needed for this prompt — everything happens via `gh api`.

---

## 3. Discover the target PR

```bash
PR_NUMBER=$(gh pr list \
  --repo "$OWNER_REPO" \
  --label prism-validation \
  --state open \
  --json number,updatedAt \
  --jq 'sort_by(.updatedAt) | reverse | .[0].number // empty')
```

Outcomes:

- Empty → exit cleanly: `"No open validation PR on $OWNER_REPO. Run open-validation-pr first."`
- One found → use it.
- Multiple → pick the most recently updated; log all candidate URLs.

Capture the PR's head SHA (you'll need it for the review payload):

```bash
PR_INFO=$(gh pr view "$PR_NUMBER" --repo "$OWNER_REPO" --json headRefOid,url)
HEAD_SHA=$(echo "$PR_INFO" | jq -r '.headRefOid')
PR_URL=$(echo "$PR_INFO" | jq -r '.url')
```

---

## 4. Read the diff and existing comments

Get the diff:

```bash
gh pr diff "$PR_NUMBER" --repo "$OWNER_REPO" > /tmp/pr.diff
```

Get existing inline review comments (so you can avoid duplicates):

```bash
# --paginate is mandatory: dedup at step 5 needs the FULL list of existing
# review comments. The default page size silently truncates at ~30.
gh api --paginate "repos/$OWNER_REPO/pulls/$PR_NUMBER/comments" > /tmp/existing_review_comments.json
```

---

## 5. Generate 1–3 plausible nitpick comments

You will craft 1, 2, or 3 inline review comments to attach to specific lines in the diff. Aim for 2 when the diff supports it. Each comment must:

- Be a **mild, plausible nitpick** — style, naming, "consider extracting to a constant", "this could use a brief comment", "consider clearer log message", "small typo here", etc.
- Pin to a **specific file + line** that appears in the diff (an added line — never an unchanged context line).
- Be prefixed with `[cloud-env] ` in the body.
- Be **non-blocking** in tone. Phrasing like "small thought:", "minor:", "(nit)", "consider...", "perhaps...".
- **Not duplicate** any existing comment in `/tmp/existing_review_comments.json` — compare both `path` + `line` and the comment body's substring overlap. If a similar nitpick already exists, pick a different line or skip.

Hard rules:

- Never request changes. Never approve.
- Never demand a fix. Suggestions only.
- Never reference internal Mindbody systems, business logic, or production data — you don't have context for those.
- Never make a comment that requires the author to have access to information you don't have. Stick to the diff itself.

If the diff is too small to support 2 plausible nitpicks (e.g., a one-character frontmatter typo fix), 1 is fine. If you can't find even 1, exit cleanly with `"Diff doesn't support a meaningful nitpick. Skipping."`

### Building the review payload

The GitHub API expects a single review payload with all inline comments attached. Build it as JSON:

```json
{
  "commit_id": "<HEAD_SHA>",
  "event": "COMMENT",
  "body": "[cloud-env] A few small nits. Non-blocking.",
  "comments": [
    {
      "path": "<file path relative to repo root>",
      "line": <line number in the file as of HEAD_SHA>,
      "side": "RIGHT",
      "body": "[cloud-env] (nit) consider extracting this URL to a config value."
    },
    {
      "path": "...",
      "line": ...,
      "side": "RIGHT",
      "body": "[cloud-env] minor: variable name could be more descriptive."
    }
  ]
}
```

`side: "RIGHT"` pins the comment to the new (post-change) version of the line. Use `LEFT` only if you genuinely want to comment on a removed line, which is rare for our nitpicks.

---

## 6. Submit the review

Atomically — one API call, one review record, all comments attached.

**Use your file-writing tool** (Write, not bash heredoc) to write the JSON object you constructed in step 5 to `$PAYLOAD_FILE` — bash heredocs around inline JSON with mixed quoting are fragile. Then run the API call:

```bash
PAYLOAD_FILE=$(mktemp)
# (You — the LLM — must now write the JSON payload from step 5 to $PAYLOAD_FILE
# via your Write tool before continuing. Do NOT skip this step. The mktemp
# above only creates an empty file; POSTing it without writing the JSON
# yields a 422.)

REVIEW_RESULT=$(gh api -X POST "repos/$OWNER_REPO/pulls/$PR_NUMBER/reviews" \
  --input "$PAYLOAD_FILE")

REVIEW_ID=$(echo "$REVIEW_RESULT" | jq -r '.id')
REVIEW_HTML_URL=$(echo "$REVIEW_RESULT" | jq -r '.html_url // .pull_request_url')
```

If the API call fails:

- **422 with "commit_id"-related error** → `HEAD_SHA` is stale (someone pushed since step 3). Re-fetch the PR, refresh `HEAD_SHA` and the diff, regenerate the comments against the new diff (line numbers may have shifted), and retry once.
- **422 with "path"/"line" error** → one of your line/path picks doesn't actually exist in the diff. Drop the offending entry from `comments[]` and retry once.
- **Anything else** → exit with the underlying error message.

---

## 7. Done

Print one summary line:

```
Posted review on $PR_URL: N inline comments, Comment verdict. [cloud-env]
```

Stop. Do not propose further actions.

---

## Hard constraints (reiterated)

1. Only operate on PRs labeled `prism-validation` and targeting `prism-validation`.
2. **Never `Approve`. Never `RequestChanges`. Only `Comment`.**
3. Every comment body is prefixed with `[cloud-env] ` (until Option B).
4. Comments must pin to actual diff lines and avoid duplicating existing comments.
5. 1–3 nitpicks per run (aim for 2). 0 plausible nitpicks = exit clean.
6. Never speculate about business logic, production data, or systems beyond the diff itself.
7. Atomic submit: one `gh api -X POST .../reviews` call, comments attached inline.

## Troubleshooting cheat sheet

| Symptom | Action |
|---|---|
| No open validation PR | Exit clean: "Run open-validation-pr first." |
| Multiple open validation PRs | Pick most recently updated; log all candidates. |
| Diff too small for nitpicks | Post 1 if possible; otherwise exit clean. |
| Existing review already covers your nitpicks | Pick different lines or skip. |
| `commit_id` 422 (stale HEAD) | Refresh and retry once. |
| `path`/`line` 422 | Drop bad entry, retry once. |
| Rate limit | Print reset time, exit. |
