-- Keyset pagination for the workflow list endpoint: ORDER BY priority, id within a tenant.
CREATE INDEX "workflows_tenant_id_priority_id_idx" ON "workflows"("tenant_id", "priority", "id");
