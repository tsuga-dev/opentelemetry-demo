#!/usr/bin/env bash
# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail

# Keep the `faulty` branch up to date with `main` (which carries upstream syncs)
# WITHOUT discarding the regression commits that make `faulty` faulty.
#
# We MERGE main into faulty (never rebase): the faulty commits are preserved and
# only conflict where upstream changed the exact lines a regression touches.
# A merge needs no force-push, so it works with branch protection on `faulty`.
#
# Run this AFTER scripts/cherrypick-upstream.sh has landed upstream on main.

# ---- config via env ----
: "${BASE_BRANCH:=main}"          # source of upstream changes to pull in
: "${FAULTY_BRANCH:=faulty}"      # branch carrying the regressions (PR base)
# Prefix only; the working branch is ${SYNC_BRANCH}-YYYY-MM-DD (local date).
: "${SYNC_BRANCH:=sync/faulty}"

today="$(date +%Y-%m-%d)"
HEAD_BRANCH="${SYNC_BRANCH}-${today}"

# ---- safety: don't run mid-merge ----
GIT_DIR="$(git rev-parse --git-dir)"
if [ -f "${GIT_DIR}/MERGE_HEAD" ]; then
  echo "A merge is already in progress on this checkout. Resolve it first:"
  echo "  git status; git add <files>; git merge --continue   # or --abort"
  echo "Then re-run this script to push and open the PR."
  exit 2
fi

git fetch --prune origin

# ---- checkout dated sync branch ----
# If we're already on it (resuming after conflict resolution), don't reset it.
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${current_branch}" = "${HEAD_BRANCH}" ]; then
  echo "Already on '${HEAD_BRANCH}', resuming..."
elif git show-ref --verify --quiet "refs/remotes/origin/${HEAD_BRANCH}"; then
  git checkout -B "${HEAD_BRANCH}" "origin/${HEAD_BRANCH}"
else
  git checkout -B "${HEAD_BRANCH}" "origin/${FAULTY_BRANCH}"
fi

new_commits="$(git rev-list --count "HEAD..origin/${BASE_BRANCH}")"
unpushed="$(git rev-list --count "origin/${FAULTY_BRANCH}..HEAD")"

if [ "${new_commits}" -eq 0 ] && [ "${unpushed}" -eq 0 ]; then
  echo "No new ${BASE_BRANCH} commits to merge into ${FAULTY_BRANCH}."
  exit 0
fi

merge_succeeded=false
if [ "${new_commits}" -gt 0 ]; then
  echo "Merging ${new_commits} new commit(s) from '${BASE_BRANCH}' into '${HEAD_BRANCH}'..."
  if ! git merge "origin/${BASE_BRANCH}" --no-edit \
        -m "chore: merge ${BASE_BRANCH} into ${FAULTY_BRANCH}"; then
    echo ""
    echo "Merge conflict detected. These are spots where an upstream change overlaps"
    echo "a regression. Resolve KEEPING the faulty behavior, then:"
    echo "  git add <files>; git merge --continue"
    echo "Then re-run this script to push and open the PR."
    exit 1
  fi
  merge_succeeded=true
fi

# ---- push + open/update PR into faulty ----
git push -u origin "${HEAD_BRANCH}"

total_applied="$(git rev-list --count "origin/${FAULTY_BRANCH}..HEAD")"
pr_title="chore: sync ${BASE_BRANCH} into ${FAULTY_BRANCH} ${today}"
pr_body="Merges ${total_applied} commit(s) from \`${BASE_BRANCH}\` into \`${FAULTY_BRANCH}\`, keeping the regression commits intact."

existing_pr="$(gh pr list --head "${HEAD_BRANCH}" --base "${FAULTY_BRANCH}" --json number --jq '.[0].number' 2>/dev/null || true)"
if [ -n "${existing_pr}" ]; then
  gh pr edit "${existing_pr}" --title "${pr_title}" --body "${pr_body}"
  gh pr view "${existing_pr}" --json url --jq '"PR: " + .url'
else
  gh pr create --head "${HEAD_BRANCH}" --base "${FAULTY_BRANCH}" --title "${pr_title}" --body "${pr_body}"
fi
