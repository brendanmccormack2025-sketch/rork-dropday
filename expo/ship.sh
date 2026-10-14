#!/usr/bin/env bash
# One-command release: pull, install, apply the database migrations, deploy the Edge Functions, publish the app update.
#
#   ./ship.sh "what changed"
#
# Needs this environment variable (never printed):
#   SUPABASE_ACCESS_TOKEN  Supabase personal access token (starts with sbp_). Whitespace and newlines are stripped.
# It runs the migrations (Supabase Management API, scripts/supabase-sql.mjs: no psql, no database password) and deploys
# the Edge Functions. And an EAS login (EXPO_TOKEN, or `npx eas-cli login` once).
#
# Lists:  supabase/MIGRATIONS_ORDER.txt (migrations, in order)   supabase/FUNCTIONS.txt (functions to deploy)
# Dry run (prints what it would do, changes nothing):   SHIP_DRY_RUN=1 ./ship.sh "message"
set -Eeuo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"   # absolute: still valid after cd
cd "$(dirname "$SELF")"

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
# A pasted secret can carry a leading newline or spaces: strip all whitespace before use (never echoed).
SUPABASE_ACCESS_TOKEN="$(printf '%s' "${SUPABASE_ACCESS_TOKEN:-}" | tr -d '[:space:]')"
[ -n "$SUPABASE_ACCESS_TOKEN" ] || fail "environment variable SUPABASE_ACCESS_TOKEN is not set (it is never printed)"
case "$SUPABASE_ACCESS_TOKEN" in
  sbp_*) ;;
  *) fail "SUPABASE_ACCESS_TOKEN is not a personal access token (it must start with sbp_; create one at supabase.com/dashboard/account/tokens)" ;;
esac
export SUPABASE_ACCESS_TOKEN

# ── Pull first, then re-run this (possibly updated) script ───────────────────
# The lists and this script are read from disk, so a pull in the middle of a run would apply the OLD lists. Pull before
# anything reads them, and if that changed anything, start over with the fresh files (SHIP_REEXEC stops it looping).
if [ -z "${SHIP_REEXEC:-}" ]; then
  step "git pull"
  if [ -n "$DRY" ]; then
    echo "[dry run] git pull --ff-only"
  else
    git pull --ff-only
    echo "re-running ship.sh with the freshly pulled script and lists"
    SHIP_REEXEC=1 exec bash "$SELF" "$@"
  fi
fi

command -v node >/dev/null 2>&1 || fail "node is not installed"
SQL_RUNNER="scripts/supabase-sql.mjs"
[ -f "$SQL_RUNNER" ] || fail "$SQL_RUNNER is missing"
[ -f "$MIGRATIONS_FILE" ] || fail "$MIGRATIONS_FILE is missing"
[ -f "$FUNCTIONS_FILE" ] || fail "$FUNCTIONS_FILE is missing"

MIGRATIONS=()
while IFS= read -r f; do MIGRATIONS+=("$f"); done < <(list_entries "$MIGRATIONS_FILE")
FUNCTIONS=()          # names
FUNCTION_FLAGS=()     # extra deploy flags for each (the rest of its line in FUNCTIONS.txt, e.g. --no-verify-jwt)
FUNCTION_SCHEDULES=() # schedule=<sql file>: applied after the function is deployed (and its dry run looked fine)
while IFS= read -r line; do
  name="${line%% *}"
  rest=""; [ "$line" = "$name" ] || rest="${line#* }"
  flags=""; sched=""
  for w in $rest; do
    case "$w" in schedule=*) sched="${w#schedule=}" ;; *) flags="$flags $w" ;; esac
  done
  FUNCTIONS+=("$name"); FUNCTION_FLAGS+=("${flags# }"); FUNCTION_SCHEDULES+=("$sched")
done < <(sed -e 's/#.*//' "$FUNCTIONS_FILE" | awk 'NF { $1=$1; print }')
[ "${#MIGRATIONS[@]}" -gt 0 ] || fail "$MIGRATIONS_FILE lists no migrations"
for f in "${MIGRATIONS[@]}"; do [ -f "supabase/$f" ] || fail "migration listed but not found: supabase/$f"; done
for f in "${FUNCTIONS[@]}"; do [ -d "supabase/functions/$f" ] || fail "function listed but not found: supabase/functions/$f"; done
for s in "${FUNCTION_SCHEDULES[@]}"; do [ -z "$s" ] || [ -f "$s" ] || fail "schedule file listed but not found: $s"; done
echo "migrations: ${#MIGRATIONS[@]}   functions: ${#FUNCTIONS[@]}"
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: you have uncommitted changes; the update is built from this working tree."
fi

# ── 1. Code and dependencies ─────────────────────────────────────────────────
step "bun install"
if [ -n "$DRY" ]; then
  echo "[dry run] bun install"
else
  command -v bun >/dev/null 2>&1 || fail "bun is not installed (https://bun.sh)"
  bun install
fi
step "check the EAS login"
if [ -n "$DRY" ]; then
  echo "[dry run] npx --yes eas-cli whoami"
else
  npx --yes eas-cli whoami >/dev/null 2>&1 || fail "not logged in to EAS: set EXPO_TOKEN, or run: npx eas-cli login"
fi

# ── 2. Migrations (Supabase Management API, one request per file; stops on the first error) ────────────────────────────────────────────────────────────
APPLIED=()
for f in "${MIGRATIONS[@]}"; do
  step "migration $f"
  if [ -n "$DRY" ]; then
    echo "[dry run] POST api.supabase.com/v1/projects/$PROJECT_REF/database/query  (supabase/$f, $(wc -c < "supabase/$f" | tr -d ' ') bytes)"
  else
    node "$SQL_RUNNER" file "supabase/$f"
  fi
  APPLIED+=("$f")
done

# ── 3. Edge Functions ────────────────────────────────────────────────────────
# --use-api bundles on Supabase's side (no Docker needed, e.g. in a Codespace). Extra flags per function come from FUNCTIONS.txt.
DEPLOYED=()
SCHEDULED=()
SCHEDULE_FAILED=()
for i in "${!FUNCTIONS[@]}"; do
  f="${FUNCTIONS[$i]}"
  EXTRA=()
  # shellcheck disable=SC2206
  [ -z "${FUNCTION_FLAGS[$i]}" ] || EXTRA=(${FUNCTION_FLAGS[$i]})
  step "deploy function $f"
  if [ -n "$DRY" ]; then
    echo "[dry run] npx --yes supabase functions deploy $f --project-ref $PROJECT_REF --use-api ${EXTRA[*]:-}"
  else
    npx --yes supabase functions deploy "$f" --project-ref "$PROJECT_REF" --use-api ${EXTRA[@]+"${EXTRA[@]}"}
  fi
  DEPLOYED+=("$f")

  # A function with a schedule: look at its dry run, keep the pg_cron job's key in Vault, apply the (idempotent) schedule.
  # A problem here is reported at the end but does not stop the release (the app update must not depend on it).
  sched="${FUNCTION_SCHEDULES[$i]}"
  if [ -n "$sched" ]; then
    step "$f: dry run (lists what it would delete, deletes nothing)"
    if [ -n "$DRY" ]; then
      echo "[dry run] node scripts/supabase-service.mjs dry-run $f"
      echo "[dry run] node scripts/supabase-service.mjs vault-sync"
      echo "[dry run] POST api.supabase.com/v1/projects/$PROJECT_REF/database/query  ($sched)"
      SCHEDULED+=("$f")
    elif node scripts/supabase-service.mjs dry-run "$f" \
      && step "$f: store the service role key in Vault" && node scripts/supabase-service.mjs vault-sync \
      && step "$f: apply $sched" && node "$SQL_RUNNER" file "$sched"; then
      SCHEDULED+=("$f")
    else
      SCHEDULE_FAILED+=("$f")
    fi
  fi
done

# ── 4. App update ────────────────────────────────────────────────────────────
step "publish the app update (EAS, production)"
if [ -n "$DRY" ]; then
  echo "[dry run] npx --yes eas-cli update --channel production --environment production --message \"$MESSAGE\" --non-interactive"
else
  npx --yes eas-cli update --channel production --environment production --message "$MESSAGE" --non-interactive
fi

# ── 5. Reminders (not errors) ────────────────────────────────────────────────
NOTES=()
if [ -z "$DRY" ]; then
  if node "$SQL_RUNNER" query "select count(*) as n from vault.decrypted_secrets where name = 'trial_contact_pepper'" 2>/dev/null | grep -q '"n":[ ]*0'; then
    NOTES+=("Vault secret trial_contact_pepper is not set (phone numbers cannot be saved): select vault.create_secret('<64+ random characters>', 'trial_contact_pepper');")
  fi
  if node "$SQL_RUNNER" query "select count(*) as n from vault.decrypted_secrets where name = 'tryal_invite_secret'" 2>/dev/null | grep -q '"n":[ ]*0'; then
    NOTES+=("Vault secret tryal_invite_secret is not set (friend invite links cannot be made): select vault.create_secret('<64+ random characters>', 'tryal_invite_secret');")
  fi
  for f in "${SCHEDULE_FAILED[@]}"; do
    NOTES+=("$f is deployed but its dry run / schedule did NOT go through (see the message above); the files stay queued until it does. Run ./ship.sh again after fixing it.")
  done
fi

# ── Summary ──────────────────────────────────────────────────────────────────
printf '\n==================== shipped%s ====================\n' "${DRY:+ (DRY RUN)}"
printf 'commit:      %s\n' "$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
printf 'message:     %s\n' "$MESSAGE"
printf 'migrations:  %s applied\n' "${#APPLIED[@]}"
for f in "${APPLIED[@]}"; do printf '               - %s\n' "$f"; done
printf 'functions:   %s deployed\n' "${#DEPLOYED[@]}"
for f in "${DEPLOYED[@]}"; do printf '               - %s\n' "$f"; done
for f in "${SCHEDULED[@]}"; do printf 'scheduled:   %s (pg_cron, every 15 minutes)\n' "$f"; done
printf 'app update:  published to the production channel\n'
if [ "${#NOTES[@]}" -gt 0 ]; then
  printf '\nTo do by hand:\n'
  for n in "${NOTES[@]}"; do printf '  * %s\n' "$n"; done
fi
