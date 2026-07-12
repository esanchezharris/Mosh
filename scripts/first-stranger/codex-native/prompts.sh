#!/usr/bin/env bash

cn_plan_prompt() {
  local lane="$1" lane_json="$2" slug
  slug="$(printf '%s' "$lane" | tr '[:upper:]' '[:lower:]')"
  cat <<EOF
You are the planning and gap-verification phase for First-Stranger lane $lane.

Read AGENTS.md, docs/first-stranger-program/SPEC.md, the backlog record below, and
docs/first-stranger-program/lanes/$slug.md if present. SPEC section 0 and the
settled decisions are binding. Verify the claimed gap against the current tree.
Create or update only docs/first-stranger-program/lanes/$slug.md during this
phase. Do not implement product code. Do not run git commit, push, gh, or any
merge command. Do not modify the loop, gate, CLAUDE.md, specs 00-06, CMake pins,
.github, arena, SA3-LoRA, or FMS spike material. Return only the requested JSON.

Backlog record:
$lane_json
EOF
}

cn_implement_prompt() {
  local lane="$1" lane_json="$2" slug
  slug="$(printf '%s' "$lane" | tr '[:upper:]' '[:lower:]')"
  cat <<EOF
Continue lane $lane in this same worktree and implement only its bounded plan.

Re-read AGENTS.md, docs/first-stranger-program/SPEC.md, and
docs/first-stranger-program/lanes/$slug.md. Preserve SPEC section 0: one lane
per worktree, all user-visible mutation through MoshOps, the prescribed build
recipe, and no build inputs under ~/Documents. Do not commit, push, create or
edit a PR, or merge. Do not modify the automation rulebooks, gate, CLAUDE.md,
specs 00-06, CMake pins, .github, arena, SA3-LoRA, or FMS spike material. Run
focused tests you can complete, then return only the requested JSON.

Backlog record:
$lane_json
EOF
}

cn_review_prompt() {
  local lane="$1" base="$2" route="$3"
  cat <<EOF
Hostile, read-only review of First-Stranger lane $lane against base $base.
The deterministic supervisor classified its route as $route. Inspect the full
diff and relevant contract/spec files. Look specifically for SPEC section 0
violations, MoshOps bypasses, security or secret exposure, changes outside the
lane, rulebook/CMake-pin/.github/parked-thread edits, incomplete tests, and a
claimed gate that does not prove the acceptance criteria. Do not edit files or
run git/gh mutations. APPROVE only if there are zero blocking findings. Return
only the requested JSON.
EOF
}
