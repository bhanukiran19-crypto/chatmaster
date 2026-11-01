# Work log

Append a concise but complete entry here before ending each task. Include the scope, implementation details, validation performed, and any remaining setup or caveats. Do not include secrets, tokens, OTPs, passwords, or other credentials.

## 2026-10-29 — API authentication

Implemented authentication in `apps/api` using the existing NestJS, Prisma, and tenant-RLS setup.

### Delivered

- Added strict Zod request schemas for signup, login, email/mobile verification, password reset, and auth cookies. Signup requires a Gmail address, E.164 mobile number, and a 12–128 character password; login accepts email or mobile.
- Added signup with separately persisted email-verification and SMS-OTP challenges. Email tokens are SHA-256 hashed at rest; OTPs and passwords are Argon2id hashed. Login is unavailable until both verification channels are complete.
- Added email-or-mobile login, failed-attempt tracking, five-attempt account lockout, and lockout reset after a successful login.
- Added short-lived signed access JWTs and rotating opaque refresh tokens. Only refresh-token hashes are persisted; replay of an already-used refresh token revokes its session.
- Added `Secure`, `HttpOnly`, `SameSite=Lax`, host-prefixed auth cookies; signed double-submit CSRF protection; logout; and server-side session checks.
- Added password-reset request/completion. Reset challenges are hashed, one-use, time-limited, and reset revokes active sessions.
- Added Redis-backed sliding-window rate limiting with both per-IP and per-IP-plus-subject keys. Supports the connected `KV_REST_API_URL`/`KV_REST_API_TOKEN` values and a `REDIS_URL` fallback.
- Added auth audit events for signup, verification, login failures/success, lockout, refresh rotation/reuse, logout, and password reset.
- Added startup Zod environment checks, request-size limits, exact-origin credentialed CORS, strict API CSP/security headers, request IDs, and Pino structured logging with secret redaction.
- Added `SmsProvider` and email-provider interfaces with development console adapters. They intentionally emit redacted delivery notices rather than logging OTPs or links.
- Added `.env.example` with placeholders only, including required database/JWT settings and optional test-database setup.

### Validation

- API TypeScript check passed.
- API build passed.
- Auth unit tests passed: signup/email+mobile verification, password reset/session revocation, brute-force lockout, disabled-account protection, refresh rotation/reuse detection, Zod boundaries, cookie validation, and CSRF guard behavior.
- PostgreSQL auth and tenant-RLS integration tests are present but were skipped because `TEST_DATABASE_URL` was not configured. Use an isolated test database with the least-privilege `chatmaster_api` role to run them.
- `git diff --check` passed.

### Remaining setup / caveats

- Set `DATABASE_URL` and a cryptographically random `AUTH_JWT_SECRET` (at least 32 bytes) in the runtime environment.
- Replace the development email/SMS adapters with real delivery providers before production. The development adapters redact verification secrets by design.
- Set `TEST_DATABASE_URL` to an isolated database using the application role to execute the PostgreSQL integration tests.

## 2026-10-29 — Tenant-scoped PostgreSQL context

### Delivered

- Split database access into strict `withTenantScope` (required tenant UUID), `withAuthScope` (identity/pre-login), and `withWebhookLookupScope` boundaries. Every transaction sets all RLS settings with parameterized `set_config(..., true)` and clears unset settings locally.
- Added an async-local tenant transaction accessor that throws when tenant data access is attempted outside a tenant-scoped transaction.
- Added an authenticated tenant guard that validates the active access-token session and resolves the tenant from the authenticated user in the database. The global interceptor wraps guarded handlers in a transaction carrying `app.tenant_id` and `app.user_id`; `/auth/me` now uses this protected path.
- Migrated auth persistence to the explicit auth scope and added a tenant lookup method for request authentication.
- Expanded PostgreSQL RLS integration coverage to verify cross-tenant reads, updates, and deletes are blocked on tenant and tenant-owned contact rows when the attacker supplies another tenant's IDs. It also verifies the target rows remain unchanged.
- Added unit coverage for fail-closed transaction access, transaction-local settings, authenticated tenant resolution, and interceptor behavior.

### Validation

- `@chatmaster/db` build passed.
- API typecheck and build passed.
- API unit tests passed, including tenant-context enforcement.
- `git diff --check` passed.
- PostgreSQL integration tests are present but skipped because `TEST_DATABASE_URL` is not configured in this workspace. They require an isolated test database using the least-privilege `chatmaster_api` role.
