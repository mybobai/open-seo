#!/usr/bin/env bash
# Altys fork: bring in new upstream OpenSEO commits and deploy them.
#
# Fast-forwards the `upstream` branch to every-app/main, rebases `main` onto
# it, and after confirmation force-pushes `main`, which deploys
# seo.mybobai.com through GitHub Actions.
#
# The fork runs only its own deploy workflow. Files it deleted (the upstream
# workflows) conflict whenever upstream edits them; those conflicts are
# resolved by deleting the file again, and workflows upstream adds are removed
# in a new commit. Any other conflict stops the script with the rebase left
# in progress.
#
# Written for macOS's bash 3.2: no arrays or mapfile.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "Commit or stash your changes first." >&2
  exit 1
fi

# `git fetch` refuses to move the checked-out branch.
git checkout -q main

old_upstream=$(git rev-parse upstream)
# Paths main deleted relative to upstream, read before upstream moves.
fork_deleted=$(
  git diff --name-only --diff-filter=D "$(git merge-base main upstream)" main
)

git fetch every-app
# Fails rather than overwrite if upstream has local commits.
git fetch . every-app/main:upstream

if [[ "$(git rev-parse upstream)" == "$old_upstream" ]]; then
  echo "Already up to date with every-app/main."
  exit 0
fi

echo "New upstream commits:"
git log --oneline "$old_upstream..upstream"
echo

stop_rebase() {
  echo >&2
  echo "$1 Fix it, run 'git rebase --continue', then push with" >&2
  echo "'git push --force-with-lease origin main'." >&2
  exit 1
}

if ! git rebase upstream; then
  while true; do
    conflicts=$(git diff --name-only --diff-filter=U)
    if [[ -z "$conflicts" ]]; then
      stop_rebase "The rebase stopped without a conflict."
    fi
    while IFS= read -r path; do
      if ! grep -qxF -- "$path" <<<"$fork_deleted"; then
        stop_rebase "Conflict in $path needs a manual fix."
      fi
      echo "Keeping $path deleted (removed in this fork)."
      git rm -q -- "$path"
    done <<<"$conflicts"
    if GIT_EDITOR=true git rebase --continue; then
      break
    fi
  done
fi

# Upstream workflows would run in this fork; it keeps only deploy.yml.
new_workflows=$(
  git diff --name-only --diff-filter=A "$old_upstream" upstream -- .github/workflows
)
if [[ -n "$new_workflows" ]]; then
  echo
  echo "Removing new upstream workflows:"
  echo "$new_workflows" | sed 's/^/  /'
  while IFS= read -r path; do
    git rm -q -- "$path"
  done <<<"$new_workflows"
  git commit -q -m "Remove upstream workflows added in $(git rev-parse --short upstream)"
fi

echo
read -r -p "Push main and deploy seo.mybobai.com? [y/N] " answer
if [[ "$answer" != "y" ]]; then
  echo "Not pushed. Push later with: git push --force-with-lease origin main"
  exit 0
fi
git push --force-with-lease origin main
echo "Pushed. Deploy: https://github.com/mybobai/open-seo/actions"
