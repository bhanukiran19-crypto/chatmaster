import type { Request } from 'express';
import type { AuthSession } from './auth.contracts.js';

export type AuthenticatedTenantContext = {
  userId: string;
  sessionId: string;
  tenantId: string;
  user: AuthSession['user'];
};

export type TenantContextRequest = Request & {
  tenantContext?: AuthenticatedTenantContext;
};
