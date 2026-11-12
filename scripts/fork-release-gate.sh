#!/bin/sh
# Refuses a fork release that must not publish.
#
#   sh scripts/fork-release-gate.sh version <tag>
#   sh scripts/fork-release-gate.sh checks <tag> <check-name>...
#
# version fails unless <tag> is rfx.<number>. checks waits up to 90 minutes for
# every named check run on the commit <tag> resolves to, and fails as soon as
# one ends other than in success. checks needs GH_TOKEN and GITHUB_REPOSITORY.
set -eu

mode=$1
tag=$2
shift 2

case $mode in
version)
  if ! printf '%s' "$tag" | grep -Eq '^rfx\.[1-9][0-9]*$'; then
    echo "::error::tag $tag is not rfx.<number>, e.g. rfx.1"
    exit 1
  fi
  ;;
checks)
  required=$(jq -cn '$ARGS.positional' --args "$@")
  sha=$(git rev-parse "$tag^{commit}")
  deadline=$(($(date +%s) + 5400))
  while :; do
    runs=$(gh api "repos/$GITHUB_REPOSITORY/commits/$sha/check-runs?filter=latest&per_page=100")
    failed=$(printf '%s' "$runs" | jq -r --argjson req "$required" \
      '[.check_runs[] | select(.name | IN($req[]))
        | select(.status == "completed" and .conclusion != "success")
        | "\(.name) (\(.conclusion))"] | join(", ")')
    if [ -n "$failed" ]; then
      echo "::error::$tag ($sha) failed required checks: $failed"
      exit 1
    fi
    missing=$(printf '%s' "$runs" | jq -r --argjson req "$required" \
      '[.check_runs[] | select(.status == "completed") | .name] as $done
        | [$req[] | select(IN($done[]) | not)] | join(", ")')
    if [ -z "$missing" ]; then
      echo "$tag ($sha): every required check passed"
      exit 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::$tag ($sha) after 90 min, missing or unfinished: $missing"
      exit 1
    fi
    echo "waiting on: $missing"
    sleep 30
  done
  ;;
*)
  echo "usage: fork-release-gate.sh version <tag> | checks <tag> <check-name>..." >&2
  exit 2
  ;;
esac
