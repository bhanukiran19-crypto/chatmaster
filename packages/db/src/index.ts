export { Prisma, PrismaClient } from '@prisma/client';
export type * from '@prisma/client';
export * from './tenant-context.js';
export { createTenantPrismaClient, type TenantSafePrismaClient } from './tenant-prisma-client.js';
