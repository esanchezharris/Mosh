#!/usr/bin/env bash
# merge-one.sh — the deterministic half of the serialized merge-queue. The LLM
# adversarial review happens in the Workflow BETWEEN `prepare` and `finalize`.
#
#   prepare  <slug> <pr> [base]   kill-switch → rebase onto origin/main → classify
#                                 (exclusion) → gate.sh. Emits a verdict JSON. Merges
#                                 NOTHING. ready:true ⇔ not excluded + clean rebase +
#                                 gate passed (and a human/agent review still required).
#   finalize <slug> <pr> <base_sha> [review_note]
#                                 re-check kill-switch + origin/main UNMOVED since
#                                 base_sha → wait for the required "cheap gate" check →
#                                 gh pr merge --squash (NO --admin) → ledger →
#                                 remove worktree. Holds an flock so two finalizes can
#                                 never overlap.
#   reject   <slug> <pr> <sublabel> <reason>
#                                 leave PR open, label needs-human + <sublabel>, comment,
#                                 ledger a REJECTED entry. Never merges.
#
# All subcommands print a JSON result on stdout. Bash 3.2 compatible.
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SELF_DIR/lib.sh"
set +e   # we record failures, never abort mid-sequence

MAIN="$(al_main_worktree)"; [ -n "$MAIN" ] || al_die "no main worktree"
LOCK="$AL_DOCS_DIR/.merge-queue.lock"; mkdir -p "$AL_DOCS_DIR"

slug_wt() { printf '%s/.claude/worktrees/auto-%s\n' "$MAIN" "$1"; }
branch_of() { printf 'claude/auto-%s\n' "$1"; }

ensure_label() { gh label create "$1" --color "${2:-EDEDED}" --force >/dev/null 2>&1 || true; }

# ── required-check wait ──────────────────────────────────────────────────────────
# main requires the "cheap gate" status check, and branch protection has
# enforce_admins:true — so `gh pr merge --admin` CANNOT bypass it and would just
# fail. We therefore wait for the check to go green and then merge normally.
#
# This is strictly stronger than the old --admin merge: a loop merge is now gated
# by the same check a human merge is. The local gate.sh run in `prepare` stays as
# the primary proof; this is the remote confirmation of it.
#
# Fail-closed: any outcome that is not an observed green (failure, timeout, gh
# error, check never appearing) returns non-zero and finalize refuses to merge.
# Matching is on the "cheap gate" PREFIX — the full context string carries U+00B7
# separators ("cheap gate (typecheck · vitest · e2e · py)") that are fragile to
# quote through shell/jq.
AL_REQUIRED_CHECK_PREFIX="${AL_REQUIRED_CHECK_PREFIX:-cheap gate}"
AL_CHECK_TIMEOUT_S="${AL_CHECK_TIMEOUT_S:-1800}"   # 25-30 min; the lane runs ~4-10 min
AL_CHECK_POLL_S="${AL_CHECK_POLL_S:-20}"

# Echoes a one-word state for the required check: SUCCESS | FAILURE | PENDING | ABSENT
required_check_state() {
  local pr="$1" out
  out="$(gh pr checks "$pr" --json name,state 2>/dev/null)" || { printf 'ABSENT\n'; return; }
  printf '%s\n' "$out" | jq -r --arg p "$AL_REQUIRED_CHECK_PREFIX" '
    [ .[] | select(.name | startswith($p)) ] as $m
    | if   ($m | length) == 0                              then "ABSENT"
      elif ($m | map(select(.state == "FAILURE"
                         or .state == "ERROR"
                         or .state == "CANCELLED"
                         or .state == "TIMED_OUT"))
                | length) > 0                              then "FAILURE"
      elif ($m | map(select(.state != "SUCCESS"))
                | length) > 0                              then "PENDING"
      else "SUCCESS" end' 2>/dev/null || printf 'ABSENT\n'
}

# 0 = observed green. non-zero = do not merge. Reason on stdout.
wait_for_required_check() {
  local pr="$1" waited=0 st
  while [ "$waited" -lt "$AL_CHECK_TIMEOUT_S" ]; do
    st="$(required_check_state "$pr")"
    case "$st" in
      SUCCESS) return 0 ;;
      FAILURE) printf 'required check "%s*" failed on PR #%s\n' "$AL_REQUIRED_CHECK_PREFIX" "$pr"; return 1 ;;
      *)       sleep "$AL_CHECK_POLL_S"; waited=$(( waited + AL_CHECK_POLL_S )) ;;
    esac
  done
  # ABSENT for the whole window is fail-closed too: we never merge on "no signal".
  printf 'timed out after %ss waiting for required check "%s*" on PR #%s (last state: %s)\n' \
    "$AL_CHECK_TIMEOUT_S" "$AL_REQUIRED_CHECK_PREFIX" "$pr" "${st:-unknown}"
  return 1
}

# ── prepare ──────────────────────────────────────────────────────────────────────
cmd_prepare() {
  local slug="$1" pr="$2" base="${3:-origin/main}"
  local wt; wt="$(slug_wt "$slug")"

  if al_stop_requested; then
    jq -nc '{ready:false,phase:"prepare",stopped:true,reason:"STOP sentinel present — not preparing"}'
    return
  fi
  [ -d "$wt" ] || { jq -nc --arg r "no worktree auto-$slug" '{ready:false,phase:"prepare",reason:$r}'; return; }

  git -C "$wt" fetch --quiet origin main || true
  local base_sha; base_sha="$(git -C "$wt" rev-parse origin/main)"

  # Rebase onto latest origin/main — no stale-green merges.
  if ! git -C "$wt" rebase origin/main >/dev/null 2>&1; then
    git -C "$wt" rebase --abort >/dev/null 2>&1 || true
    jq -nc --arg b "$base_sha" '{ready:false,phase:"prepare",reason:"rebase conflict",conflict:true,baseSha:$b}'
    return
  fi
  local head_sha; head_sha="$(git -C "$wt" rev-parse HEAD)"

  # Classify + exclusion (fail-closed). Non-empty diff required.
  local cj; cj="$("$SELF_DIR/classify.sh" origin/main "$wt")"
  local class excluded diff_empty
  class="$(echo "$cj" | jq -r .class)"
  excluded="$(echo "$cj" | jq -r .excluded)"
  diff_empty="$(echo "$cj" | jq -r .diff_empty)"

  if [ "$diff_empty" = true ]; then
    jq -nc --arg b "$base_sha" '{ready:false,phase:"prepare",reason:"empty diff vs main (already merged/subsumed)",baseSha:$b}'
    return
  fi
  # Classic auto-loop: an excluded diff is auto-rejected before it is ever gated.
  # STRANGER MODE (MOSH_STRANGER_MODE=1): the First-Stranger loop expects most lanes to
  # touch exclusion paths (engine, state, auth, packaging, relay). It does NOT auto-merge
  # them — it gates + reviews them and routes the PR to the owner (route-owner). So in
  # stranger mode we do NOT bail here; we fall through to push + gate and report the
  # excluded flag so the caller can route. Default behavior is byte-identical.
  if [ "$excluded" = true ] && [ "${MOSH_STRANGER_MODE:-0}" != "1" ]; then
    jq -nc --argjson c "$cj" --arg b "$base_sha" \
      '{ready:false,phase:"prepare",reason:"touches hard-exclusion list",excluded:true,classify:$c,baseSha:$b}'
    return
  fi

  # Push the rebased branch so the PR reflects exactly what we gate.
  git -C "$wt" push --force-with-lease >/dev/null 2>&1 || al_warn "push --force-with-lease failed for $(branch_of "$slug")"

  # THE GATE (authoritative: ×3 selftest + verify.py run here for native).
  local gate_json gate_rc
  gate_json="$("$SELF_DIR/gate.sh" "$class" "$wt" origin/main)"; gate_rc=$?
  local ready=false; [ "$gate_rc" -eq 0 ] && ready=true

  # One-line digest of the gate result for the ledger / reviewer.
  local gsum
  gsum="$(echo "$gate_json" | jq -r '"\(.class) pass=\(.pass) " + ([.steps[]?|"\(.name):\(if .ok then "ok" else "FAIL" end)"]|join(",")) + (if (.selftest|length)>0 then " selftest=\(.selftest)" else "" end)' 2>/dev/null)"

  # camelCase keys match the Workflow's PREPARE_SCHEMA + finalize arg (baseSha/headSha).
  jq -nc \
    --argjson ready "$ready" --arg class "$class" --argjson exc "$excluded" \
    --arg base "$base_sha" --arg head "$head_sha" \
    --arg gsum "$gsum" --argjson gate "$gate_json" \
    '{ready:$ready, phase:"prepare", class:$class, excluded:$exc,
      baseSha:$base, headSha:$head, gateSummary:$gsum, gate:$gate,
      reason: (if $ready then "gate green — awaiting adversarial review" else "gate failed" end)}'
}

# ── finalize ─────────────────────────────────────────────────────────────────────
cmd_finalize() {
  local slug="$1" pr="$2" base_sha="$3" note="${4:-}"
  local wt br; wt="$(slug_wt "$slug")"; br="$(branch_of "$slug")"

  # Single-flight: never let two finalizes overlap (backstop to the serial queue).
  exec 9>"$LOCK"
  if ! flock -n 9; then jq -nc '{merged:false,phase:"finalize",reason:"another finalize holds the lock"}'; return; fi

  if al_stop_requested; then
    jq -nc '{merged:false,phase:"finalize",stopped:true,reason:"STOP sentinel present — not merging"}'
    return
  fi

  git -C "$MAIN" fetch --quiet origin main || true
  local cur; cur="$(git -C "$MAIN" rev-parse origin/main)"
  if [ "$cur" != "$base_sha" ]; then
    jq -nc --arg c "$cur" --arg b "$base_sha" \
      '{merged:false,phase:"finalize",reason:"origin/main advanced since prepare — re-prepare required",current:$c,expected:$b}'
    return
  fi

  local mlog; mlog="$(mktemp)"
  gh pr ready "$pr" >/dev/null 2>&1 || true   # a draft PR can't be merged

  # main REQUIRES the cheap gate and enforces protection on admins, so --admin is
  # not an escape hatch any more — wait for the real signal, fail-closed.
  local wlog; wlog="$(wait_for_required_check "$pr")"
  if [ $? -ne 0 ]; then
    jq -nc --arg r "$wlog" '{merged:false,phase:"finalize",reason:$r}'
    rm -f "$mlog"; return
  fi

  # NOT --delete-branch: the branch is checked out in a worktree, so gh's delete step
  # returns non-zero even though the MERGE succeeded (a false failure). We delete it
  # ourselves after removing the worktree, below.
  gh pr merge "$pr" --squash >"$mlog" 2>&1
  local mrc=$?
  if [ "$mrc" -ne 0 ]; then
    jq -nc --arg log "$(LC_ALL=C tr -cd '[:print:] ' <"$mlog")" '{merged:false,phase:"finalize",reason:"gh pr merge failed",log:$log}'
    rm -f "$mlog"; return
  fi
  rm -f "$mlog"

  # Advance local main in the MAIN worktree.
  git -C "$MAIN" fetch --quiet origin main || true
  local merge_sha; merge_sha="$(git -C "$MAIN" rev-parse origin/main)"

  ledger_append "### $(al_now) — PR #$pr: $br  [MERGED ✅]
- **Branch:** $br → PR #$pr
- **Base:** origin/main @ ${base_sha:0:9} → squash-merged as ${merge_sha:0:9}
- **Review:** ${note:-APPROVE (adversarial self-review)}
- **Outcome:** auto-merged by the unattended loop; branch + worktree removed
"
  # Cleanup — PR is CONFIRMED merged, so force-remove regardless of squash ancestry
  # (rm-worktree.sh's is-ancestor guard would refuse, since a squash commit isn't an
  # ancestor of the branch tip).
  # Silence STDOUT too: `git branch -D` prints "Deleted branch …" to stdout, which would
  # pollute this function's JSON result (the Workflow's finalize agent parses it).
  git -C "$MAIN" worktree remove --force "$wt" >/dev/null 2>&1 || al_warn "worktree remove failed: auto-$slug"
  git -C "$MAIN" branch -D "$br" >/dev/null 2>&1 || true
  git -C "$MAIN" push origin --delete "$br" >/dev/null 2>&1 || true

  jq -nc --arg m "$merge_sha" '{merged:true,phase:"finalize",merge_sha:$m}'
}

# ── reject ───────────────────────────────────────────────────────────────────────
cmd_reject() {
  local slug="$1" pr="$2" sublabel="$3" reason="$4"
  local br; br="$(branch_of "$slug")"
  if al_stop_requested; then
    jq -nc '{rejected:false,phase:"reject",stopped:true,reason:"STOP sentinel present — not rejecting"}'
    return
  fi
  ensure_label "needs-human" "B60205"
  ensure_label "$sublabel" "FBCA04"
  gh pr edit "$pr" --add-label "needs-human" --add-label "$sublabel" >/dev/null 2>&1 || al_warn "label failed (pr #$pr)"
  gh pr comment "$pr" --body "Auto-loop held this PR for a human: **$sublabel**. $reason" >/dev/null 2>&1 || true

  ledger_append "### $(al_now) — PR #$pr: $br  [REJECTED ⛔ $sublabel]
- **Branch:** $br → PR #$pr
- **Reason:** $reason
- **Outcome:** left open, labels [needs-human, $sublabel] — no merge
"
  jq -nc --arg s "$sublabel" --arg r "$reason" '{rejected:true,sublabel:$s,reason:$r}'
}

# ── route-owner (stranger-loop) ────────────────────────────────────────────────────
# A high-stakes lane PASSED its gate but the loop must NEVER auto-merge it. Undraft the
# PR (so the owner can merge it), label it needs-owner-merge + program:<lane>, comment the
# gate + review evidence, ledger an AWAITING-OWNER entry. Leaves the branch + worktree in
# place (the owner merges via GitHub; cleanup happens on their merge). Never merges.
#   route-owner <slug> <pr> <lane> <gate_summary> <review_note> [flagged]
cmd_route_owner() {
  local slug="$1" pr="$2" lane="$3" gsum="$4" note="${5:-APPROVE (adversarial self-review)}" flagged="${6:-0}"
  local br; br="$(branch_of "$slug")"
  if al_stop_requested; then
    jq -nc '{routed:false,phase:"route-owner",stopped:true,reason:"STOP sentinel present — not routing"}'
    return
  fi
  ensure_label "needs-owner-merge" "5319E7"
  ensure_label "program:$lane" "0E8A16"
  gh pr ready "$pr" >/dev/null 2>&1 || true   # undraft → the owner can merge it
  local labels=(--add-label "needs-owner-merge" --add-label "program:$lane")
  local caution=""
  if [ "$flagged" = "1" ]; then
    ensure_label "review-flagged" "D93F0B"
    labels+=(--add-label "review-flagged")
    caution="⚠️ **The hostile review flagged concerns — read them before merging.**
"
  fi
  gh pr edit "$pr" "${labels[@]}" >/dev/null 2>&1 || al_warn "label failed (pr #$pr)"
  gh pr comment "$pr" --body "${caution}**Ready for owner merge** — high-stakes lane (\`$lane\`); the stranger-loop never auto-merges these.
- **Gate:** $gsum
- **Review:** $note

This PR is gated + reviewed. Merge it when you're satisfied." >/dev/null 2>&1 || true

  ledger_append "### $(al_now) — PR #$pr: $br  [AWAITING-OWNER 🔒 program:$lane]
- **Branch:** $br → PR #$pr
- **Gate:** $gsum
- **Review:** $note$( [ "$flagged" = "1" ] && printf ' (REVIEW-FLAGGED)' )
- **Outcome:** undrafted + labeled [needs-owner-merge, program:$lane]; owner merges. Loop does NOT auto-merge high-stakes lanes.
"
  jq -nc --arg l "$lane" --argjson f "$( [ "$flagged" = "1" ] && echo true || echo false )" \
    '{routed:true, bucket:"owner-merge", lane:$l, flagged:$f}'
}

SUB="${1:?usage: merge-one.sh <prepare|finalize|reject|route-owner> ...}"; shift
case "$SUB" in
  prepare)     cmd_prepare      "$@" ;;
  finalize)    cmd_finalize     "$@" ;;
  reject)      cmd_reject       "$@" ;;
  route-owner) cmd_route_owner  "$@" ;;
  *) al_die "unknown subcommand: $SUB" ;;
esac
