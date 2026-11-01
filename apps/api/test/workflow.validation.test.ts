import { describe, expect, it } from 'vitest';
import {
  WORKFLOW_LIMITS,
  createWorkflowSchema,
  decodeReplyCallbackData,
  encodeReplyCallbackData,
  listWorkflowsQuerySchema,
  patchWorkflowSchema,
  reorderWorkflowsSchema,
  replaceWorkflowSchema,
} from '@chatmaster/shared';

const CONN = '22222222-2222-4222-8222-222222222222';
const ID_A = '33333333-3333-4333-8333-333333333333';

function valid(overrides: Record<string, unknown> = {}) {
  return {
    platformConnectionId: CONN,
    name: 'Welcome',
    triggers: [{ type: 'START' }],
    replies: [
      {
        key: 'main',
        text: 'Hi!',
        buttons: [
          { row: 0, column: 0, type: 'URL', label: 'Site', url: 'https://example.com' },
          { row: 0, column: 1, type: 'CALLBACK', label: 'Pricing', nextReplyKey: 'pricing' },
        ],
      },
      { key: 'pricing', text: 'Prices...' },
    ],
    ...overrides,
  };
}

describe('createWorkflowSchema', () => {
  it('accepts a valid definition and applies defaults', () => {
    const parsed = createWorkflowSchema.parse(valid());
    expect(parsed).toMatchObject({ enabled: true, priority: 100, cooldownSeconds: 0 });
    expect(parsed.replies[0]?.parseMode).toBe('NONE');
    expect(parsed.replies[1]?.buttons).toEqual([]);
  });

  it('rejects unknown fields at every level', () => {
    expect(createWorkflowSchema.safeParse(valid({ tenantId: CONN })).success).toBe(false);
    expect(
      createWorkflowSchema.safeParse(valid({ triggers: [{ type: 'START', value: 'x' }] })).success,
    ).toBe(false);
    expect(
      createWorkflowSchema.safeParse(
        valid({ replies: [{ key: 'a', text: 'x', mediaObjectKey: 'evil' }] }),
      ).success,
    ).toBe(false);
  });

  it('requires a value for EXACT/CONTAINS/COMMAND and trims it', () => {
    expect(createWorkflowSchema.safeParse(valid({ triggers: [{ type: 'EXACT' }] })).success).toBe(
      false,
    );
    expect(
      createWorkflowSchema.safeParse(valid({ triggers: [{ type: 'CONTAINS', value: '   ' }] }))
        .success,
    ).toBe(false);
    const parsed = createWorkflowSchema.parse(
      valid({ triggers: [{ type: 'EXACT', value: '  hi  ' }] }),
    );
    expect(parsed.triggers[0]).toEqual({ type: 'EXACT', value: 'hi', caseInsensitive: true });
  });

  it('keeps explicit case sensitivity', () => {
    const parsed = createWorkflowSchema.parse(
      valid({ triggers: [{ type: 'CONTAINS', value: 'Refund', caseInsensitive: false }] }),
    );
    expect(parsed.triggers[0]).toMatchObject({ caseInsensitive: false });
  });

  it('normalises COMMAND values and rejects invalid command names', () => {
    const parsed = createWorkflowSchema.parse(
      valid({ triggers: [{ type: 'COMMAND', value: '/help' }] }),
    );
    expect(parsed.triggers[0]).toMatchObject({ value: 'help' });
    for (const value of ['he lp', 'hélp', '/', 'a'.repeat(33), '/help@bot']) {
      expect(
        createWorkflowSchema.safeParse(valid({ triggers: [{ type: 'COMMAND', value }] })).success,
      ).toBe(false);
    }
  });

  it('enforces trigger and reply counts', () => {
    expect(createWorkflowSchema.safeParse(valid({ triggers: [] })).success).toBe(false);
    expect(createWorkflowSchema.safeParse(valid({ replies: [] })).success).toBe(false);
    const tooMany = Array.from({ length: WORKFLOW_LIMITS.triggersMax + 1 }, () => ({
      type: 'ANY',
    }));
    expect(createWorkflowSchema.safeParse(valid({ triggers: tooMany })).success).toBe(false);
  });

  it('bounds priority and cooldown to integers in range', () => {
    for (const priority of [-1, 1.5, WORKFLOW_LIMITS.priorityMax + 1, '10']) {
      expect(createWorkflowSchema.safeParse(valid({ priority })).success).toBe(false);
    }
    for (const cooldownSeconds of [-1, 0.5, WORKFLOW_LIMITS.cooldownMaxSeconds + 1]) {
      expect(createWorkflowSchema.safeParse(valid({ cooldownSeconds })).success).toBe(false);
    }
  });

  it('rejects blank reply text and text over Telegram limit', () => {
    expect(
      createWorkflowSchema.safeParse(valid({ replies: [{ key: 'a', text: '  ' }] })).success,
    ).toBe(false);
    expect(
      createWorkflowSchema.safeParse(valid({ replies: [{ key: 'a', text: 'x'.repeat(4097) }] }))
        .success,
    ).toBe(false);
  });

  it('only allows http, https and tg button URLs', () => {
    for (const url of [
      'javascript:alert(1)',
      'ftp://x.y',
      'data:text/html,hi',
      'not a url',
      'https://',
    ]) {
      const replies = [
        { key: 'a', text: 'x', buttons: [{ row: 0, column: 0, type: 'URL', label: 'L', url }] },
      ];
      expect(createWorkflowSchema.safeParse(valid({ replies })).success).toBe(false);
    }
    const replies = [
      {
        key: 'a',
        text: 'x',
        buttons: [{ row: 0, column: 0, type: 'URL', label: 'L', url: 'tg://resolve?domain=x' }],
      },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies })).success).toBe(true);
  });

  it('rejects URL buttons carrying a callback target and vice versa', () => {
    const mixed = [
      {
        key: 'a',
        text: 'x',
        buttons: [
          { row: 0, column: 0, type: 'URL', label: 'L', url: 'https://a.b', nextReplyKey: 'a' },
        ],
      },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies: mixed })).success).toBe(false);
  });

  it('rejects callback buttons pointing at an unknown reply key', () => {
    const replies = [
      {
        key: 'a',
        text: 'x',
        buttons: [{ row: 0, column: 0, type: 'CALLBACK', label: 'Go', nextReplyKey: 'nope' }],
      },
    ];
    const result = createWorkflowSchema.safeParse(valid({ replies }));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['replies', 0, 'buttons', 0, 'nextReplyKey']);
  });

  it('rejects duplicate reply keys, duplicate reply ids and overlapping button cells', () => {
    const dupKeys = [
      { key: 'a', text: 'x' },
      { key: 'a', text: 'y' },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies: dupKeys })).success).toBe(false);

    const dupIds = [
      { key: 'a', id: ID_A, text: 'x' },
      { key: 'b', id: ID_A.toUpperCase(), text: 'y' },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies: dupIds })).success).toBe(false);

    const overlap = [
      {
        key: 'a',
        text: 'x',
        buttons: [
          { row: 0, column: 0, type: 'URL', label: '1', url: 'https://a.b' },
          { row: 0, column: 0, type: 'URL', label: '2', url: 'https://c.d' },
        ],
      },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies: overlap })).success).toBe(false);
  });

  it('bounds the button grid to Telegram limits', () => {
    const outOfGrid = [
      {
        key: 'a',
        text: 'x',
        buttons: [{ row: 8, column: 0, type: 'URL', label: 'L', url: 'https://a.b' }],
      },
    ];
    expect(createWorkflowSchema.safeParse(valid({ replies: outOfGrid })).success).toBe(false);
  });

  it('requires a UUID connection id', () => {
    expect(createWorkflowSchema.safeParse(valid({ platformConnectionId: 'abc' })).success).toBe(
      false,
    );
  });
});

describe('replaceWorkflowSchema', () => {
  it('does not allow moving a workflow to another connection', () => {
    const definition: Record<string, unknown> = valid();
    delete definition['platformConnectionId'];
    expect(replaceWorkflowSchema.safeParse(definition).success).toBe(true);
    expect(replaceWorkflowSchema.safeParse(valid()).success).toBe(false);
  });
});

describe('patchWorkflowSchema', () => {
  it('accepts enable/disable alone', () => {
    expect(patchWorkflowSchema.parse({ enabled: false })).toEqual({ enabled: false });
  });

  it('rejects empty and unknown updates', () => {
    expect(patchWorkflowSchema.safeParse({}).success).toBe(false);
    expect(patchWorkflowSchema.safeParse({ triggers: [] }).success).toBe(false);
    expect(patchWorkflowSchema.safeParse({ enabled: 'false' }).success).toBe(false);
  });
});

describe('reorderWorkflowsSchema', () => {
  it('rejects duplicate ids (case-insensitive)', () => {
    expect(
      reorderWorkflowsSchema.safeParse({
        platformConnectionId: CONN,
        workflowIds: [ID_A, ID_A.toUpperCase()],
      }).success,
    ).toBe(false);
  });

  it('rejects empty and oversized lists', () => {
    expect(
      reorderWorkflowsSchema.safeParse({ platformConnectionId: CONN, workflowIds: [] }).success,
    ).toBe(false);
  });
});

describe('listWorkflowsQuerySchema', () => {
  it('coerces limit and enabled from query strings with defaults', () => {
    expect(listWorkflowsQuerySchema.parse({})).toEqual({ limit: 20 });
    expect(listWorkflowsQuerySchema.parse({ limit: '5', enabled: 'false' })).toEqual({
      limit: 5,
      enabled: false,
    });
  });

  it('rejects out-of-range limits, arrays, bad cursors and unknown params', () => {
    expect(listWorkflowsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listWorkflowsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listWorkflowsQuerySchema.safeParse({ enabled: ['true', 'false'] }).success).toBe(false);
    expect(listWorkflowsQuerySchema.safeParse({ cursor: 'a b' }).success).toBe(false);
    expect(listWorkflowsQuerySchema.safeParse({ tenantId: CONN }).success).toBe(false);
  });
});

describe('callback data codec', () => {
  it('round-trips reply ids within the 64-byte limit', () => {
    const encoded = encodeReplyCallbackData(ID_A);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(64);
    expect(decodeReplyCallbackData(encoded)).toBe(ID_A);
  });

  it('refuses to encode non-UUIDs', () => {
    expect(() => encodeReplyCallbackData('label')).toThrow(TypeError);
  });
});
