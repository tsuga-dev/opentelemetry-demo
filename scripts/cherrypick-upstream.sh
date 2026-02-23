#!/usr/bin/env bash
set -euo pipefail

# ---- config via env ----
: "${UPSTREAM_REPO:=open-telemetry/opentelemetry-demo}"
: "${UPSTREAM_BRANCH:=main}"
: "${FORK_BRANCH:=main}"                  # base branch in your fork (PR base)
: "${SYNC_BRANCH:=sync/upstream}"         # PR head branch in your fork

# ---- safety: don't run if a merge is already in progress ----
GIT_DIR="$(git rev-parse --git-dir)"
if [ -f "${GIT_DIR}/MERGE_HEAD" ]; then
  echo "A merge is already in progress on this repo checkout."
  echo "Resolve it first, then run:"
  echo "  git status"
  echo "  git add <files>"
  echo "  git merge --continue   # or --abort"
  echo "Then re-run this script to push and open the PR."
  exit 2
fi

# Ensure remotes exist
if ! git remote get-url upstream >/dev/null 2>&1; then
  git remote add upstream "https://github.com/${UPSTREAM_REPO}.git"
fi

# Fetch latest state from both remotes
git fetch --prune origin
git fetch --prune upstream "${UPSTREAM_BRANCH}"

# ---- checkout sync branch ----
# If we're already on the sync branch (resuming after a conflict resolution),
# do NOT reset it — that would discard the resolved commits.
current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "${current_branch}" = "${SYNC_BRANCH}" ]; then
  echo "Already on '${SYNC_BRANCH}', resuming..."
elif git show-ref --verify --quiet "refs/remotes/origin/${SYNC_BRANCH}"; then
  git checkout -B "${SYNC_BRANCH}" "origin/${SYNC_BRANCH}"
else
  git checkout -B "${SYNC_BRANCH}" "origin/${FORK_BRANCH}"
fi

# Count commits that would be merged
new_commits="$(git rev-list --count "${SYNC_BRANCH}..upstream/${UPSTREAM_BRANCH}")"

if [ "${new_commits}" -eq 0 ]; then
  echo "No new upstream commits to merge."
  echo "Commits to be merged: 0"
  exit 0
fi

echo "Merging ${new_commits} new upstream commit(s) into '${SYNC_BRANCH}'..."

# Merge upstream — preserves upstream commit SHAs so GitHub correctly tracks
# the fork's divergence. This is why cherry-pick caused "N commits behind":
# cherry-pick creates new SHAs and GitHub counts them as unrelated commits.
if ! git merge "upstream/${UPSTREAM_BRANCH}" --no-edit -m "chore: merge upstream ${UPSTREAM_REPO}@${UPSTREAM_BRANCH}"; then
  echo ""
  echo "Merge conflict detected."
  echo "Resolve the conflicts, then run:"
  echo "  git add <files>"
  echo "  git merge --continue"
  echo "Then re-run this script to push and open the PR."
  exit 1
fi

echo "Done. '${SYNC_BRANCH}' updated with ${new_commits} new commit(s)."

# ---- push and open/update PR ----
echo "Pushing '${SYNC_BRANCH}' to origin..."
git push -u origin "${SYNC_BRANCH}"

# Total commits on SYNC_BRANCH not yet in FORK_BRANCH — accurate across all runs.
total_applied="$(git rev-list --count "origin/${FORK_BRANCH}..${SYNC_BRANCH}")"

today="$(date +%Y-%m-%d)"
pr_title="chore: sync upstream ${today}"
pr_body="Automated merge of ${total_applied} commit(s) from \`${UPSTREAM_REPO}@${UPSTREAM_BRANCH}\` as of ${today}."

existing_pr="$(gh pr list --head "${SYNC_BRANCH}" --base "${FORK_BRANCH}" --json number --jq '.[0].number' 2>/dev/null || true)"

if [ -n "${existing_pr}" ]; then
  echo "Updating existing PR #${existing_pr}..."
  gh pr edit "${existing_pr}" --title "${pr_title}" --body "${pr_body}"
  gh pr view "${existing_pr}" --json url --jq '"PR: " + .url'
else
  echo "Opening new PR..."
  gh pr create \
    --head "${SYNC_BRANCH}" \
    --base "${FORK_BRANCH}" \
    --title "${pr_title}" \
    --body "${pr_body}"
fi
