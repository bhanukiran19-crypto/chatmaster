import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

/**
 * Opaque keyset cursor over the list order (priority ASC, id ASC). Keyset
 * pagination stays O(page) at any depth, unlike OFFSET. The cursor is not a
 * security boundary: queries are always tenant-filtered and RLS-scoped.
 */
const cursorSchema = z.strictObject({ p: z.number().int(), id: z.uuid() });

export interface WorkflowCursor {
  priority: number;
  id: string;
}

export function encodeWorkflowCursor(cursor: WorkflowCursor): string {
  return Buffer.from(JSON.stringify({ p: cursor.priority, id: cursor.id }), 'utf8').toString(
    'base64url',
  );
}

export function decodeWorkflowCursor(raw: string): WorkflowCursor {
  try {
    const parsed = cursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { priority: parsed.p, id: parsed.id };
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}
