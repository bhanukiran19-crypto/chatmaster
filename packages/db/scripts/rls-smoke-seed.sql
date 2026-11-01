-- Seed for scripts/rls-smoke-test.sql. Run as the migration/owner role, which
-- bypasses RLS. Idempotent.
\set ON_ERROR_STOP on
BEGIN;
DELETE FROM tenants WHERE id IN ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
DELETE FROM users WHERE email IN ('a@gmail.com', 'b@gmail.com');
DELETE FROM plans WHERE code = 'smoke_free';

INSERT INTO plans (id, code, name, price_cents, active_contact_limit, is_default, updated_at)
VALUES (gen_random_uuid(), 'smoke_free', 'Free (smoke)', 0, 100, false, now());

INSERT INTO users (id, email, phone_e164, password_hash, status, updated_at) VALUES
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a@gmail.com', '+919000000001', '$argon2id$placeholder', 'ACTIVE', now()),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b@gmail.com', '+919000000002', '$argon2id$placeholder', 'ACTIVE', now());

INSERT INTO tenants (id, name, owner_user_id, updated_at) VALUES
  ('11111111-1111-4111-8111-111111111111', 'Tenant A', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', now()),
  ('22222222-2222-4222-8222-222222222222', 'Tenant B', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', now());

INSERT INTO platform_connections
  (id, tenant_id, platform, status, external_account_id, display_name, encrypted_token, token_key_version, webhook_path_id, secret_token_hash, updated_at)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', '11111111-1111-4111-8111-111111111111', 'TELEGRAM', 'ACTIVE', '1001', '@bot_a', '\x00'::bytea, 1, 'path_a_0123456789abcdef', repeat('a', 64), now()),
  ('bbbbbbbb-0000-4000-8000-000000000001', '22222222-2222-4222-8222-222222222222', 'TELEGRAM', 'ACTIVE', '1002', '@bot_b', '\x00'::bytea, 1, 'path_b_0123456789abcdef', repeat('b', 64), now());

INSERT INTO workflows (id, tenant_id, platform_connection_id, name, updated_at) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000002', '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-0000-4000-8000-000000000001', 'Welcome A', now()),
  ('bbbbbbbb-0000-4000-8000-000000000002', '22222222-2222-4222-8222-222222222222', 'bbbbbbbb-0000-4000-8000-000000000001', 'Welcome B', now());
COMMIT;
