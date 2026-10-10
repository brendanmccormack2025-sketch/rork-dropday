#!/usr/bin/env bash
# One-command release: pull, install, apply the database migrations, deploy the Edge Functions, publish the app update.
#
#   ./ship.sh "what changed"
#
# Needs these environment variables (never printed):
#   SUPABASE_DB_URL        Postgres connection string of the project (Supabase > Project Settings > Database)
#   SUPABASE_ACCESS_TOKEN  Supabase personal access token (used by the supabase CLI)
# And an EAS login (EXPO_TOKEN, or `npx eas-cli login` once).
#
# Lists:  supabase/MIGRATIONS_ORDER.txt (migrations, in order)   supabase/FUNCTIONS.txt (functions to deploy)
# Dry run (prints what it would do, changes nothing):   SHIP_DRY_RUN=1 ./ship.sh "message"
set -Eeuo pipefail
cd "$(dirname "$0")"

PROJECT_REF="tfdjymogbtfavdzgfqas"
MIGRATIONS_FILE="supabase/MIGRATIONS_ORDER.txt"
FUNCTIONS_FILE="supabase/FUNCTIONS.txt"
DRY="${SHIP_DRY_RUN:-}"

CURRENT_STEP="starting"
step() { CURRENT_STEP="$1"; printf '\n==> %s\n' "$1"; }
trap 'rc=$?; printf "\nFAILED at step: %s (exit %s)\nNothing after this step was run.\n" "$CURRENT_STEP" "$rc" >&2; exit "$rc"' ERR
fail() { printf 'ERROR: %s\n' "$1" >&2; false; }

# Entries of a list file: first word of every line that is not blank or a comment.
list_entries() { sed -e 's/#.*//' "$1" | awk 'NF { print $1 }'; }

# ── 0. Arguments and environment ─────────────────────────────────────────────
step "check arguments and environment"
MESSAGE="${1:-}"
[ -n "$MESSAGE" ] || fail 'usage: ./ship.sh "what changed"'
for var in SUPABASE_DB_URL SUPABASE_ACCESS_TOKEN; do
  [ -n "${!var:-}" ] || fail "environment variable $var is not set (it is never printed)"
done
export SUPABASE_ACCESS_TOKEN
[ -f "$MIGRATIONS_FILE" ] || fail "$MIGRATIONS_FILE is missing"
[ -f "$FUNCTIONS_FILE" ] || fail "$FUNCTIONS_FILE is missing"

MIGRATIONS=()
while IFS= read -r f; do MIGRATIONS+=("$f"); done < <(list_entries "$MIGRATIONS_FILE")
FUNCTIONS=()
while IFS= read -r f; do FUNCTIONS+=("$f"); done < <(list_entries "$FUNCTIONS_FILE")
[ "${#MIGRATIONS[@]}" -gt 0 ] || fail "$MIGRATIONS_FILE lists no migrations"
for f in "${MIGRATIONS[@]}"; do [ -f "supabase/$f" ] || fail "migration listed but not found: supabase/$f"; done
for f in "${FUNCTIONS[@]}"; do [ -d "supabase/functions/$f" ] || fail "function listed but not found: supabase/functions/$f"; done
echo "migrations: ${#MIGRATIONS[@]}   functions: ${#FUNCTIONS[@]}"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: you have uncommitted changes; the update is built from this working tree."
fi

# ── 1. psql ──────────────────────────────────────────────────────────────────
step "make sure psql is installed"
if ! command -v psql >/dev/null 2>&1; then
  if [ -n "$DRY" ]; then
    echo "[dry run] would install postgresql-client"
  elif command -v apt-get >/dev/null 2>&1; then
    SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
    $SUDO apt-get update -y
    $SUDO apt-get install -y postgresql-client
  elif command -v brew >/dev/null 2>&1; then
    brew install libpq
    export PATH="$(brew --prefix libpq)/bin:$PATH"
  else
    fail "psql is missing and neither apt-get nor brew is available: install the PostgreSQL client"
  fi
fi
if [ -z "$DRY" ]; then command -v psql >/dev/null 2>&1 || fail "psql is still not available after the install"; fi

# ── 2. Code and dependencies ─────────────────────────────────────────────────
step "git pull"
if [ -n "$DRY" ]; then echo "[dry run] git pull --ff-only"; else git pull --ff-only; fi
step "bun install"
if [ -n "$DRY" ]; then
  echo "[dry run] bun install"
else
  command -v bun >/dev/null 2>&1 || fail "bun is not installed (https://bun.sh)"
  bun install
fi
step "check the EAS login"
if [ -n "$DRY" ]; then
  echo "[dry run] npx eas-cli whoami"
else
  npx eas-cli whoami >/dev/null 2>&1 || fail "not logged in to EAS: set EXPO_TOKEN, or run: npx eas-cli login"
fi

# ── 3. Migrations ────────────────────────────────────────────────────────────
APPLIED=()
for f in "${MIGRATIONS[@]}"; do
  step "migration $f"
  if [ -n "$DRY" ]; then
    echo "[dry run] psql \"\$SUPABASE_DB_URL\" -v ON_ERROR_STOP=1 -f supabase/$f"
  else
    psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f "supabase/$f"
  fi
  APPLIED+=("$f")
done

# ── 4. Edge Functions ────────────────────────────────────────────────────────
DEPLOYED=()
for f in "${FUNCTIONS[@]}"; do
  step "deploy function $f"
  if [ -n "$DRY" ]; then
    echo "[dry run] npx supabase functions deploy $f --project-ref $PROJECT_REF"
  else
    npx supabase functions deploy "$f" --project-ref "$PROJECT_REF"
  fi
  DEPLOYED+=("$f")
done

# ── 5. App update ────────────────────────────────────────────────────────────
step "publish the app update (EAS, production)"
if [ -n "$DRY" ]; then
  echo "[dry run] npx eas-cli update --channel production --environment production --message \"$MESSAGE\" --non-interactive"
else
  npx eas-cli update --channel production --environment production --message "$MESSAGE" --non-interactive
fi

# ── 6. Reminders (not errors) ────────────────────────────────────────────────
NOTES=()
if [ -z "$DRY" ]; then
  if [ "$(psql "$SUPABASE_DB_URL" -Atqc "select count(*) from vault.decrypted_secrets where name = 'trial_contact_pepper'" 2>/dev/null || echo 0)" = "0" ]; then
    NOTES+=("Vault secret trial_contact_pepper is not set (phone numbers cannot be saved): select vault.create_secret('<64+ random characters>', 'trial_contact_pepper');")
  fi
  if [ "$(psql "$SUPABASE_DB_URL" -Atqc "select count(*) from cron.job where jobname = 'delete-media'" 2>/dev/null || echo 0)" = "0" ]; then
    NOTES+=("delete-media is deployed but not scheduled: after a dry run, run supabase/schedule-delete-media.sql once (see supabase/FUNCTIONS.txt).")
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n==================== shipped%s ====================\n' "${DRY:+ (DRY RUN)}"
printf 'commit:      %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'message:     %s\n' "$MESSAGE"
printf 'migrations:  %s applied\n' "${#APPLIED[@]}"
for f in "${APPLIED[@]}"; do printf '               - %s\n' "$f"; done
printf 'functions:   %s deployed\n' "${#DEPLOYED[@]}"
for f in "${DEPLOYED[@]}"; do printf '               - %s\n' "$f"; done
printf 'app update:  published to the production channel\n'
if [ "${#NOTES[@]}" -gt 0 ]; then
  printf '\nTo do by hand:\n'
  for n in "${NOTES[@]}"; do printf '  * %s\n' "$n"; done
fi
