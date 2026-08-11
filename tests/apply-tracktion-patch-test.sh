#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUBJECT="$ROOT/cmake/apply-tracktion-patch.cmake"
FIXTURE_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mosh-patch-stack.XXXXXX")"
REPO="$FIXTURE_ROOT/repo"
PATCH_ONE="$FIXTURE_ROOT/0001.patch"
PATCH_TWO="$FIXTURE_ROOT/0002.patch"
MANIFEST="$FIXTURE_ROOT/manifest.txt"
trap 'rm -rf -- "$FIXTURE_ROOT"' EXIT

git init -q "$REPO"
git -C "$REPO" config user.email test@mosh.invalid
git -C "$REPO" config user.name "Mosh Patch Test"
printf 'base\n' > "$REPO/value.txt"
git -C "$REPO" add value.txt
git -C "$REPO" commit -qm base

cat > "$PATCH_ONE" <<'PATCH'
diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-base
+stage-one
PATCH

cat > "$PATCH_TWO" <<'PATCH'
diff --git a/value.txt b/value.txt
--- a/value.txt
+++ b/value.txt
@@ -1 +1 @@
-stage-one
+stage-two
PATCH

printf '%s\n%s\n' "$PATCH_ONE" "$PATCH_TWO" > "$MANIFEST"

run_subject() {
  (cd "$REPO" && cmake "-DPATCH_MANIFEST=$MANIFEST" -P "$SUBJECT")
}

assert_final() {
  local value
  value="$(tr -d '\r\n' < "$REPO/value.txt")"
  if [ "$value" != "stage-two" ]; then
    printf 'expected stage-two, got %s\n' "$value" >&2
    exit 1
  fi
}

# A pristine source applies the complete ordered stack.
run_subject
assert_final

# A fully applied stack is idempotent even though patch two overlaps patch one.
run_subject
assert_final

# A cache carrying only the older prefix applies just the missing tail.
git -C "$REPO" apply --unidiff-zero -R "$PATCH_TWO"
run_subject
assert_final

printf 'Tracktion patch stack: 3/3 scenarios passed\n'
