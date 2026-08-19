#!/usr/bin/env bash
# [FORK] Share git rerere resolutions through the repository.
#
# rerere records conflict resolutions in $GIT_DIR/rr-cache, which is machine-local and absent from a
# fresh clone, so CI cannot replay anything. For a long-lived fork that is the difference between a
# weekly sync resolving itself and a weekly sync needing a human: the same files conflict on every
# upstream merge (the five mobile Drift repositories, stack.repository.ts, stack.repository.sql,
# Map.svelte). Those resolutions are shared knowledge about how this fork relates to upstream, not
# local scratch state, so they are tracked here and copied into place when needed.
#
#   ./_fork/rr-cache.sh import   # tracked -> .git/rr-cache   (in CI, and after a fresh clone)
#   ./_fork/rr-cache.sh export   # .git/rr-cache -> tracked   (after resolving conflicts locally)
#
# A replayed resolution is not automatically a correct one: rerere only matches an identical conflict
# hunk, but identical hunks can still want different answers as surrounding code moves. The gate
# suite is what decides, and the sync workflow lists every auto-resolved path in the PR body so a
# human looks at them.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tracked="$here/rr-cache"
# --git-common-dir rather than --git-dir, so this still works from a linked worktree.
live="$(git rev-parse --git-common-dir)/rr-cache"

count() { find "$1" -name preimage 2>/dev/null | wc -l | tr -d ' '; }

case "${1:-}" in
  import)
    mkdir -p "$live"
    if [ -d "$tracked" ] && [ -n "$(ls -A "$tracked" 2>/dev/null)" ]; then
      cp -R "$tracked/." "$live/"
    fi
    echo "imported $(count "$live") resolution(s) into $live"
    ;;
  export)
    mkdir -p "$tracked"
    if [ -d "$live" ] && [ -n "$(ls -A "$live" 2>/dev/null)" ]; then
      cp -R "$live/." "$tracked/"
    fi
    echo "exported $(count "$tracked") resolution(s) into $tracked"
    echo "commit _fork/rr-cache to share them"
    ;;
  *)
    echo "usage: $0 import|export" >&2
    exit 2
    ;;
esac
