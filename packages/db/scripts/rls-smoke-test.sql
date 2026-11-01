-- RLS / least-privilege smoke test. Run as the APP role (chatmaster_api) after
-- seeding with scripts/rls-smoke-seed.sql as the migration role:
--   psql "$DATABASE_URL"     -f scripts/rls-smoke-seed.sql
--   psql "$APP_DATABASE_URL" -f scripts/rls-smoke-test.sql
-- Every statement below prints PASS/FAIL; a failed DDL/DML attempt is the
-- expected result where noted.
\set ON_ERROR_STOP off
\pset footer off

\echo '--- no context: must see 0 rows everywhere'
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_ctx_tenants FROM tenants;
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_ctx_connections FROM platform_connections;
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS no_ctx_users FROM users;

\echo '--- tenant A context: sees only A'
BEGIN;
SELECT set_config('app.tenant_id', '11111111-1111-4111-8111-111111111111', true);
SELECT CASE WHEN count(*) = 1 AND bool_and(name = 'Tenant A') THEN 'PASS' ELSE 'FAIL' END AS a_sees_only_a FROM tenants;
SELECT CASE WHEN count(*) = 1 AND bool_and(display_name = '@bot_a') THEN 'PASS' ELSE 'FAIL' END AS a_sees_only_a_connection FROM platform_connections;
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS a_sees_only_a_workflow FROM workflows;
-- update of B's row by id must affect 0 rows
UPDATE workflows SET name = 'hacked' WHERE id = 'bbbbbbbb-0000-4000-8000-000000000002';
SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM workflows WHERE name = 'hacked') THEN 'PASS' ELSE 'FAIL' END AS a_cannot_update_b;
-- insert into B's tenant must be rejected by WITH CHECK (expect ERROR below)
\echo 'expect ERROR: new row violates row-level security policy'
INSERT INTO workflows (id, tenant_id, platform_connection_id, name, updated_at)
VALUES (gen_random_uuid(), '22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000001', 'smuggled', now());
ROLLBACK;

\echo '--- webhook context: can resolve connection by path id only'
BEGIN;
SELECT set_config('app.context', 'webhook', true);
SELECT set_config('app.webhook_path_id', 'path_a_0123456789abcdef', true);
SELECT CASE WHEN count(*) = 1 AND bool_and(tenant_id = '11111111-1111-4111-8111-111111111111') THEN 'PASS' ELSE 'FAIL' END AS webhook_resolves_a FROM platform_connections;
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS webhook_cannot_list_workflows FROM workflows;
\echo 'expect ERROR / 0 rows: webhook context cannot write connections'
UPDATE platform_connections SET last_error = 'x' WHERE webhook_path_id = 'path_a_0123456789abcdef';
SELECT CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS webhook_update_was_noop FROM platform_connections WHERE last_error = 'x';
ROLLBACK;

\echo '--- auth context: can find user by email, user context sees only self'
BEGIN;
SELECT set_config('app.context', 'auth', true);
SELECT CASE WHEN count(*) = 1 THEN 'PASS' ELSE 'FAIL' END AS auth_finds_user_by_email FROM users WHERE email = 'A@GMAIL.COM';
ROLLBACK;
BEGIN;
SELECT set_config('app.user_id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', true);
SELECT CASE WHEN count(*) = 1 AND bool_and(email = 'a@gmail.com') THEN 'PASS' ELSE 'FAIL' END AS user_sees_only_self FROM users;
SELECT CASE WHEN count(*) = 1 AND bool_and(name = 'Tenant A') THEN 'PASS' ELSE 'FAIL' END AS user_sees_own_tenant FROM tenants;
ROLLBACK;

\echo '--- least privilege (each of the following must ERROR)'
\echo 'expect ERROR: permission denied for schema public (CREATE TABLE)'
CREATE TABLE should_fail (id int);
\echo 'expect ERROR: must be owner (DROP TABLE)'
DROP TABLE workflows;
\echo 'expect ERROR: permission denied (plans are read-only)'
UPDATE plans SET price_cents = 0;
\echo 'expect ERROR: permission denied (audit_logs append-only)'
DELETE FROM audit_logs;
\echo 'expect ERROR: permission denied (_prisma_migrations not granted)'
SELECT count(*) FROM _prisma_migrations;
\echo 'expect ERROR: cannot disable RLS'
ALTER TABLE workflows DISABLE ROW LEVEL SECURITY;
\echo '--- plans readable without context'
SELECT CASE WHEN count(*) >= 1 THEN 'PASS' ELSE 'FAIL' END AS plans_public_read FROM plans;
