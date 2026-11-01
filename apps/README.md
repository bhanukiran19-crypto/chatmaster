# apps/

Deployable applications. Intentionally empty placeholders in this iteration.

| App      | Stack (per `.windsurfrules`)                        | Purpose                                                        |
| -------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `web`    | Next.js App Router + TypeScript + Tailwind + shadcn | Welcome, Dashboard, platform workspaces, workflow builder      |
| `api`    | NestJS + TypeScript                                 | Auth, tenants, platform connections, workflows, webhook intake |
| `worker` | Node + BullMQ                                       | Webhook processing, matching engine, rate-limited Telegram out |
