#!/usr/bin/env bash
# Commit the given paths and push, shared by both workflows.
#   bash src/ci/push.sh "<commit message>" <path>...
# Paths that do not exist are skipped. Anything else the run changed is NOT saved (a tool run leaves state/ alone) and is
# put back so the rebase can run. The push is tried three times: pull --rebase (our new files win a conflict), push,
# and a jittered wait in between.
set -u
msg="$1"; shift
git config user.name "whalers-scan"
git config user.email "whalers-scan@users.noreply.github.com"
for p in "$@"; do if [ -e "$p" ]; then git add -A -- "$p"; fi; done
if git diff --cached --quiet; then echo "nothing to save"; exit 0; fi
git commit -q -m "$msg"
git checkout -q -- . && git clean -fdq
branch="${GITHUB_REF_NAME:-$(git rev-parse --abbrev-ref HEAD)}"
for i in 1 2 3; do
  if git pull -q --rebase -X theirs origin "$branch" && git push -q origin "HEAD:$branch"; then echo "saved (try $i)"; exit 0; fi
  git rebase --abort 2>/dev/null || true
  wait=$(( (RANDOM % 15) + 5 * i )); echo "push failed (try $i), waiting ${wait}s"; sleep "$wait"
done
echo "::error::could not push the results after 3 tries"
exit 1
