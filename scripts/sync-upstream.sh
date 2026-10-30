#!/usr/bin/env bash
set -euo pipefail

target=${1:-upstream/main}
before=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Sync requires a clean checkout; existing changes were left untouched." >&2
  exit 1
fi
if git merge-base --is-ancestor "$target" HEAD; then
  echo "Already up to date with $target."
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo 'changed=false' >> "$GITHUB_OUTPUT"; fi
  exit 0
fi

# Keep a merge pending so workflow conflicts can be resolved before committing.
if ! git merge --no-ff --no-commit "$target"; then
  git rev-parse --verify MERGE_HEAD >/dev/null 2>&1 || exit 1
fi

# This fork owns its CI; restore even workflows deleted by the fork or upstream.
while IFS= read -r -d '' path; do
  git rm -f -- "$path"
done < <(git diff --name-only --diff-filter=U -z -- .github/workflows)
git restore --source="$before" --staged --worktree -- .github/workflows

conflicts=$(git diff --name-only --diff-filter=U)
if [[ -n "$conflicts" ]]; then
  printf 'Unresolved source conflicts (no changes pushed):\n%s\n' "$conflicts" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo '### Upstream sync needs conflict resolution'
      echo 'The existing branch and published releases are unchanged. Resolve these files before retrying:'
      echo '```text'
      printf '%s\n' "$conflicts"
      echo '```'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  git merge --abort
  exit 1
fi

git commit -m 'chore: sync upstream'
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then echo 'changed=true' >> "$GITHUB_OUTPUT"; fi
