import { z } from 'zod';

/**
 * Workflow definition contracts shared by the API (validation at the HTTP
 * boundary) and the web app (form validation). Limits mirror Telegram's Bot API
 * constraints and the column sizes in the Prisma schema.
 */
export const WORKFLOW_LIMITS = {
  nameMax: 120,
  priorityMin: 0,
  priorityMax: 1_000_000,
  defaultPriority: 100,
  /** One week. Longer cooldowns are almost always a configuration mistake. */
  cooldownMaxSeconds: 7 * 24 * 60 * 60,
  triggersMax: 20,
  triggerValueMax: 512,
  repliesMax: 10,
  replyTextMax: 4096,
  buttonsPerReplyMax: 24,
  buttonRowMax: 7,
  buttonColumnMax: 7,
  buttonLabelMax: 64,
  urlMax: 2048,
  reorderMax: 500,
  pageSizeDefault: 20,
  pageSizeMax: 100,
} as const;

const uuid = z.uuid();

const nameSchema = z.string().trim().min(1).max(WORKFLOW_LIMITS.nameMax);
const prioritySchema = z
  .number()
  .int()
  .min(WORKFLOW_LIMITS.priorityMin)
  .max(WORKFLOW_LIMITS.priorityMax);
const cooldownSchema = z.number().int().min(0).max(WORKFLOW_LIMITS.cooldownMaxSeconds);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const textTriggerValue = z.string().trim().min(1).max(WORKFLOW_LIMITS.triggerValueMax);

/** Bot API command names: 1-32 chars of [A-Za-z0-9_]. A leading slash is accepted and stripped. */
const commandValue = z
  .string()
  .trim()
  .regex(/^\/?[A-Za-z0-9_]{1,32}$/, 'Not a valid bot command')
  .transform((value) => value.replace(/^\//, ''));

export const workflowTriggerInputSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('EXACT'),
    value: textTriggerValue,
    caseInsensitive: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal('CONTAINS'),
    value: textTriggerValue,
    caseInsensitive: z.boolean().default(true),
  }),
  z.strictObject({
    type: z.literal('COMMAND'),
    value: commandValue,
    caseInsensitive: z.boolean().default(true),
  }),
  z.strictObject({ type: z.literal('ANY') }),
  z.strictObject({ type: z.literal('START') }),
]);

// ---------------------------------------------------------------------------
// Replies and buttons
// ---------------------------------------------------------------------------

/** Client-chosen handle so CALLBACK buttons can reference replies before they have ids. */
const replyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/, 'Reply keys are 1-32 of [A-Za-z0-9_-]');

const buttonUrlSchema = z
  .string()
  .trim()
  .max(WORKFLOW_LIMITS.urlMax)
  .regex(/^(https?|tg):\/\//i, 'Button URLs must use http, https or tg')
  .refine((value) => URL.canParse(value), 'Not a valid URL');

const buttonPosition = {
  row: z.number().int().min(0).max(WORKFLOW_LIMITS.buttonRowMax),
  column: z.number().int().min(0).max(WORKFLOW_LIMITS.buttonColumnMax),
  label: z.string().trim().min(1).max(WORKFLOW_LIMITS.buttonLabelMax),
};

export const workflowButtonInputSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...buttonPosition, type: z.literal('URL'), url: buttonUrlSchema }),
  z.strictObject({ ...buttonPosition, type: z.literal('CALLBACK'), nextReplyKey: replyKeySchema }),
]);

export const workflowReplyInputSchema = z.strictObject({
  key: replyKeySchema,
  /** Existing reply id to keep stable across edits so already-sent keyboards keep working. */
  id: uuid.optional(),
  text: z
    .string()
    .max(WORKFLOW_LIMITS.replyTextMax)
    .refine((value) => value.trim().length > 0, 'Reply text is required'),
  parseMode: z.enum(['NONE', 'HTML', 'MARKDOWN_V2']).default('NONE'),
  buttons: z.array(workflowButtonInputSchema).max(WORKFLOW_LIMITS.buttonsPerReplyMax).default([]),
});

// ---------------------------------------------------------------------------
// Workflow definition
// ---------------------------------------------------------------------------

const definitionShape = {
  name: nameSchema,
  enabled: z.boolean().default(true),
  priority: prioritySchema.default(WORKFLOW_LIMITS.defaultPriority),
  cooldownSeconds: cooldownSchema.default(0),
  triggers: z.array(workflowTriggerInputSchema).min(1).max(WORKFLOW_LIMITS.triggersMax),
  /** replies[0] is the primary reply sent on a trigger match. */
  replies: z.array(workflowReplyInputSchema).min(1).max(WORKFLOW_LIMITS.repliesMax),
};

interface ReplyGraph {
  replies: z.output<typeof workflowReplyInputSchema>[];
}

/** Cross-field rules: unique keys/ids/grid cells and resolvable callback targets. */
function refineReplyGraph(value: ReplyGraph, ctx: z.RefinementCtx): void {
  const keys = new Set<string>();
  const ids = new Set<string>();
  value.replies.forEach((reply, replyIndex) => {
    if (keys.has(reply.key)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Duplicate reply key',
        path: ['replies', replyIndex, 'key'],
      });
    }
    keys.add(reply.key);
    if (reply.id) {
      const normalized = reply.id.toLowerCase();
      if (ids.has(normalized)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Duplicate reply id',
          path: ['replies', replyIndex, 'id'],
        });
      }
      ids.add(normalized);
    }
  });

  value.replies.forEach((reply, replyIndex) => {
    const cells = new Set<string>();
    reply.buttons.forEach((button, buttonIndex) => {
      const path = ['replies', replyIndex, 'buttons', buttonIndex];
      const cell = `${String(button.row)}:${String(button.column)}`;
      if (cells.has(cell)) {
        ctx.addIssue({ code: 'custom', message: 'Two buttons share a grid cell', path });
      }
      cells.add(cell);
      if (button.type === 'CALLBACK' && !keys.has(button.nextReplyKey)) {
        ctx.addIssue({
          code: 'custom',
          message: 'Callback button references an unknown reply key',
          path: [...path, 'nextReplyKey'],
        });
      }
    });
  });
}

export const createWorkflowSchema = z
  .strictObject({ platformConnectionId: uuid, ...definitionShape })
  .superRefine(refineReplyGraph);

/** Full replacement of a workflow's definition (PUT). The connection cannot change. */
export const replaceWorkflowSchema = z.strictObject(definitionShape).superRefine(refineReplyGraph);

/** Metadata-only update (PATCH): rename, enable/disable, reprioritise, change cooldown. */
export const patchWorkflowSchema = z
  .strictObject({
    name: nameSchema.optional(),
    enabled: z.boolean().optional(),
    priority: prioritySchema.optional(),
    cooldownSeconds: cooldownSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');

/**
 * Explicit evaluation order for every workflow on a connection. Must be the
 * complete set so the resulting order is unambiguous.
 */
export const reorderWorkflowsSchema = z
  .strictObject({
    platformConnectionId: uuid,
    workflowIds: z.array(uuid).min(1).max(WORKFLOW_LIMITS.reorderMax),
  })
  .refine(
    (value) =>
      new Set(value.workflowIds.map((id) => id.toLowerCase())).size === value.workflowIds.length,
    { message: 'Workflow ids must be unique', path: ['workflowIds'] },
  );

export const listWorkflowsQuerySchema = z.strictObject({
  platformConnectionId: uuid.optional(),
  enabled: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKFLOW_LIMITS.pageSizeMax)
    .default(WORKFLOW_LIMITS.pageSizeDefault),
  cursor: z
    .string()
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
});

export const workflowIdSchema = uuid;

export type WorkflowTriggerInput = z.output<typeof workflowTriggerInputSchema>;
export type WorkflowButtonInput = z.output<typeof workflowButtonInputSchema>;
export type WorkflowReplyInput = z.output<typeof workflowReplyInputSchema>;
export type CreateWorkflowInput = z.output<typeof createWorkflowSchema>;
export type ReplaceWorkflowInput = z.output<typeof replaceWorkflowSchema>;
export type PatchWorkflowInput = z.output<typeof patchWorkflowSchema>;
export type ReorderWorkflowsInput = z.output<typeof reorderWorkflowsSchema>;
export type ListWorkflowsQuery = z.output<typeof listWorkflowsQuerySchema>;
