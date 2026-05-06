# PRism Validation — Open a Sample PR

You are Claude Code helping validate **PRism**, a PR review tool currently in development. Your task is to open a small, low-risk dummy pull request against a Mindbody repository so the validation team can observe the resulting PR, review activity, and iteration cycle inside PRism.

This run is fully automated. When you finish, print the PR URL and stop. Do not offer follow-up actions.

---

## 1. Resolve the target repo

The user should have included a target repo identifier in their message. Accept any of:

- A short slug from the canonical five (table below)
- A full URL: `https://github.com/<owner>/<repo>`
- An `owner/repo` string

| Slug | Repo |
|---|---|
| `chat-bff` | `mindbody/Mindbody.BizApp.Chat.Bff` |
| `chat-agent-appointments` | `mindbody/Mindbody.BizApp.Chat.Agent.Appointments` |
| `api-codex` | `mindbody/Api.Codex` |
| `bizapp-bff` | `mindbody/Mindbody.BizApp.Bff` |
| `mobile-business-gateway` | `mindbody/Mindbody.Mobile.BusinessGateway` |

Resolve into two variables you'll use throughout:

- `OWNER_REPO` — e.g., `mindbody/Mindbody.BizApp.Chat.Bff`
- `SLUG` — slug from the table, or a kebab-case derivative for repos outside the five

If no target was provided, ask once: *"Which repo should I target? Provide a slug or `owner/repo`."* Then proceed.

---

## 2. Bootstrap

Run these checks before doing any git work. If any fails, follow the recovery path inline.

> **Shell:** all commands below assume POSIX shell. On Windows, use the Bash tool (Git Bash). Do **not** translate them into PowerShell — `$()`, `[ ... ]`, and the `--jq` syntax don't survive the translation cleanly.

### 2a. Defeat MSYS path conversion (Windows + Git Bash)

```bash
export MSYS_NO_PATHCONV=1
```

Harmless on macOS/Linux. Skip on PowerShell. Without this, `gh api repos/...` calls in Git Bash on Windows are silently rewritten to filesystem paths and fail with confusing 404s.

### 2b. Verify `gh` and `git` are present

```bash
gh --version
git --version
```

If `gh` is missing, print the install command for the detected OS and exit:
- Windows: `winget install --id GitHub.cli`
- macOS: `brew install gh`
- Linux: see https://github.com/cli/cli/blob/trunk/docs/install_linux.md

### 2c. Verify auth + scopes

```bash
gh auth status
```

If not authenticated, run `gh auth login --web --git-protocol https` and let the user complete the browser flow.

If the active token is missing the `repo` scope, run:

```bash
gh auth refresh -h github.com -s repo,workflow,read:org
```

### 2d. Configure git identity from the gh user

```bash
GH_LOGIN=$(gh api user --jq '.login')
GH_NAME=$(gh api user --jq '.name // .login')
GH_EMAIL=$(gh api "users/$GH_LOGIN" --jq '.email // empty')
[ -z "$GH_EMAIL" ] && GH_EMAIL="${GH_LOGIN}@users.noreply.github.com"
git config --global user.name "$GH_NAME"
git config --global user.email "$GH_EMAIL"
```

### 2e. Confirm read access to the target repo

```bash
gh api "repos/$OWNER_REPO" --jq '.full_name'
```

If this 404s despite a healthy `repo` scope, the most common cause is **SAML/SSO authorization not granted for the org**. Extract the org from `OWNER_REPO` (the part before `/`) and print:

> Cannot access `$OWNER_REPO`. If you're an org member, your GitHub PAT likely needs SAML/SSO authorization for that org.
> Visit `https://github.com/orgs/${OWNER_REPO%%/*}/sso`, authorize the listed token, and re-run this prompt.

Then exit.

### 2f. Confirm `prism-validation` branch exists on the remote

```bash
gh api "repos/$OWNER_REPO/git/refs/heads/prism-validation"
```

If this 404s, **do not auto-create the branch.** Exit with:

> The `prism-validation` sandbox branch is missing on `$OWNER_REPO`. Ask Pratyush to recreate it before continuing.

This is intentional: only the validation owner creates sandbox branches, never a teammate's run.

---

## 3. Workspace + checkout

Use a stable per-repo workspace under the user's home directory. Reuse if possible; rebuild if corrupt.

```bash
WORK_DIR="$HOME/prism-validation/$SLUG"

if [ -d "$WORK_DIR/.git" ]; then
  cd "$WORK_DIR"
  git fetch origin prism-validation
  git checkout prism-validation
  git reset --hard origin/prism-validation
  git clean -fd
else
  mkdir -p "$HOME/prism-validation"
  rm -rf "$WORK_DIR"   # in case of a non-git directory at the path
  cd "$HOME/prism-validation"
  gh repo clone "$OWNER_REPO" "$SLUG" -- --branch prism-validation --single-branch --depth 50
  cd "$SLUG"
fi
```

The shallow, single-branch clone is intentional — `prism-validation` is the only branch we ever care about, and a 50-commit depth is plenty for blame/log lookups in step 5.

---

## 4. Create a unique feature branch

Second-grained timestamp guarantees uniqueness across simultaneous teammate runs:

> **Why `validation/...` and not `prism-validation/...`:** Git stores refs as files in `.git/refs/heads/`. Once a local `prism-validation` ref-file exists (it does, after step 3), Git refuses to create any ref *under* a `prism-validation/` directory because the file blocks the directory. The base branch keeps the name `prism-validation`; feature branches live under the disjoint `validation/` namespace.

```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
FEATURE_BRANCH="validation/${SLUG}-${TIMESTAMP}"

# Rare-collision protection (e.g., two simultaneous runs in the same second)
COUNTER=2
CANDIDATE="$FEATURE_BRANCH"
while git ls-remote --exit-code origin "refs/heads/$CANDIDATE" >/dev/null 2>&1; do
  CANDIDATE="${FEATURE_BRANCH}-${COUNTER}"
  COUNTER=$((COUNTER + 1))
done
FEATURE_BRANCH="$CANDIDATE"

git checkout -b "$FEATURE_BRANCH"
```

---

## 5. Detect language and pick a recipe

```bash
if find . -name "*.csproj" -type f -not -path "./.git/*" 2>/dev/null | head -1 | grep -q .; then
  CATALOG="csharp"
elif find . -name "*.md" -type f -not -path "./.git/*" 2>/dev/null | head -1 | grep -q .; then
  CATALOG="markdown"
else
  echo "Could not determine catalog (no *.csproj or *.md files found). Aborting."
  exit 1
fi

# Force base-10: bash treats leading-zero numerics (08, 09) as octal otherwise.
RECIPE_INDEX=$(( 10#$(date +%S) % 5 ))
```

### `csharp` catalog (additive, content-only, never breaks compilation)

| Index | Recipe name | What to do |
|---|---|---|
| 0 | `stale-todo` | Append `// TODO: revisit before next release` to a doc-comment block of an existing public method. |
| 1 | `vague-log-message` | Add a new `_logger.LogDebug("processing");` (or similar) line near the top of an existing method body. If no logger field exists in the chosen file, fall through to the next recipe. |
| 2 | `naming-drift-comment` | Add a single-line comment that references a method by a slightly-wrong name (e.g., `// see GetUserDetails` when the actual method is `FetchUserDetails`). |
| 3 | `redundant-xml-doc` | Add `/// <summary>Does what the name says.</summary>` immediately above an existing public method. |
| 4 | `hardcoded-literal` | Add a `private const string PlaceholderUrl = "https://example.test/api";` field inside an existing class. |

### `markdown` catalog

| Index | Recipe name | What to do |
|---|---|---|
| 0 | `frontmatter-typo` | Change `description:` to `descrption:` in the frontmatter of an existing skill or doc `.md` file. |
| 1 | `broken-internal-link` | Append a markdown link `[see also](./does-not-exist.md)` to an existing doc. |
| 2 | `skipped-heading` | Add a section that goes from `# H1` directly to `### H3`. |
| 3 | `vague-tbd` | Append a section `## Examples\n\nTBD` to an existing doc. |
| 4 | `unlabeled-code-fence` | Add a small code fence with no language hint (just bare ` ``` `). |

Set `RECIPE_NAME` to the chosen recipe's name (e.g., `stale-todo`).

---

## 6. Pick a target file and apply the recipe

### Hard rules — never violate

- **Never modify** `*.csproj`, `*.sln`, `*.props`, `*.targets`, `Dockerfile*`, anything under `.github/`, `appsettings*.json`, `Program.cs`, or `Startup.cs`.
- **Never modify** a file with **>5 commits in the last 30 days**. Check with:
  ```bash
  count=$(git log --since="30 days ago" --oneline -- "$candidate" | wc -l)
  ```
  Skip if `count > 5`.
- **Pick small files**: under ~200 lines for `.cs`, under ~100 lines for `.md`.
- **Pick low-importance files**: prefer `tests/`, `docs/`, `samples/`, helpers, models, or anything visibly off the hot path. Avoid controllers, middleware, and DI registration.

### Selection process

1. List candidate files of the right extension under the working tree.
2. Filter out anything matching the never-modify list above.
3. Filter out high-traffic files using the 30-day commit count rule.
4. Filter out files that don't structurally fit the chosen recipe (e.g., the `vague-log-message` recipe needs a file with an existing logger field; `redundant-xml-doc` needs a public method).
5. From what remains, pick one.
6. If no file fits, rotate to the next recipe: `RECIPE_INDEX=$(( (RECIPE_INDEX + 1) % 5 ))`, **then re-derive `RECIPE_NAME` from the catalog table at the new index** (otherwise step 7 commits with a stale label), and retry. After 5 unsuccessful rotations, abort with a clear message.

### Apply the change

Make the change inline using your editing tools. Constraints:
- Purely additive: do not delete or replace existing logic. Add new lines around or inside existing constructs.
- Diff should be ≤5 lines added, 0 lines removed (with the exception of `frontmatter-typo`, which is a single-character substitution on one line).
- **Never run `dotnet build` or `dotnet test`.** These changes are content-only and the build is heavy. If your change required structural code (which it shouldn't), you picked the wrong target — abort and re-pick.

---

## 7. Commit, push, open the PR

```bash
git add -A
git commit -m "validation: $RECIPE_NAME"
git push -u origin "$FEATURE_BRANCH"

PR_URL=$(gh pr create \
  --repo "$OWNER_REPO" \
  --base prism-validation \
  --head "$FEATURE_BRANCH" \
  --title "validation: $RECIPE_NAME ($(date +%Y-%m-%d))" \
  --body "$(cat <<'EOF'
This is an automated **PRism validation harness PR**. Do not merge.

It exists solely to generate review activity for PRism, a PR review tool currently in development.

- Sandbox base branch: `prism-validation`
- Owner: Pratyush Pande (pratyush.pande@playlist.com)
- Cleanup: closed in bulk during the next validation cycle reset.

If you found this PR by accident, feel free to leave it alone.
EOF
)")
```

Apply the `prism-validation` label, creating it on the repo if it doesn't already exist:

```bash
gh label create prism-validation \
  --repo "$OWNER_REPO" \
  --color FFD60A \
  --description "Automated PRism validation harness — do not merge" \
  >/dev/null 2>&1 || true

PR_NUMBER=$(echo "$PR_URL" | grep -oE '[0-9]+$')
gh pr edit "$PR_NUMBER" --repo "$OWNER_REPO" --add-label prism-validation >/dev/null
```

---

## 8. Done

Print one line and stop:

```
Validation PR opened: <PR_URL>
```

Do not run anything else. Do not propose iterating, reviewing, merging, or cleaning up. The validation team will drive the rest from PRism.

---

## Hard constraints (reiterated)

1. PRs always target `prism-validation`. Never `main`. Never `master`. Never any other branch.
2. Never push to `main` or `master`. Never delete or recreate `prism-validation`.
3. Recipes are additive content changes only. Compilation must continue to succeed.
4. Never run `dotnet build`, `dotnet test`, `npm install`, or any other heavy build/test command.
5. Never modify `*.csproj`, `*.sln`, Dockerfiles, `.github/` files, `appsettings.json`, `Program.cs`, `Startup.cs`.
6. Re-running this prompt produces a brand-new PR with a fresh timestamp branch and (usually) a different recipe.
7. If anything fails, exit with a clear message. Do not retry destructively.

## Troubleshooting cheat sheet

| Symptom | Action |
|---|---|
| `gh` not installed | OS-appropriate install command, exit. |
| `gh` not authed | `gh auth login --web --git-protocol https`, retry once. |
| Token missing `repo` scope | `gh auth refresh -h github.com -s repo,workflow,read:org`. |
| 404 reading repo despite `repo` scope | Likely SAML/SSO; print org SSO URL and exit. |
| `prism-validation` branch missing on remote | Exit, ask Pratyush to recreate. Never self-heal. |
| Workspace dir is corrupt (no `.git`) | Wipe and re-clone. |
| Branch name collision in the same second | Suffix `-2`, `-3`, ... |
| `git push` rejected | Retry once; if still rejected, exit with the underlying message. |
| No file fits recipe constraints | Rotate to next recipe; abort after 5 unsuccessful attempts. |
| `find` errors on Windows in PowerShell | You should be in Git Bash or the Bash tool, not PowerShell. Switch shell and re-run. |
