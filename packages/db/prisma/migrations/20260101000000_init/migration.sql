-- Enable case-insensitive text for user emails (used by users.email).
CREATE EXTENSION IF NOT EXISTS citext;

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('TELEGRAM', 'INSTAGRAM', 'FACEBOOK', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING_VERIFICATION', 'ACTIVE', 'LOCKED', 'DISABLED');

-- CreateEnum
CREATE TYPE "VerificationChannel" AS ENUM ('EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFY', 'PHONE_VERIFY', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "TriggerType" AS ENUM ('EXACT', 'CONTAINS', 'COMMAND', 'ANY', 'START');

-- CreateEnum
CREATE TYPE "ParseMode" AS ENUM ('NONE', 'HTML', 'MARKDOWN_V2');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateEnum
CREATE TYPE "ButtonType" AS ENUM ('URL', 'CALLBACK');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" CITEXT NOT NULL,
    "email_verified_at" TIMESTAMPTZ(3),
    "phone_e164" VARCHAR(20) NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(3),
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tenants" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "owner_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "user_agent" VARCHAR(512),
    "ip_address" INET,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "revoke_reason" VARCHAR(64),
    "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_tokens" (
    "id" UUID NOT NULL,
    "session_id" UUID NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "replaced_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "channel" "VerificationChannel" NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "target" VARCHAR(320) NOT NULL,
    "code_hash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "consumed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "platform_connections" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "external_account_id" VARCHAR(128) NOT NULL,
    "display_name" VARCHAR(128) NOT NULL,
    "encrypted_token" BYTEA NOT NULL,
    "token_key_version" INTEGER NOT NULL,
    "webhook_path_id" VARCHAR(128) NOT NULL,
    "secret_token_hash" CHAR(64) NOT NULL,
    "last_webhook_at" TIMESTAMPTZ(3),
    "last_error" VARCHAR(1024),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "platform_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflows" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform_connection_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "cooldown_seconds" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_triggers" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "type" "TriggerType" NOT NULL,
    "value" VARCHAR(512),
    "case_insensitive" BOOLEAN NOT NULL DEFAULT true,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_triggers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_replies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "workflow_id" UUID NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "text" VARCHAR(4096) NOT NULL,
    "parse_mode" "ParseMode" NOT NULL DEFAULT 'NONE',
    "media_type" "MediaType",
    "media_object_key" VARCHAR(512),
    "media_mime_type" VARCHAR(128),
    "media_size_bytes" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workflow_replies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_reply_buttons" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reply_id" UUID NOT NULL,
    "row" INTEGER NOT NULL DEFAULT 0,
    "column" INTEGER NOT NULL DEFAULT 0,
    "type" "ButtonType" NOT NULL,
    "label" VARCHAR(64) NOT NULL,
    "url" VARCHAR(2048),
    "next_reply_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "workflow_reply_buttons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_contacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform" "Platform" NOT NULL,
    "external_chat_id" VARCHAR(128) NOT NULL,
    "month" DATE NOT NULL,
    "first_replied_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_updates" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "platform_connection_id" UUID NOT NULL,
    "update_id" BIGINT NOT NULL,
    "processed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_updates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID,
    "actor_user_id" UUID,
    "action" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(64),
    "entity_id" VARCHAR(128),
    "metadata" JSONB,
    "ip_address" INET,
    "user_agent" VARCHAR(512),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" UUID NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'USD',
    "active_contact_limit" INTEGER NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "plan_id" UUID NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "current_period_start" TIMESTAMPTZ(3) NOT NULL,
    "current_period_end" TIMESTAMPTZ(3) NOT NULL,
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "external_ref" VARCHAR(128),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_e164_key" ON "users"("phone_e164");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_owner_user_id_key" ON "tenants"("owner_user_id");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_tokens_token_hash_key" ON "refresh_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_tokens_session_id_idx" ON "refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_expires_at_idx" ON "refresh_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "verification_codes_user_id_purpose_created_at_idx" ON "verification_codes"("user_id", "purpose", "created_at");

-- CreateIndex
CREATE INDEX "verification_codes_expires_at_idx" ON "verification_codes"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "platform_connections_webhook_path_id_key" ON "platform_connections"("webhook_path_id");

-- CreateIndex
CREATE INDEX "platform_connections_tenant_id_platform_idx" ON "platform_connections"("tenant_id", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "platform_connections_tenant_id_platform_external_account_id_key" ON "platform_connections"("tenant_id", "platform", "external_account_id");

-- CreateIndex
CREATE INDEX "workflows_tenant_id_idx" ON "workflows"("tenant_id");

-- CreateIndex
CREATE INDEX "workflows_platform_connection_id_enabled_priority_idx" ON "workflows"("platform_connection_id", "enabled", "priority");

-- CreateIndex
CREATE INDEX "workflow_triggers_tenant_id_idx" ON "workflow_triggers"("tenant_id");

-- CreateIndex
CREATE INDEX "workflow_triggers_workflow_id_position_idx" ON "workflow_triggers"("workflow_id", "position");

-- CreateIndex
CREATE INDEX "workflow_replies_tenant_id_idx" ON "workflow_replies"("tenant_id");

-- CreateIndex
CREATE INDEX "workflow_replies_workflow_id_position_idx" ON "workflow_replies"("workflow_id", "position");

-- CreateIndex
CREATE INDEX "workflow_reply_buttons_tenant_id_idx" ON "workflow_reply_buttons"("tenant_id");

-- CreateIndex
CREATE INDEX "workflow_reply_buttons_next_reply_id_idx" ON "workflow_reply_buttons"("next_reply_id");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_reply_buttons_reply_id_row_column_key" ON "workflow_reply_buttons"("reply_id", "row", "column");

-- CreateIndex
CREATE INDEX "active_contacts_tenant_id_month_idx" ON "active_contacts"("tenant_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "active_contacts_tenant_id_platform_external_chat_id_month_key" ON "active_contacts"("tenant_id", "platform", "external_chat_id", "month");

-- CreateIndex
CREATE INDEX "processed_updates_tenant_id_idx" ON "processed_updates"("tenant_id");

-- CreateIndex
CREATE INDEX "processed_updates_processed_at_idx" ON "processed_updates"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "processed_updates_platform_connection_id_update_id_key" ON "processed_updates"("platform_connection_id", "update_id");

-- CreateIndex
CREATE INDEX "audit_logs_tenant_id_created_at_idx" ON "audit_logs"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_actor_user_id_created_at_idx" ON "audit_logs"("actor_user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "plans_code_key" ON "plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_tenant_id_key" ON "subscriptions"("tenant_id");

-- CreateIndex
CREATE INDEX "subscriptions_plan_id_idx" ON "subscriptions"("plan_id");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "verification_codes" ADD CONSTRAINT "verification_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_connections" ADD CONSTRAINT "platform_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_platform_connection_id_fkey" FOREIGN KEY ("platform_connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_triggers" ADD CONSTRAINT "workflow_triggers_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_replies" ADD CONSTRAINT "workflow_replies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_replies" ADD CONSTRAINT "workflow_replies_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "workflows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_reply_buttons" ADD CONSTRAINT "workflow_reply_buttons_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_reply_buttons" ADD CONSTRAINT "workflow_reply_buttons_reply_id_fkey" FOREIGN KEY ("reply_id") REFERENCES "workflow_replies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_reply_buttons" ADD CONSTRAINT "workflow_reply_buttons_next_reply_id_fkey" FOREIGN KEY ("next_reply_id") REFERENCES "workflow_replies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_contacts" ADD CONSTRAINT "active_contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_updates" ADD CONSTRAINT "processed_updates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processed_updates" ADD CONSTRAINT "processed_updates_platform_connection_id_fkey" FOREIGN KEY ("platform_connection_id") REFERENCES "platform_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Data integrity constraints not expressible in the Prisma schema
-- ===========================================================================

ALTER TABLE "workflow_triggers"
  ADD CONSTRAINT "workflow_triggers_value_matches_type_check"
  CHECK (
    ("type" IN ('ANY', 'START') AND "value" IS NULL)
    OR ("type" NOT IN ('ANY', 'START') AND "value" IS NOT NULL AND length(btrim("value")) > 0)
  );

ALTER TABLE "workflow_reply_buttons"
  ADD CONSTRAINT "workflow_reply_buttons_payload_matches_type_check"
  CHECK (
    ("type" = 'URL' AND "url" IS NOT NULL AND "next_reply_id" IS NULL)
    OR ("type" = 'CALLBACK' AND "next_reply_id" IS NOT NULL AND "url" IS NULL)
  );

ALTER TABLE "workflow_reply_buttons"
  ADD CONSTRAINT "workflow_reply_buttons_url_scheme_check"
  CHECK ("url" IS NULL OR "url" ~* '^(https?|tg)://');

ALTER TABLE "workflows"
  ADD CONSTRAINT "workflows_cooldown_non_negative_check" CHECK ("cooldown_seconds" >= 0);

ALTER TABLE "workflow_replies"
  ADD CONSTRAINT "workflow_replies_media_fields_check"
  CHECK (
    ("media_type" IS NULL AND "media_object_key" IS NULL AND "media_mime_type" IS NULL AND "media_size_bytes" IS NULL)
    OR ("media_type" IS NOT NULL AND "media_object_key" IS NOT NULL AND "media_mime_type" IS NOT NULL AND "media_size_bytes" > 0)
  );

ALTER TABLE "active_contacts"
  ADD CONSTRAINT "active_contacts_month_is_first_day_check"
  CHECK ("month" = date_trunc('month', "month")::date);

ALTER TABLE "plans"
  ADD CONSTRAINT "plans_non_negative_check"
  CHECK ("price_cents" >= 0 AND "active_contact_limit" >= 0);

ALTER TABLE "users"
  ADD CONSTRAINT "users_phone_e164_format_check" CHECK ("phone_e164" ~ '^\+[1-9][0-9]{6,14}$');

-- ===========================================================================
-- Roles (least privilege)
-- ===========================================================================
--
--   * The role running this migration (e.g. chatmaster_migrator) OWNS every
--     object and is the only role allowed to run DDL. It bypasses RLS as the
--     table owner and must NEVER be used by the API or worker at runtime.
--   * chatmaster_app is a NOLOGIN group role holding the runtime privileges:
--     DML on application tables only, no DDL, no BYPASSRLS, RLS enforced.
--   * The actual LOGIN role(s) used by apps/api and apps/worker are created
--     outside migrations (docker/postgres/init/01-app-role.sh locally, your
--     infrastructure in production) and are made members of chatmaster_app.
--     Locally that role is chatmaster_api.
--   * Both roles are normally pre-created by the init script / infrastructure
--     (the migration role then needs no CREATEROLE). The block below is a
--     fallback that creates/links them only when missing.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatmaster_app') THEN
    CREATE ROLE "chatmaster_app"
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chatmaster_api')
     AND NOT EXISTS (
       SELECT 1 FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles u ON u.oid = m.member
       WHERE g.rolname = 'chatmaster_app' AND u.rolname = 'chatmaster_api'
     ) THEN
    GRANT "chatmaster_app" TO "chatmaster_api";
  END IF;
END
$$;

-- Nobody but the owner may create objects in the public schema.
REVOKE CREATE ON SCHEMA "public" FROM PUBLIC;
GRANT USAGE ON SCHEMA "public" TO "chatmaster_app";

-- Runtime DML privileges. Prisma's bookkeeping table is deliberately excluded.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  "users", "tenants", "sessions", "refresh_tokens", "verification_codes",
  "platform_connections", "workflows", "workflow_triggers", "workflow_replies",
  "workflow_reply_buttons", "active_contacts", "processed_updates",
  "subscriptions"
TO "chatmaster_app";

-- Audit log is append-only for the application.
GRANT SELECT, INSERT ON "audit_logs" TO "chatmaster_app";

-- Plans are managed by operators/seeds, read-only for the application.
GRANT SELECT ON "plans" TO "chatmaster_app";

-- ===========================================================================
-- Row-Level Security
-- ===========================================================================
--
-- The application sets per-transaction context with
--   SELECT set_config('app.tenant_id',        '<uuid>', true);
--   SELECT set_config('app.user_id',          '<uuid>', true);
--   SELECT set_config('app.webhook_path_id',  '<id>',   true);   -- webhook intake only
--   SELECT set_config('app.context',          'auth'|'webhook', true);
-- (`set_config(..., true)` is the parameterisable form of SET LOCAL.)
-- Unset settings read as NULL, which makes every policy below evaluate to
-- false, so a query without context sees no rows.

CREATE SCHEMA IF NOT EXISTS "app";
GRANT USAGE ON SCHEMA "app" TO "chatmaster_app";

CREATE OR REPLACE FUNCTION "app"."current_tenant_id"() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION "app"."current_user_id"() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION "app"."current_webhook_path_id"() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.webhook_path_id', true), '') $$;

CREATE OR REPLACE FUNCTION "app"."current_context"() RETURNS text
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.context', true), '') $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA "app" FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA "app" TO "chatmaster_app";

-- ---- Identity tables (scoped by user; 'auth' context for pre-login lookups)

ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_self_or_auth" ON "users"
  FOR ALL TO "chatmaster_app"
  USING ("id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth')
  WITH CHECK ("id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth');

ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "sessions_owner_or_auth" ON "sessions"
  FOR ALL TO "chatmaster_app"
  USING ("user_id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth')
  WITH CHECK ("user_id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth');

ALTER TABLE "refresh_tokens" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "refresh_tokens_owner_or_auth" ON "refresh_tokens"
  FOR ALL TO "chatmaster_app"
  USING (
    "app"."current_context"() = 'auth'
    OR EXISTS (
      SELECT 1 FROM "sessions" s
      WHERE s."id" = "refresh_tokens"."session_id" AND s."user_id" = "app"."current_user_id"()
    )
  )
  WITH CHECK (
    "app"."current_context"() = 'auth'
    OR EXISTS (
      SELECT 1 FROM "sessions" s
      WHERE s."id" = "refresh_tokens"."session_id" AND s."user_id" = "app"."current_user_id"()
    )
  );

ALTER TABLE "verification_codes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "verification_codes_owner_or_auth" ON "verification_codes"
  FOR ALL TO "chatmaster_app"
  USING ("user_id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth')
  WITH CHECK ("user_id" = "app"."current_user_id"() OR "app"."current_context"() = 'auth');

-- ---- Tenant root

ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tenants_member_or_owner" ON "tenants"
  FOR ALL TO "chatmaster_app"
  USING ("id" = "app"."current_tenant_id"() OR "owner_user_id" = "app"."current_user_id"())
  WITH CHECK ("id" = "app"."current_tenant_id"() OR "owner_user_id" = "app"."current_user_id"());

-- ---- Tenant-owned tables

ALTER TABLE "platform_connections" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "platform_connections_tenant" ON "platform_connections"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());
-- Webhook intake resolves the connection (and thus the tenant) by the random
-- path id before any tenant context exists. Read-only; the handler then sets
-- app.tenant_id for everything else.
CREATE POLICY "platform_connections_webhook_lookup" ON "platform_connections"
  FOR SELECT TO "chatmaster_app"
  USING (
    "app"."current_context"() = 'webhook'
    AND "webhook_path_id" = "app"."current_webhook_path_id"()
  );

ALTER TABLE "workflows" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflows_tenant" ON "workflows"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "workflow_triggers" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflow_triggers_tenant" ON "workflow_triggers"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "workflow_replies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflow_replies_tenant" ON "workflow_replies"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "workflow_reply_buttons" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "workflow_reply_buttons_tenant" ON "workflow_reply_buttons"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "active_contacts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "active_contacts_tenant" ON "active_contacts"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "processed_updates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "processed_updates_tenant" ON "processed_updates"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions_tenant" ON "subscriptions"
  FOR ALL TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"())
  WITH CHECK ("tenant_id" = "app"."current_tenant_id"());

-- ---- Audit log: tenant-scoped reads; append-only writes (pre-tenant events
--      such as signup/login failures are allowed with a NULL tenant in 'auth').

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "audit_logs_tenant_read" ON "audit_logs"
  FOR SELECT TO "chatmaster_app"
  USING ("tenant_id" = "app"."current_tenant_id"());
CREATE POLICY "audit_logs_append" ON "audit_logs"
  FOR INSERT TO "chatmaster_app"
  WITH CHECK (
    "tenant_id" = "app"."current_tenant_id"()
    OR ("tenant_id" IS NULL AND "app"."current_context"() = 'auth')
  );

-- ---- Plans: public catalogue, read-only for the application.

ALTER TABLE "plans" ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plans_public_read" ON "plans"
  FOR SELECT TO "chatmaster_app"
  USING ("is_active" = true);
