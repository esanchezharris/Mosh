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
