#!/usr/bin/env bash
# Runs once on first database initialisation (docker-entrypoint-initdb.d), as
# the Postgres superuser. Creates:
#   * chatmaster_app  - NOLOGIN group role. The Prisma migration grants it DML
#                       privileges and attaches RLS policies to it.
#   * $APP_DB_USER    - LOGIN role used by apps/api and apps/worker, member of
#                       chatmaster_app. Cannot create objects or bypass RLS.
# $POSTGRES_USER (the migration/owner role) is created by the image itself.
set -euo pipefail

: "${APP_DB_USER:?APP_DB_USER is required}"
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

psql -v ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --set=app_user="$APP_DB_USER" \
  --set=app_password="$APP_DB_PASSWORD" <<'SQL'
CREATE ROLE "chatmaster_app"
  NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;

CREATE ROLE :"app_user" LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS;

GRANT "chatmaster_app" TO :"app_user";

-- Belt and braces: on Postgres < 15 the public schema grants CREATE to everyone.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
