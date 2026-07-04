#!/usr/bin/env bash
#
# Render human-readable release notes from the `github/copilot-release-notes`
# Action's `release-notes-json` output (a JSON array of
# `{description, pr, author, tag}` entries).
#
# WHY we render this ourselves instead of using the Action's built-in
# `release-notes` markdown output: that renderer is a FIXED template
# (`### <tag>` headings + an auto-appended `(#pr)` per bullet, and no slot for
# an overview paragraph — see dist/index.js `formatAsMarkdown`). Rendering from
# the structured JSON — which the Action exposes for exactly this purpose — lets
# us:
#   - print a top OVERVIEW paragraph (the model emits it as an entry tagged
#     "Overview"; we lift it out and render it as prose, not a bullet),
#   - use `##` section headings and preserve the author's significance order,
#   - append the PR reference EXACTLY once (the style guide tells the model not
#     to put `(#123)` in the description, so there is no double reference).
#
# Contract (all inputs via environment — never interpolated into a shell
# command, so untrusted Copilot/PR-derived text cannot inject):
#   RELEASE_NOTES_JSON  the Action's `release-notes-json` output (may be empty)
#   BASE                base ref for the Full Changelog compare link (optional)
#   TAG                 head ref / release tag for the compare link (optional)
#   GITHUB_SERVER_URL   e.g. https://github.com   (provided by the runner)
#   GITHUB_REPOSITORY   e.g. owner/repo           (provided by the runner)
#
# Writes the assembled markdown body to stdout. Emits NOTHING (empty stdout,
# exit 0) when there are no entries, so the caller can detect "no Copilot notes"
# and fall back to GitHub's auto-generated notes (publish) or fail without
# clobbering an existing body (refresh).
set -euo pipefail

json="${RELEASE_NOTES_JSON:-}"

# No JSON, or not a non-empty array -> no notes. Emit nothing; caller decides.
if [ -z "$json" ] || ! printf '%s' "$json" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
  exit 0
fi

# A single jq program builds the whole body from the entries array:
#   1. lift the "Overview"-tagged entry to a leading paragraph (drop its ref),
#   2. group the rest under `## <tag>` in first-appearance (significance) order,
#   3. append `(#pr)` once per bullet, and only for a real (positive) PR number,
#   4. add a single Full Changelog compare link when a base ref is known.
printf '%s' "$json" | jq -r \
  --arg base "${BASE:-}" \
  --arg tag "${TAG:-}" \
  --arg server "${GITHUB_SERVER_URL:-https://github.com}" \
  --arg repo "${GITHUB_REPOSITORY:-}" '
  # Is this entry the overview? (tag == "Overview", tolerant of case/space.)
  def is_overview: (.tag // "") | ascii_downcase | test("^\\s*overview\\s*$");
  # One rendered bullet. The PR ref is appended here, exactly once, and only
  # when the entry carries a real positive PR number.
  def bullet: "- \(.description)\(if ((.pr // 0) > 0) then " (#\(.pr))" else "" end)";

  . as $entries
  | ([ $entries[] | select(is_overview) ][0].description // "") as $overview
  # Distinct non-overview tags in first-appearance order (jq `unique` sorts, so
  # build the ordered set by hand; `== null` handles a match at index 0).
  | ([ $entries[] | (.tag // "") | select(. != "" and ((ascii_downcase | test("^\\s*overview\\s*$")) | not)) ]
      | reduce .[] as $t ([]; if index($t) == null then . + [$t] else . end)) as $tags
  | ([ $entries[] | select((.tag // "") == "" and (is_overview | not)) ]) as $untagged
  | (
      (if $overview != "" then [$overview, ""] else [] end)
      + ($tags | map(. as $t
          | (["## " + $t, ""]
             + [ $entries[] | select((.tag // "") == $t) | bullet ]
             + [""])) | add // [])
      + (if ($untagged | length) > 0
         then ([ $untagged[] | bullet ] + [""])
         else [] end)
    )
  | (join("\n") | sub("\n+$"; ""))
  + (if $base != "" and $tag != ""
     then "\n\n**Full Changelog**: " + $server + "/" + $repo + "/compare/" + $base + "..." + $tag
     else "" end)
'
