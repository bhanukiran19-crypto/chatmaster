#!/usr/bin/env bash
# Seeds two tenants as the migration role, then verifies tenant isolation and
# least-privilege as the app role. Expects DATABASE_URL and APP_DATABASE_URL
# (loads ../../.env when present). Exits non-zero on any FAIL.
set -euo pipefail
cd "$(dirname "$0")/.."

if [[ -f ../../.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source ../../.env
  set +a
fi

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${APP_DATABASE_URL:?APP_DATABASE_URL is required}"

# psql does not understand Prisma's ?schema= parameter.
MIGRATOR_URL="${DATABASE_URL%%\?*}"
APP_URL="${APP_DATABASE_URL%%\?*}"

psql "$MIGRATOR_URL" -q -v ON_ERROR_STOP=1 -f scripts/rls-smoke-seed.sql
output="$(psql "$APP_URL" -f scripts/rls-smoke-test.sql 2>&1)"
echo "$output"

passes=$(grep -c '^ PASS' <<<"$output" || true)
fails=$(grep -c 'FAIL' <<<"$output" || true)
created=$(grep -c '^CREATE TABLE' <<<"$output" || true)
echo
echo "PASS=$passes FAIL=$fails"
if [[ "$fails" -ne 0 || "$created" -ne 0 ]]; then
  echo "RLS smoke test FAILED" >&2
  exit 1
fi
echo "RLS smoke test passed"
