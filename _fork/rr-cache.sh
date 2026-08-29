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
  # Exports only entries that are actually usable, normalised to variant 0.
  #
  # rerere numbers variants when the same conflict id is recorded more than once. A merge that is
  # started and abandoned -- exploring how bad a sync looks, say -- writes `preimage` with no
  # `postimage`; resolving the same conflict later lands in `preimage.1`/`postimage.1` beside it.
  # rerere then looks up variant 0 on replay, finds a preimage it cannot answer, and gives up. The
  # resolution is right there in variant 1 and never gets used.
  #
  # That is not hypothetical: it is why the 2026-08-29 sync replayed 0 of 32 recorded resolutions and
  # reported the same 33 conflicts a human had already resolved. A cp -R of $GIT_DIR/rr-cache copies
  # the trap along with the answers.
  #
  # So: pick the highest variant that has a postimage, write it as the plain pair, and skip any entry
  # that has no postimage at all -- an unresolved conflict is not knowledge worth sharing.
  export)
    mkdir -p "$tracked"
    exported=0
    skipped=0
    for dir in "$live"/*/; do
      [ -d "$dir" ] || continue
      id=$(basename "$dir")

      best=""
      for post in "$dir"postimage "$dir"postimage.*; do
        [ -f "$post" ] || continue
        best="$post"
      done

      if [ -z "$best" ]; then
        skipped=$((skipped + 1))
        continue
      fi

      pre="${best/postimage/preimage}"
      if [ ! -f "$pre" ]; then
        echo "warning: $id has $(basename "$best") but no matching preimage; skipping" >&2
        skipped=$((skipped + 1))
        continue
      fi

      mkdir -p "$tracked/$id"
      # Normalised to variant 0. The variant number is local bookkeeping about the order this machine
      # happened to see conflicts in; it means nothing to the next clone, and carrying it over is what
      # strands a resolution behind an unanswerable variant 0.
      cp "$pre" "$tracked/$id/preimage"
      cp "$best" "$tracked/$id/postimage"
      rm -f "$tracked/$id"/preimage.* "$tracked/$id"/postimage.*
      exported=$((exported + 1))
    done

    echo "exported $exported resolution(s) into $tracked"
    [ "$skipped" -gt 0 ] && echo "skipped $skipped entr(y|ies) with no recorded resolution"
    echo "commit _fork/rr-cache to share them"
    ;;
  *)
    echo "usage: $0 import|export" >&2
    exit 2
    ;;
esac
