#!/usr/bin/env bash
# setup-cloud.sh — finish O4 in one command: deploy the Supabase brain proxy and create
# the Cloudflare R2 buckets.
#
#   scripts/setup-cloud.sh              # do everything that has a token available
#   scripts/setup-cloud.sh --check      # report what is configured; change nothing
#
# WHY THIS EXISTS: both CLIs refuse their interactive browser login in a non-TTY
# ("Cannot use automatic login flow inside non-TTY environments"), so an agent cannot
# complete them unattended. The remaining human step is therefore *one paste per service*,
# and this script is everything on either side of it.
#
# TOKENS ARE READ FROM A FILE, NEVER PASSED ON THE COMMAND LINE AND NEVER PRINTED.
# `set -a; . "$ENV_FILE"; set +a` exports them; the CLIs pick them up from the environment.
# Nothing here echoes a value — not on success, not in an error, not with `set -x` (which
# is deliberately never enabled). The same shape as run-mosh.sh's `load_dotenv`.
#
# Default ENV_FILE is ui/.env.local, which is gitignored (ui/.gitignore:7 `*.local`).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${MOSH_CLOUD_ENV:-$ROOT/ui/.env.local}"
PROJECT_REF="tpvkqaqydafpgockzchm"          # same project the relay lives in
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --set-token: paste a token at a HIDDEN prompt; it goes keyboard → file and is never
# echoed, never in shell history, never in a transcript. Exists because ui/.env.local is
# a dotfile and therefore invisible in Finder — "I can't see .env" is a real problem and
# hunting for the file is not the answer.
#
#   scripts/setup-cloud.sh --set-token SUPABASE_ACCESS_TOKEN
#   scripts/setup-cloud.sh --set-token CLOUDFLARE_API_TOKEN
#   scripts/setup-cloud.sh --edit           # or just open the file in TextEdit
if [ "${1:-}" = "--set-token" ]; then
  KEY="${2:-}"
  case "$KEY" in
    SUPABASE_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY|XAI_API_KEY) ;;
    CLOUDFLARE_ACCOUNT_ID)
      echo "CLOUDFLARE_ACCOUNT_ID is discovered automatically from the API token — do not set it" >&2
      echo "by hand. Set CLOUDFLARE_API_TOKEN, then just run: $0" >&2
      exit 2 ;;
    *) echo "usage: $0 --set-token {SUPABASE_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|OPENAI_API_KEY}" >&2; exit 2 ;;
  esac
  printf 'Paste %s (input hidden), then Enter: ' "$KEY" >&2
  IFS= read -rs VALUE; echo >&2
  [ -n "$VALUE" ] || { echo "empty — nothing written." >&2; exit 1; }

  # SHAPE CHECK. Hidden prompts that look identical invite a one-slot paste shuffle, and
  # the resulting failure is unreadable: a Supabase token in CLOUDFLARE_API_TOKEN and a
  # Cloudflare token in CLOUDFLARE_ACCOUNT_ID produced
  #   "Could not route to /accounts/cfut_.../r2/buckets ... [code: 7003]"
  # which names neither the wrong key nor the wrong value. Checking the prefix costs
  # nothing and turns that into one clear line. Never prints the value.
  bad=""
  case "$KEY" in
    SUPABASE_ACCESS_TOKEN) case "$VALUE" in sbp_*) ;; *) bad="expected a Supabase token (sbp_…)";; esac ;;
    CLOUDFLARE_API_TOKEN)  case "$VALUE" in
                             sbp_*) bad="that is a SUPABASE token (sbp_…), not a Cloudflare one";;
                             *) [ "${#VALUE}" -eq 32 ] && bad="that looks like an account ID, not an API token";;
                           esac ;;
    OPENAI_API_KEY)        case "$VALUE" in sk-*) ;; *) bad="expected an OpenAI key (sk-…)";; esac ;;
    XAI_API_KEY)           case "$VALUE" in xai-*) ;; *) bad="expected an xAI key (xai-…)";; esac ;;
  esac
  if [ -n "$bad" ]; then
    unset VALUE
    echo "  REFUSED: $bad. Nothing written — re-run and paste the right one." >&2
    exit 1
  fi
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  # Replace an existing line rather than appending a duplicate the shell would re-read.
  #
  # WRITE IN PLACE — never `mv` a temp file over $ENV_FILE. In a worktree, ui/.env.local
  # is a SYMLINK to the main checkout's copy, and `mv` REPLACES the symlink with a regular
  # file. That silently forks one env file into two: further writes went to the main
  # checkout while Vite's loadEnv read the worktree copy, so the proxy config was invisible
  # to the dev server and it fell back to the direct provider path — which looks identical
  # to working, because tryProxy() falls through by design. Cost a real debugging detour on
  # 2026-07-28. `> "$ENV_FILE"` truncates through the symlink and keeps it intact.
  if grep -q "^${KEY}=" "$ENV_FILE" 2>/dev/null; then
    TMP="$(mktemp)"; grep -v "^${KEY}=" "$ENV_FILE" > "$TMP"
    cat "$TMP" > "$ENV_FILE"; rm -f "$TMP"
    echo "  (replaced the existing $KEY)" >&2
  fi
  printf '%s=%s\n' "$KEY" "$VALUE" >> "$ENV_FILE"
  unset VALUE
  echo "  wrote $KEY to ${ENV_FILE/#$HOME/\~} — value not displayed." >&2
  echo "  now run: scripts/setup-cloud.sh" >&2
  exit 0
fi

if [ "${1:-}" = "--edit" ]; then
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  say "opening ${ENV_FILE/#$HOME/\~} — it is a dotfile, so Finder hides it by default."
  say "(In any Finder window, Cmd-Shift-. toggles hidden files.)"
  exec open -e "$ENV_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  say "setup-cloud: no env file at ${ENV_FILE/#$HOME/\~} — nothing to read tokens from." >&2
fi

# ── what we have ────────────────────────────────────────────────────────────────────
printf '%-28s %s\n' "supabase CLI:"  "$(have supabase && supabase --version || echo MISSING)"
printf '%-28s %s\n' "wrangler CLI:"  "$(have wrangler && wrangler --version 2>/dev/null | head -1 || echo MISSING)"
printf '%-28s %s\n' "SUPABASE_ACCESS_TOKEN:" "$([ -n "${SUPABASE_ACCESS_TOKEN:-}" ] && echo present || echo ABSENT)"
printf '%-28s %s\n' "CLOUDFLARE_API_TOKEN:"  "$([ -n "${CLOUDFLARE_API_TOKEN:-}" ]  && echo present || echo ABSENT)"
printf '%-28s %s\n' "OPENAI_API_KEY:"        "$([ -n "${OPENAI_API_KEY:-}" ]        && echo present || echo ABSENT)"
say ""

if [ "$CHECK_ONLY" = 1 ]; then exit 0; fi

# ── Supabase ────────────────────────────────────────────────────────────────────────
if [ -z "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  say "SKIPPING Supabase — no SUPABASE_ACCESS_TOKEN."
  say "  Create one (30s): https://supabase.com/dashboard/account/tokens → 'Generate new token'"
  say "  Then append ONE line to ${ENV_FILE/#$HOME/\~} and re-run this script:"
  say "      SUPABASE_ACCESS_TOKEN=sbp_..."
  say ""
else
  say "── Supabase: linking $PROJECT_REF ──"
  ( cd "$ROOT" && supabase link --project-ref "$PROJECT_REF" )

  if [ -n "${OPENAI_API_KEY:-}" ]; then
    say "── Supabase: setting function secrets (values not printed) ──"
    ( cd "$ROOT" && supabase secrets set \
        OPENAI_API_KEY="$OPENAI_API_KEY" \
        OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://api.openai.com/v1}" \
        OPENAI_MODEL="${OPENAI_MODEL:-gpt-4o-mini}" >/dev/null )
    say "   set: OPENAI_API_KEY OPENAI_BASE_URL OPENAI_MODEL"
  else
    say "!! no OPENAI_API_KEY in $ENV_FILE — the function will deploy but resolve no provider."
  fi

  say "── Supabase: deploying the brain function ──"
  ( cd "$ROOT" && supabase functions deploy brain )

  # The migration is idempotent (create table IF NOT EXISTS / create or replace function),
  # so re-applying is harmless. `db push` is still NOT blind-run: it would apply every
  # unapplied migration in supabase/migrations/ against a project whose relay is already
  # live, and remote migration history may not know about 0001/0002.
  say ""
  say "── migration 0003_brain_usage.sql — NOT applied automatically ──"
  say "   Review + apply just this one in the SQL editor:"
  say "     https://supabase.com/dashboard/project/$PROJECT_REF/sql/new"
  say "   (or, once you've confirmed remote history is in sync: supabase db push)"
  say "   Check current remote state with: supabase migration list"
fi

# ── Cloudflare R2 ───────────────────────────────────────────────────────────────────
say ""
if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  say "SKIPPING Cloudflare — no CLOUDFLARE_API_TOKEN."
  say "  Create one (60s): https://dash.cloudflare.com/profile/api-tokens → 'Create Token'"
  say "  Template 'Edit Cloudflare Workers', or a custom token with Account → R2 → Edit."
  say "  Then append to ${ENV_FILE/#$HOME/\~} and re-run:"
  say "      CLOUDFLARE_API_TOKEN=..."
  say "      CLOUDFLARE_ACCOUNT_ID=...        # shown on the R2 overview page"
  say ""
else
  # Discovered, never pasted. Asking for it was a third near-identical hidden prompt and
  # that is exactly where the paste shuffle happened; the token already knows the answer.
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    ACC="$(wrangler whoami 2>/dev/null | grep -oE '\b[0-9a-f]{32}\b' | head -1 || true)"
    if [ -n "$ACC" ]; then
      grep -v '^CLOUDFLARE_ACCOUNT_ID=' "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
      mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
      printf 'CLOUDFLARE_ACCOUNT_ID=%s\n' "$ACC" >> "$ENV_FILE"
      export CLOUDFLARE_ACCOUNT_ID="$ACC"
      say "── R2: discovered account $ACC (not a secret — it is in every dashboard URL)"
    else
      say "!! could not discover the Cloudflare account id — is CLOUDFLARE_API_TOKEN valid?"
      say "   check with: wrangler whoami"
    fi
  fi
  for bucket in mosh-takes mosh-updates; do
    say "── R2: ensuring bucket $bucket ──"
    if wrangler r2 bucket create "$bucket" 2>&1 | tee /dev/stderr | grep -qi "already"; then
      say "   (already exists — fine)"
    fi
  done
  say ""
  say "   mosh-takes   → FS-S1/S2 content-addressed take storage."
  say "   mosh-updates → the Sparkle appcast host, the last FS-K2 gap."
  say "   NOT done here, deliberately: making mosh-updates PUBLIC and uploading a build."
  say "   That is real distribution, and this bundle seals provider keys — owner's call."
fi

say ""
say "── verify ──"
say "   supabase secrets list          # names only, never values"
say "   supabase functions list        # 'brain' should be ACTIVE"
say "   wrangler r2 bucket list"
